"""Stamp the web app's own file references with a version before publishing.

    python3 tools/version_assets.py app/static <version>

GitHub Pages lets browsers cache each file for 10 minutes, so right after a
deploy a browser can combine a new app.js with an old backends.js and fail
("does not provide an export named ..."). Giving every reference a ?v= that
changes with each deploy makes a browser fetch a matching set:

    index.html   href="app.css"  src="js/app.js"
    js/*.js      import ... from "./sibling.js"

The source files stay unversioned (the local app sends no-store anyway);
the publish workflow runs this on its copy. Exits non-zero if any
relative import was left without a version.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

IMPORT = re.compile(r'(\bfrom\s+"\./[\w-]+\.js)"')
LEFTOVER = re.compile(r'\bfrom\s+"\./[\w-]+\.js"|\bimport\s*\(\s*"\./')


def stamp(static: Path, version: str) -> list:
    if not re.fullmatch(r"[\w.-]{1,40}", version):
        raise ValueError(f"bad version {version!r}")
    changed = []
    index = static / "index.html"
    html = index.read_text()
    new = html.replace('href="app.css"', f'href="app.css?v={version}"') \
              .replace('src="js/app.js"', f'src="js/app.js?v={version}"')
    if new != html:
        index.write_text(new)
        changed.append(index.name)
    for js in sorted((static / "js").glob("*.js")):
        text = js.read_text()
        new = IMPORT.sub(rf'\1?v={version}"', text)
        if LEFTOVER.search(new):
            raise SystemExit(f"{js.name}: a relative import wasn't versioned; extend tools/version_assets.py")
        if new != text:
            js.write_text(new)
            changed.append(f"js/{js.name}")
    if f'js/app.js?v={version}"' not in index.read_text():
        raise SystemExit("index.html no longer loads js/app.js the expected way")
    return changed


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    for name in stamp(Path(sys.argv[1]), sys.argv[2]):
        print("versioned", name)
