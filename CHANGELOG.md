# Changelog — Bot Crossing Colony

## 2026-09-06 — Remote-reader pattern (phase 1): presence fields + panel states

- `9fec9d3` — remotereader: optional `host` / `lastSeenAt` / `remote` on remote
  adapter threads. New shared stat-gate helper `server/harnesses/remote-stat.mjs`
  (kept OUT of `index.mjs` so upstream PR #7 stays mergeable); wired into the
  opencode, cursor and antigravity adapters. `lastSeenAt` is the colony-host
  clock stamped at the last successful remote stat — never a remote machine's
  wall clock. Local Hermes threads emit none of the fields (byte-identical).
- `23a563f` — remotereader-ui: live / asleep / unreachable panel states from
  the new pure module `src/ui/remote-presence.js` (<10m live, 10m–2h asleep,
  >2h or missing stamp unreachable). Unreachable remote rows grey out with a
  small "last seen HH:MM" chip; local threads render exactly as before. Row
  repaint signatures include presence so chips refresh on poll; sidebar
  projection carries the new fields.
- Research pre-work (t_5feed199) green-lit the touch points, locked the
  colony-clock lastSeen semantics and the 10m/2h bands (drift-safe: ms-scale
  skew vs minute-scale thresholds, future stamps clamp to live), and moved the
  helper to a new file after flagging the PR #7 hunk collision in `index.mjs`.
- Verified: unit fixtures 8/8 on the band logic (incl. future-stamp clamp,
  missing stamp → unreachable, local → null), production build green, colony
  restarted on the UI commit — 15 remote threads carry the fields, 181 local
  untouched, zero id collisions.
- IDs stay opaque — the planned `host:harness` prefix was dropped pre-build
  (zero collisions by construction; nothing parses ids).

## 2026-09-05 — Cursor adapter live, ghost prunes, four harnesses serving

- `3144b62` — Cursor harness adapter (snapshot-primary transcript union +
  search index, one SSH pass; read-only, no deep link).
- `3763f14` — Cursor: prune deleted-session ghosts + content-dedupe
  (16 union rows → 3 real chats).
