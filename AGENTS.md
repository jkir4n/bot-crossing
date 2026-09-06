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

- OpenCode store: `~/.local/share/opencode/opencode.db` (SQLite) —
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
4. **Windows firewall:** none needed — OpenCode serve stays on loopback; the
   colony reads it via the SSH tunnel (verified 06 Sep 2026, see Phase 1).
5. Reuse skills/scripts; verify with real checks; clean temp artifacts.

## TODO

### Phase 0 — scaffolding
- [x] Fork `jarrenrocks/bot-crossing` on GitHub (done 04 Sep 2026); clone home:
      Windows project folder.
- [ ] Baseline runs unmodified where possible; record Desktop serve port.

### Phase 1 — colony live (view-only union)
- [x] Linux `launch()` patch (`xdg-open`, platform switch) — done, upstream PR #2 open.
- [x] Hermes adapter (session mapping) — live, 168 threads (cron skipped), read-only + archive flag.
- [x] Hermes roster: one astronaut per bot (pilot-grouped, `a020e49`) — standing model. Future:
      walking-between-projects variant only (other harnesses stay per-session by decision).
- [x] Deploy prod build on Linux host — systemd `bot-crossing.service`, verified `:5274`.
- [x] OpenCode adapter (snapshot-primary copy-then-query of the session store, db+wal verified pair;
      serve API as live overlay; keeper-held tunnel) — live.
- [x] Antigravity adapter (snapshot-primary store pull; prunes summary-index-only ghosts + annotation
      orphans) — live.
- [x] Cursor adapter (transcript + search-index union over one snapshot pull; prunes index stubs,
      contentless stubs, cross-slug copies, stale transcript-only rows; 16 union rows → 3 real) — live.
- [ ] Codex adapter — skip building our own; both upstream PRs (#5 aschenoni, #12 DiamondGeezer)
      are open. Wait for the author to merge one, then sync it into the fork (daily 10am watcher
      notifies). Only build our own if both sit unmerged for weeks and we need it.
- [x] Remote-reader phase 1 (06 Sep 2026): optional host/lastSeenAt/remote on
      remote threads (`remote-stat.mjs` helper, PR #7-safe) + panel
      live/asleep/unreachable states + last-seen chip (`9fec9d3`, `23a563f`).
      IDs stay opaque — `host:harness` prefix dropped by design decision.
      Remaining: none for phase 1; revisit live-overlay when OpenCode Desktop
      serve port is mapped.
- [x] Deploy prod build on Linux host; verify from phone + PC browsers — done
      06 Sep 2026 (remote-reader phase 1 build; user confirmed WinPC rows
      dimmed asleep, local Hermes rows unchanged).
- [x] Windows Firewall inbound rule for serve/shim ports — verified **not required**
      (06 Sep 2026): OpenCode serve binds to loopback only, and the colony reads it
      through the SSH tunnel (port 22, already allowed). No LAN port exposure.
      Revisit only if serve is ever deliberately bound to the LAN interface.

### Phase 2 — signature + actions
- [x] Solar tile (06 Sep 2026): HA REST poller (`server/ha-solar.mjs`, operator
      env config only — no compiled-in entity IDs, `40cba11`+`53e141a`) →
      `/api/solar`; UI (`0cd1192`, src/game/solar.js + hud/colony wiring): HA
      time-source mode in Lighting settings (damped follow, 60s peek on
      drag/L, manual controls greyed not hidden), panel glint, solar/battery/
      grid 3-state lighting, one-line readout, nulls render neutral.
      79/79 fixture checks (tools/solar-fixtures.mjs). Verified live: solar W,
      battery SoC/power (NEGATIVE=discharge), cutoff/cutIn from HA entities.
- [ ] Remote-open listener on WinPC (authenticated, LAN).
- [ ] Hermes roster: walking-between-projects variant (design first; renderer `src/` changes —
      fork-only). Other harnesses stay per-session by user decision — no folding.

### Upstream PRs (courtesy, never gating)
- [x] Linux `launch()` → upstream (PR #2 merged 05 Sep 2026). [ ] OpenCode adapter → upstream.
- [x] Hermes adapter → upstream (PR #7 open, 04 Sep 2026).
- [ ] Codex adapter → upstream. (Keep remote-colony + solar in fork only.)

## Harnesses / agents in scope (refer to these)

| Harness | Runs on | Integration | Ref |
|---|---|---|---|
| OpenCode Desktop | WinPC | Native `opencode serve` OpenAPI over LAN | https://opencode.ai/docs/server/ |
| Codex CLI | WinPC | File parse (`~/.codex/sessions/`) + pull shim | repo `server/harnesses/README.md` §starting-points |
| Hermes Agent | Linux host | Local adapter, session mapping | `hermes-agent` skill / dashboard |
| Antigravity | second machine | Snapshot-primary store pull + ghost pruning | repo `server/harnesses/README.md` |
| Cursor | second machine | Transcripts + search index via snapshot pull | repo `server/harnesses/README.md` §Cursor |
| Upstream project | — | `jarrenrocks/bot-crossing` (MIT, as-is) | https://github.com/jarrenrocks/bot-crossing |

Future build sessions for this project may run from **any** harness (Hermes,
OpenCode, Codex) — this file is the shared contract; keep it current.
