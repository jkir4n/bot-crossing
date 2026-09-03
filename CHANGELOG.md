# Changelog — Bot Crossing Colony

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
