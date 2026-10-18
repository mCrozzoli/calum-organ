"""Light and dark themes must define the same colour tokens, and everything
the stylesheet and the grid canvas use must be defined."""
from __future__ import annotations

import re
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "app" / "static"
CSS = (STATIC / "app.css").read_text()
APP_JS = (STATIC / "js" / "app.js").read_text()


def block(selector: str) -> str:
    start = CSS.index(selector + " {")
    return CSS[start:CSS.index("}", start)]


def defined(selector: str) -> set:
    return set(re.findall(r"(--[\w-]+)\s*:", block(selector)))


DARK = defined(":root")
LIGHT = defined(':root[data-theme="light"]')


def test_both_themes_define_the_same_tokens():
    assert DARK - LIGHT == set(), "missing from the light theme"
    assert LIGHT - DARK == set(), "missing from the dark theme"


# Layout variables set on one element (not colours), e.g. the stage's
# listener position; app.js updates them.
LOCAL = set(re.findall(r"(--[\w-]+)\s*:", CSS)) - DARK


def test_every_used_token_is_defined():
    used = set(re.findall(r"var\((--[\w-]+)", CSS))
    used |= set(re.findall(r'v\("(--[\w-]+)"\)', APP_JS))      # canvas palette
    assert used - DARK - LOCAL == set()
    assert LOCAL <= {"--lx", "--ly", "--ring"}, "new local variable: colours belong in the theme blocks"


def test_no_hard_coded_colours_outside_the_theme_blocks():
    rest = CSS.split(':root[data-theme="light"]', 1)[1].split("}", 1)[1]
    assert re.findall(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", rest) == []
    assert re.findall(r'"#[0-9a-fA-F]{3,8}"|rgba?\(', APP_JS) == []
