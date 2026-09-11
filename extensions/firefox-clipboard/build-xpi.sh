#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=${1:-"$HERE/newhome-clipboard-firefox.xpi"}
cd "$HERE"
rm -f "$OUT"
python3 - "$OUT" <<'PY'
from pathlib import Path
import sys, zipfile
root = Path.cwd()
out = Path(sys.argv[1]).resolve()
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for name in ("manifest.json", "content.js", "README.md"):
        z.write(root / name, name)
print(out)
PY
