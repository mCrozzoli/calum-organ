# Third-party code

## SuperSonic 0.71.0: SuperCollider's scsynth in the browser

By Sam Aaron, <https://github.com/samaaron/supersonic>. Plays the pipe
SynthDefs (`sound/organ_synthdefs.scd`) for the demo organ and the preview.

| folder | npm package | licence | tarball integrity |
|---|---|---|---|
| `supersonic/` | `supersonic-scsynth@0.71.0` (`dist/`) | MIT | `sha512-g84Qjuu2J2dSVsT1fYEflCCe1c9qZS4KUFvXg25c2PGubDvXsfdOrgkT9ERAqSy/CHKWpLOj+3cig8mmxzQmrA==` |
| `supersonic-core/` | `supersonic-scsynth-core@0.71.0` | GPL-3.0-or-later (scsynth) | `sha512-fYD/dHy9URNOeh04JIP9PsybETMWu8P0r2hEbi/lsFzdRY0TI9/kImQZQcrqY9RGqG920SSEy4/90iTQB4Mf4A==` |

Copied unmodified from the npm tarballs (integrity checked against the
registry). Same version and files as the Dark Sonification web designs.

**Pinned on purpose:** from 0.80.0 SuperSonic is AGPL-3.0. Review the
licence before upgrading.

## qrcode-generator 2.0.4: the QR code in the Share dialog

By Kazuhiko Arase, <https://github.com/kazuhikoarase/qrcode-generator>, MIT
(licence in the file header). `qrcode-generator/qrcode.mjs` is `dist/qrcode.mjs`
from the npm tarball, unmodified; tarball integrity `sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`.
Bundled (not loaded from a CDN) so sharing works on a venue network with no
internet.

## PeerJS 1.5.5: playing together on the web

<https://peerjs.com>, MIT (`peerjs/LICENSE`). `peerjs/peerjs.min.js` is
`dist/peerjs.min.js` from the npm tarball, unmodified; tarball integrity
`sha512-viMUCPDL6CSfOu0ZqVcFqbWRXNHIbv2lPqNbrBIjbFYrflebOjItJ4hPfhjnuUCstqciHVu9vVJ7jFqqKi/EuQ==`.
Browsers find each other through the free public PeerJS server
(0.peerjs.com); after that, the session's data goes directly between them
(WebRTC).
