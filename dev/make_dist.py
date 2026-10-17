#!/usr/bin/env python3
"""배포용 폴더(dist) 만들기 — 실행에 필요한 파일만 모은다.

    python dev/make_dist.py

결과: chess-game/dist/
    · 이 폴더를 통째로 올리면 끝 (빌드 도구 없음 · 정적 파일)
    · Cloudflare Pages / Netlify : 폴더를 드래그&드롭
    · GitHub Pages               : dist 안의 파일을 저장소 루트에 두고 push

검사도 함께 한다
    · 서비스 워커(sw.js)의 캐시 목록(SHELL)에 적힌 파일이 실제로 다 있는지
    · HTML/CSS/JS 안에 절대 경로(/...)가 섞여 있지 않은지 (하위 폴더 배포 대비)
"""
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent                     # chess-game/
DIST = APP / "dist"

# 실행에 필요한 것만 (dev/ · serve.py · README · 기획서는 제외)
FILES = [
    "index.html",
    "style.css",
    "pieces.js",
    "app.js",
    "manifest.webmanifest",
    "sw.js",
]
DIRS = ["icons", "engine"]


def collect():
    out = []
    for f in FILES:
        p = APP / f
        if not p.exists():
            print(f"  ! 없는 파일: {f}")
            continue
        out.append(p)
    for d in DIRS:
        for p in sorted((APP / d).glob("*")):
            if p.is_file():
                out.append(p)
    return out


def check_no_absolute_paths(dist):
    """하위 폴더(/저장소/)에 배포해도 되도록 절대 경로가 없어야 한다."""
    bad = []
    for p in dist.rglob("*"):
        if p.suffix not in (".html", ".css", ".js", ".webmanifest"):
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r'''(?:src|href)\s*=\s*["'](/[^/"'])''', text):
            bad.append(f"{p.name}: {m.group(0)}")
        for m in re.finditer(r'''["'](/engine/|/icons/|/app\.js|/style\.css)''', text):
            bad.append(f"{p.name}: {m.group(0)}")
    return bad


def check_shell(dist):
    """sw.js 의 SHELL 목록과 실제 파일이 일치하는지."""
    sw = (dist / "sw.js").read_text(encoding="utf-8")
    m = re.search(r"const SHELL = \[(.*?)\];", sw, re.S)
    if not m:
        return ["sw.js 에서 SHELL 을 찾지 못했습니다"], []
    entries = re.findall(r"'([^']+)'", m.group(1))
    missing = []
    for e in entries:
        if e == "./":
            continue
        rel = e[2:] if e.startswith("./") else e.lstrip("/")
        if not (dist / rel).exists():
            missing.append(e)
    return missing, entries


def main():
    if not (APP / "index.html").exists():
        print(f"앱 폴더를 찾지 못했습니다: {APP}")
        return 1

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    files = collect()
    for p in files:
        rel = p.relative_to(APP)
        dst = DIST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
    (DIST / ".nojekyll").write_text("", encoding="utf-8")   # GitHub Pages: Jekyll 처리 건너뛰기

    total = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"배포 폴더: dist/  ({len(files) + 1}개 파일 · {total/1024:.0f}KB)")
    for p in sorted(DIST.rglob("*")):
        if p.is_file():
            print(f"  {str(p.relative_to(DIST)).replace(chr(92), '/'):28} "
                  f"{p.stat().st_size/1024:7.1f}KB")

    ok = True
    missing, entries = check_shell(DIST)
    if missing:
        print(f"  ! sw.js 캐시 목록에 있는데 없는 파일: {', '.join(missing)}")
        ok = False
    else:
        print(f"  OK  sw.js 캐시 목록 {len(entries)}개 모두 존재")
    bad = check_no_absolute_paths(DIST)
    if bad:
        print("  ! 절대 경로 발견(하위 폴더 배포 시 깨짐):")
        for b in bad:
            print(f"      {b}")
        ok = False
    else:
        print("  OK  절대 경로 없음 (하위 폴더 배포 가능)")
    print("\n다음: python dev/verify_deploy.py  로 이 폴더가 제대로 도는지 확인")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
