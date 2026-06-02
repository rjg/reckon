# Reckon

A mental-math speed drill, built as an installable PWA for the iPhone home screen.

- Configurable operand ranges per operation (+ − × ÷) and timer length, with presets
- Keystroke auto-advance — no submit button
- Every problem logged to IndexedDB; per-operation diagnostics after each game
- Statistics across all sessions, personal bests, and one-row-per-problem CSV export
- Complete JSON backup/restore (games + stats + XP/streak) and CSV import
- Offline-capable via a service worker

## Develop

```
npm run dev          # live-reload dev server on http://localhost:8000
npm run dev:lan      # also expose on your LAN to test on a phone
npm test             # run the unit tests (node:test, no deps)
```

`dev.js` is a zero-dependency live-reload server: edit a file and the browser
refreshes itself — no commit, no deploy. It's a **dev tool, not shipped**.

It serves your working tree, so it's hardened: localhost-only by default (no
network exposure), GET/HEAD only, path-traversal safe, never serves dotfiles or
`.git`, no directory listings, and a Host-header allowlist (blocks DNS-rebinding).
`--lan` opt-in binds `0.0.0.0` for phone testing and prints a warning — only use
it on a network you trust. The security-critical path/host checks are unit-tested
(`tests/dev-server.test.js`). A plain `python3 -m http.server 8000` also works if
you don't want live reload.

## Deploy

Plain static files — GitHub Pages serves them as-is from the repo root.
All paths are relative, so it works fine from a project subpath.

## Files

- `index.html` — the whole app (vanilla JS, inline CSS)
- `app-logic.js` — pure logic, unit-tested (shared with the browser as the `Z` global)
- `sw.js` — offline service worker
- `manifest.webmanifest` — PWA manifest
- `icons/` — app icons (regenerate with `python3 gen_icons.py`)
- `dev.js` — local live-reload dev server (not shipped)
