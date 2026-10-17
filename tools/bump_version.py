"""Stamp a cache-busting ?v=<version> onto every local CSS/JS reference in docs/.

GitHub Pages serves files with max-age=600, and ES modules imported by other
modules are not always refetched by a reload. Changing the query string makes
browsers treat each release as new files. Run before committing front-end
changes:

    python tools/bump_version.py
"""

import re
import sys
from datetime import datetime
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"

HTML_REF = re.compile(r'((?:href|src)=")([^"?:]+\.(?:css|js))(?:\?v=[^"]*)?(")')
JS_IMPORT = re.compile(r"""(from\s+'|import\s*\(\s*')(\./[^'?]+\.js)(?:\?v=[^']*)?(')""")


def stamp(path: Path, pattern: re.Pattern, version: str) -> int:
    text = path.read_text(encoding="utf-8")
    new, n = pattern.subn(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}", text)
    if new != text:
        path.write_text(new, encoding="utf-8", newline="\n")
    return n


def main() -> int:
    version = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime("%Y%m%d%H%M")
    total = 0
    for html in DOCS.glob("*.html"):
        total += stamp(html, HTML_REF, version)
    for js in (DOCS / "js").glob("*.js"):
        total += stamp(js, JS_IMPORT, version)
    print(f"version {version}: {total} references stamped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
