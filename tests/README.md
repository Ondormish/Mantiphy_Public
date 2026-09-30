# Tests

| Suite | What it covers | Run |
|---|---|---|
| `backend/test_*.py` | catalog, import/remove, stacking, lens profiles, sky/subject masks, denoise, 16-bit TIFF writer, XMP, the local-only guard… (plain asserts, no pytest; one-time `.venv/bin/pip install -r requirements-dev.txt`) | `for t in backend/test_*.py; do .venv/bin/python -m backend.$(basename $t .py); done` |
| `tests/unit/` | the edit recipe and presets (`frontend/edits.js`, `frontend/presets-data.js`) under plain Node, no dependencies | `node --test "tests/unit/*.test.mjs"` |
| `tests/ui/` | the real app in headless Chromium against a throwaway backend: develop render, gradient handles, mask overlay, preset hover/replace/remove, photo menu, markup in file names/EXIF shown as text, stacking, remove/restore, JPEG + 16-bit export | one-time `cd tests/ui && npm install && npx playwright install chromium`, then `tests/ui/run.sh` |

`tests/ui/run.sh` builds its own photos (`fixtures.py`), starts `backend/server.py`
on port 7899 with a temporary catalog, cache and trash, and deletes it all
afterwards — your library is never touched. A failing scenario leaves a
screenshot in the temp dir and prints the server log. WebGL runs on
SwiftShader, so no GPU is needed.
