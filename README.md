# Bot Crossing Colony

Personal fork project of [jarrenrocks/bot-crossing](https://github.com/jarrenrocks/bot-crossing)
("a video game for AI agents") — adapted to Kiran's setup: multi-harness,
multi-machine agent colony on the home LAN.

## Idea in one line

Every agent thread on every machine is an astronaut. One hex zone per repo in
`<projects-folder>\`. Hermes + OpenCode + Codex + Antigravity show up as one union
colony, served from the always-on Hermes host, viewable from any browser.

## Architecture (decided 04 Sep 2026)

- **Colony server on Hermes host** (Linux, production `npm start` build — fits in
  ~150–300 MB; dev server not for 24/7, box is swap-tight).
- **OpenCode Desktop (WinPC)** → native API (`opencode serve` OpenAPI, ~40 session
  endpoints) polled over LAN `http://winpc-lan:<port>`. No exporter needed.
  Desktop binds localhost-only → reach via bind setting, firewall rule, or
  `ssh -L` over LAN. Tailscale is fallback only, nothing depends on it.
- **Codex CLI (WinPC)** → file-based, no listener (verified live `codex.exe` with
  zero sockets). Adapter parses `~/.codex/sessions/…/rollout-*.jsonl` via a thin
  read-only pull shim (`GET /threads`) on WinPC.
- **Hermes (Hermes host)** → local adapter reading `~/.hermes/` session store.
- **Antigravity** → session paths undiscovered; needs `find ~ -newermt` mapping on
  a machine with it installed. Last in line.
- **Remote-open (Phase 2):** tiny authenticated listener on WinPC; Phase 1 greys
  out open for remote threads (interface supports it natively).
- **IDs are host-prefixed** (`ap201:opencode:<id>`) so machines never merge threads.
- **Offline PC reads as stale** (last-seen age), never as error.

## Signature feature (Phase 2): solar tile

A solar farm at the colony's edge driven by minimal live HA data (solar W,
battery %, grid flow, ~60s poll, isolated poller). Drives the existing day/night
engine: sun elevation sets time-of-day, solar watts scale panel glow, battery
carries night lighting. Ambient-only; a failed poll degrades to a neutral tile.

## Upstream relationship

Fork-first (our direction diverges: Linux + Windows + multi-machine). PR back only
the clean separable slices (Linux `launch()`, OpenCode adapter, Codex adapter).
Author publishes as-is, PRs may go unanswered — never gate progress on review.

## Status

Docs + plan only (04 Sep 2026). No fork, no code yet. See `AGENTS.md` for the
build contract and phased TODO.
