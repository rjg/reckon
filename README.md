# Reckon

A mental-math speed drill, built as an installable PWA for the iPhone home screen.

- Configurable operand ranges per operation (+ − × ÷) and timer length, with presets
- Keystroke auto-advance — no submit button
- Every problem logged to IndexedDB; per-operation diagnostics after each game
- Statistics across all sessions, personal bests, and one-row-per-problem CSV export
- Offline-capable via a service worker

## Run locally

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy

Plain static files — GitHub Pages serves them as-is from the repo root.
All paths are relative, so it works fine from a project subpath.

## Files

- `index.html` — the whole app (vanilla JS, inline CSS)
- `sw.js` — offline service worker
- `manifest.webmanifest` — PWA manifest
- `icons/` — app icons (regenerate with `python3 gen_icons.py`)
