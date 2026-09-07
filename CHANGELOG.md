# Changelog — Bot Crossing Colony

## 2026-09-07 — Power zone: the colony's dedicated power tile (HA-truth visuals)

The "solar tile" became a real place: a fenced power plot on a reserved colony cell, built
entirely from existing spacebase.glb pack nodes (zero new geometry), rendering the house
1:1 — the colony computes nothing; every state shown is what Home Assistant reported.

- Backend (`68e9bce`): grid-source wire — operator configures the grid/mains entity
  (env-only); explicit state mapping (on→grid / off→battery), never inferred.
  `solar.history[]` = verbatim HA-recorder passthrough (no colony storage/math).
- Zone (`925bee1`→`31eb65e`): west 3x2 solar array (glint gated by production), 1x4
  double-scale battery row — SoC quartiles as lit blocks, the ACTIVE block fast-breathes on
  discharge and quick-blinks on charge (rhythm asserted in fixtures), two drill+turbine rigs
  with ship-recipe sphere beacons atop the masts (grid double-flash / battery slow pulse /
  solar steady glow / HA-silent dark), spinning rooftop fans + rig glow on grid only.
- Click panel (`546c5cd`, trimmed `6882716`): live rows (source, solar W, SoC, battery W
  direction, cutoff/cut-in) in the repo-panel sidebar slot; nulls render as dashes.
- Town lighting no longer varies with power source (battery/grid dim path removed).
- Sidebar pill removed (superseded by the zone itself).
- Guardrails: no entity IDs/names baked in code (operator drop-in only; repo ships
  `server/ha-solar.conf.example` template); fixtures extended per tweak to 278 checks.

## 2026-09-06 — Solar tile: Home Assistant drives the colony's power story

- `40cba11` — solar: HA REST poller `server/ha-solar.mjs` (separate ~60s
  poller, mtime-isolated from the thread scan; failure → neutral tile, never
  touches threads) serving `GET /api/solar`: solarPowerW, batterySoC,
  batteryPowerW (NEGATIVE = discharging), isDay from the sun entity,
  source (solar/battery/grid) and stale flag. Cutoff/cut-in pass through from
  HA number entities as display values — the colony derives nothing.
- `53e141a` — solar: universalize. First build had the operator's HA entity
  IDs compiled in as defaults (user directive: no system-specific code) —
  stripped to empty-string defaults; every connection value (URL, token,
  entity IDs, poll rate) now comes from operator env config
  (`server/ha-solar.conf.example` template). No config → clean neutral tile,
  never a crash. Kill-test verified: HA unreachable → neutral within 2
  poll rounds, thread scan untouched.
- `0cd1192` — solar-ui: HA time-source mode in the existing Lighting settings
  (damped follow of HA's day cycle, 60s peek on drag/L, manual controls
  greyed-but-visible while HA drives), panel glint on production, the
  solar/battery/grid 3-state night-lighting story (surplus → charging warm;
  conserving → dimmed; grid mode → normal glow, because the house is on
  mains), and a one-line readout with discharge/charge/grid indicators.
  New pure module `src/game/solar.js`; nulls render as dashes, never NaN.
- Worker reliability notes: the first four dispatch runs died on a provider
  outage (muse-spark 429/500 upstream, not code — partial work survived as
  uncommitted changes and run #70 continued from it on a pinned model).
- Verified: fixture matrix 79/79 (tools/solar-fixtures.mjs: band boundaries,
  glint ceiling, missing payload, null rendering), production build green,
  deployed on `:5274` with live HA values (solar W, SoC, discharge W,
  cutoff 20 / cut-in 50), zero house-specific strings in `src/`.

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
