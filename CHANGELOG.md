# Changelog — Bot Crossing Colony

## 2026-09-04 — Project setup + research (docs only, no code)

- Created `<projects-folder>\Bot Crossing Colony\` (README + AGENTS.md + CHANGELOG),
  git init, no remote (fork decision pending).
- Static review of upstream `jarrenrocks/bot-crossing` (57★, 4 commits): adapter
  contract, `claude://` deep-link mechanism, day/night engine, UI restraint rules.
- Verified live: OpenCode SQLite session schema; Desktop not running (port
  unmapped); `codex.exe` socket-less (file-based only); Hermes host resources OK
  for prod build; LAN-first networking (Tailscale fallback); WinPC SSH working.
- Decisions locked: fork-first + PR separable slices; LAN-first, no Tailscale
  dependency; host-prefixed ids; stale-not-error for offline PC; solar tile as
  Phase 2 signature (ambient-only, isolated poller).
