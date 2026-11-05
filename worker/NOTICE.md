# Voice gateway source and licenses

`drm.js` is a JavaScript port of `src/edge_tts/drm.py` from
<https://github.com/rany2/edge-tts> (upstream main, retrieved 2026-11-05).
The read-aloud wire messages, endpoint and request headers in `index.js` are
adapted from the same project's `communicate.py` and `constants.py`.

Upstream project author: rany <rany@riseup.net>, with contributors. The exact
upstream license notice is preserved verbatim in `LICENSE.edge-tts`; it assigns
LGPLv3 to the source files used here. The copyright lines “2014-2023 Christopher
Down” and “2025- rany” in that upstream notice belong to its separate MIT section
for `srt_composer.py`, which this gateway does not use. They are not a verified
first-publication date for `drm.py`.

These gateway source files and modifications are distributed under LGPLv3.
`LICENSE.edge-tts` includes the LGPLv3 additional permissions; the full GPLv3
terms that LGPLv3 incorporates are supplied separately in `LICENSE.GPL-3.0`,
copied verbatim from <https://www.gnu.org/licenses/gpl-3.0.txt> on 2026-11-05.
Both license files must accompany source or bundled-code distribution.

Modifications: JavaScript/Cloudflare Worker port; modular 32-bit
arithmetic; five-minute token cache; fixed four-voice HTTP interface; text and
origin validation; limits, cancellation and timeouts. Source remains supplied
in the public repository so it can be inspected, changed and replaced.

This uses the unofficial Edge read-aloud service, not an Azure Speech resource.
It is not affiliated with Microsoft and carries no availability guarantee.
No Microsoft account secret or novel text belongs in this source or its logs.

`worker/dist/worker.js` is generated from these source files with esbuild and
contains no external runtime imports; its embedded license comments must remain.
The corresponding, editable source and the two license files are supplied in
this public repository's `worker/` directory. A dashboard deployment should link
to that source in its accompanying documentation.
