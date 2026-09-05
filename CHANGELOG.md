# Changelog — Bot Crossing Colony

## 2026-09-05 — Cursor adapter live, ghost prunes, four harnesses serving

- `3144b62` — Cursor harness adapter (snapshot-primary transcript union +
  search index, one SSH pass; read-only, no deep link).
- `3763f14` — Cursor: prune deleted-session ghosts + content-dedupe
  (16 union rows → 3 real chats).
- `ac7c5ff` — Antigravity: prune annotation-only ghosts (orphan `.pbtxt`
  left behind on delete).
- Colony live on `:5274` (systemd user unit + per-harness snapshot drop-ins):
  183 threads — Hermes 168, OpenCode 5, Antigravity 7, Cursor 3.
- Upstream: PR #2 (Run on Linux) merged; PR #7 (Hermes adapter) open.

## 2026-09-04 (late) — OpenCode + Antigravity adapters live

- OpenCode snapshot-primary (copy-then-query, db+wal verified pair,
  torn-pull discard) with serve API as live overlay; keeper-held tunnel.
- `4798425` — Antigravity harness adapter (snapshot-primary).
- `7c8ee1f` — Antigravity prunes summary-index-only ghosts (no backing
  file = deleted).

## 2026-09-04 — Project setup + research (docs only, no code)

- Created project folder (README + AGENTS.md + CHANGELOG),
  git init, no remote (fork decision pending).
- Static review of upstream `jarrenrocks/bot-crossing` (57★, 4 commits): adapter
  contract, `claude://` deep-link mechanism, day/night engine, UI restraint rules.
- Verified live: OpenCode SQLite session schema; Desktop not running (port
  unmapped); `codex.exe` socket-less (file-based only); Linux host resources OK
  for prod build; LAN-first networking; WinPC SSH working.
- Decisions locked: fork-first + PR separable slices; LAN-first, no Tailscale
  dependency; host-prefixed ids; stale-not-error for offline PC; solar tile as
  Phase 2 signature (ambient-only, isolated poller).

## 2026-09-04 — Forked on GitHub

- Forked `jarrenrocks/bot-crossing` → `jkir4n/bot-crossing` (upstream main f3ed478,
  5 commits incl. same-name-folder disambiguation).
- Merged upstream code under docs (merge 0fe0e87): upstream README.md kept
  byte-canonical with colony notes appended as fork section, so `git fetch
  upstream` stays clean. Remotes: `origin` = fork (SSH), `upstream` = original.
- GitHub SSH working from WinPC via a registered key;
  `gh` CLI token unusable over SSH (vault locked to interactive logon) —
  run `gh` commands in the PC's own terminal.

## 2026-09-04 — Scrubbed personal info (public fork)

- Removed machine names, IPs, usernames, drive paths from README / CHANGELOG
  (AGENTS.md environment section also done; rest pending approval).
  Real connection values live in operator memory, not the repo.

## 2026-09-04 — Linux port runs (branch `linux-port`, commit 02b5ccf)

- Ported upstream `launch()` to Linux (`xdg-open`, null-safe elsewhere) with
  spawn-error guard; `os` field allows linux; `BOT_CROSSING_HOST` env for
  LAN serving (default still loopback); Host/Origin check accepts the
  machine's own LAN addresses (rebinding/CSRF model intact).
- Lockfile fix found on the way: upstream package-lock still said
  `cosmo-builder` (pre-rename); synced + os field.
- Production build + serve VERIFIED on Linux host: `/` 200, `/api/threads`
  200 (empty — no harness sessions here yet), LAN path 200.
  Colony live at `http://<linux-host-lan>:5274` (empty world until the
  Hermes adapter lands).
- Next: Hermes adapter (Phase 1), then push branch + open upstream PR.
