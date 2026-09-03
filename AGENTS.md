# AGENTS.md — Bot Crossing Colony (fork of jarrenrocks/bot-crossing)

## Environment

- **Windows PC** (always on, same LAN as the Linux host). All work repos in one
  projects folder. Shell is `cmd` (no `head`/`tail` — use `findstr`; PowerShell
  via `powershell -NoProfile -Command`). Some files may be CRLF — patch with
  CRLF-aware replacement, never fuzzy-indent. scp pulls need forward slashes.
- **Linux host** (colony server home). Node v22 present. RAM tight → production
  build only.
- **Home Assistant** — solar tile data source (REST, ~60s poll).

## Upstream facts (verified Sep 2026, static review only — never cloned)

- `jarrenrocks/bot-crossing`, MIT, 4 commits (latest 01 Sep 2026), 57★/16 forks.
  macOS-only (`spawn('open', [url])` in `server/api.mjs`), Claude-Code-only
  adapter; 9 more harnesses listed as "not yet" incl. OpenCode/Codex/Antigravity.
- Adapter contract (`server/harnesses/README.md`): **one new file + one line in
  `index.mjs`**; `detect / scanThreads / openThread / newSession / setArchived /
  appStartedAt?`. Read-only except one archive flag; never block the scan
  (mtime-cache); read heads not whole files; expect malformed data; never widen
  `id` collisions. No test suite upstream — verify per their 5-step checklist.
- Claude link uses `claude://claude.ai/epitaxy/<local_…>` (navigate),
  `claude://resume?session=` (CLI fallback, imports transcript — destructive),
  `claude://code/new?folder=` (new session). Engineered details worth keeping:
  sticky zone layout, A\* routing (0 building crossings / 288 legs measured),
  badge discipline (only needy states get symbols), sky-shader-as-HDRI day/night
  (Luna/Mars/Terra, `L` scrubs time, 0.16 ms/frame), windows light after dark.

## Verified local facts (live probes, Sep 2026)

- OpenCode store: `/home/hermes/.local/share/opencode/opencode.db` (SQLite) —
  `session(id, project_id, directory, title, model, agent, tokens_*, cost,
  time_created/updated/archived, …)`. Adapter = one SQL query. (Local copy had
  0 session rows; schema is what matters.)
- OpenCode Desktop was NOT running during probe (no process, no 4096 listener);
  its serve port is still unmapped — map via `netstat`+`tasklist` next time it
  is open, then test `GET /health`-style endpoint from the Linux host over LAN.
- `codex.exe` runs with no listening socket → file-based adapter only.
- Neither `~/.gemini` nor `~/.antigravity` exists on the Linux host.

## Build rules for this fork

1. **UI restraint (non-negotiable):** scene stays ambient, density lives in the
   panel. New visuals must pass "does this earn a badge?". Stale PC = existing
   `asleep` state. Harness identity = astronaut name tag. Host = repo panel.
2. **Solar tile isolation:** separate poller, ~60s, 2–3 HA entities; failure →
   neutral tile, never touches thread scan.
3. **Linux port:** `launch()` → `xdg-open` + platform switch; deep-link-less
   harnesses return `{ ok:false }` per interface.
4. **Windows firewall:** expect to add one inbound rule for Desktop's serve port.
5. Reuse skills/scripts; verify with real checks; clean temp artifacts.

## TODO

### Phase 0 — scaffolding
- [x] Fork `jarrenrocks/bot-crossing` on GitHub (done 04 Sep 2026); clone home:
      Windows project folder.
- [ ] Baseline runs unmodified where possible; record Desktop serve port.

### Phase 1 — colony live (view-only union)
- [ ] Linux `launch()` patch (`xdg-open`, platform switch).
- [ ] Hermes adapter (`~/.hermes/` session mapping).
- [ ] OpenCode adapter (HTTP client → Desktop/serve API over LAN; fallback:
      copy-then-query `opencode.db`, never live-query over network/WAL).
- [ ] Codex adapter (`rollout-*.jsonl` parser + thin `GET /threads` shim on WinPC).
- [ ] Remote-reader adapters + `host:harness` id prefix + stale/last-seen UI.
- [ ] Deploy prod build on Linux host; verify from phone + PC browsers.
- [ ] Windows Firewall inbound rule for serve/shim ports.

### Phase 2 — signature + actions
- [ ] Solar tile (Home Assistant REST poller → drive day/night engine + panel glow + night
      lighting; ambient-only; decide later whether <30% battery earns a badge).
- [ ] Remote-open listener on WinPC (authenticated, LAN).
- [ ] Antigravity adapter (needs session-path discovery first).

### Upstream PRs (courtesy, never gating)
- [ ] Linux `launch()` → upstream. [ ] OpenCode adapter → upstream.
- [ ] Codex adapter → upstream. (Keep remote-colony + solar in fork only.)

## Harnesses / agents in scope (refer to these)

| Harness | Runs on | Integration | Ref |
|---|---|---|---|
| OpenCode Desktop | WinPC | Native `opencode serve` OpenAPI over LAN | https://opencode.ai/docs/server/ |
| Codex CLI | WinPC | File parse (`~/.codex/sessions/`) + pull shim | repo `server/harnesses/README.md` §starting-points |
| Hermes Agent | Linux host | Local adapter, session mapping | `hermes-agent` skill / dashboard |
| Antigravity | WinPC | Undiscovered — map first | `find ~ -newermt` trick |
| Upstream project | — | `jarrenrocks/bot-crossing` (MIT, as-is) | https://github.com/jarrenrocks/bot-crossing |

Future build sessions for this project may run from **any** harness (Hermes,
OpenCode, Codex) — this file is the shared contract; keep it current.
