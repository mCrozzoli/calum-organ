"""The publish step that keeps browsers from mixing old and new files."""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_every_reference_gets_the_version(tmp_path):
    site = tmp_path / "static"
    shutil.copytree(ROOT / "app" / "static", site,
                    ignore=shutil.ignore_patterns("vendor", "corpus", "firmware", "synthdefs"))
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "version_assets.py"), str(site), "abc123"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    html = (site / "index.html").read_text()
    assert 'href="app.css?v=abc123"' in html and 'src="js/app.js?v=abc123"' in html
    for js in (site / "js").glob("*.js"):
        text = js.read_text()
        assert not re.search(r'from\s+"\./[\w-]+\.js"', text), js.name
        # every relative import in the source got the version
        assert len(re.findall(r'from\s+"\./[\w-]+\.js\?v=abc123"', text)) == \
            len(re.findall(r'from\s+"\./', (ROOT / "app" / "static" / "js" / js.name).read_text())), js.name
