# Harness adapters

A **harness** is whatever runs the agent threads you want to see as astronauts — Claude Code,
Codex CLI, OpenCode, and so on. Bot Crossing does not care which one you use: it asks every
harness present on the machine for its threads and draws whatever comes back.

Adding one is meant to be **one new file in this directory**, plus one line in `index.mjs`.
Nothing in `server/scan.mjs`, `server/api.mjs`, or anywhere under `src/` should need to change.
If you find yourself editing those to land a harness, that is a bug in this seam — please say so
in the PR, because the next person will hit it too.

## The shape of it

```js
// server/harnesses/my-harness.mjs
export default {
  id: 'my-harness',              // stable, kebab-case, used as a key — never change it later
  name: 'My Harness',            // what a human sees in the UI
  detect,                        // () => Promise<boolean>
  scanThreads,                   // () => Promise<Thread[]>
  openThread,                    // (ref) => { ok, url } | { ok: false, error }
  newSession,                    // (dir) => { ok, url } | { ok: false, error }
}
```

Then, in `index.mjs`:

```js
import myHarness from './my-harness.mjs'
export const HARNESSES = [claudeCode, myHarness]
```

### `detect()`

Is this harness on this machine at all? Usually just "does its data directory exist". Cheap —
it runs on every scan, so that installing a harness while the colony is open is noticed on the
next poll. Returning `false` means the harness is skipped entirely, and no astronaut for it
ever appears.

### `scanThreads()`

The real work: return one `Thread` per session the harness knows about.

Throwing is survivable — the scanner logs it and carries on with the other harnesses, so one
broken adapter costs you its own threads and nothing else. Prefer that over returning junk.

### `openThread(ref)` / `newSession(dir)`

Return `{ ok: true, url }` and the server hands that URL to the OS opener. `openThread` gets
the `ref` from the thread it belongs to; `newSession` gets an absolute directory that the
server has already checked still exists.

If your harness has no deep link, return `{ ok: false, error: '…' }` and say why — the UI
shows the message rather than pretending the click worked.

### There is no `setArchived`, and that is deliberate

Bot Crossing does not write to a harness. Not the transcripts, not the session records, not one
flag. Archiving is recorded in `data/colony.json` and nowhere else: the thread leaves the map and
the astronaut walks back to the ship.

It used to write one flag — `isArchived` on Claude Code's own session record — and that write
genuinely landed on disk. It just did not *mean* anything: the desktop app serves from the copy it
loaded at launch, so the thread stayed in its list until the app restarted, and the app rewrote the
record from memory the next time it touched the thread. Holding that together took a re-assert on
every scan, a `ps` sweep to guess whether the app had re-read the file, and a *pending* state for
the gap between them. All of that is gone, and the scan no longer starts a subprocess at all.

Archiving in the harness's own UI still works and is still the right way to do it — your adapter
reports it through the `archived` field and the astronaut goes home on the next poll.

## The `Thread` your adapter returns

Only `id` is truly required, but the colony gets duller the more you leave out — `project` is
what earns a repo its own zone, and `lastActivityAt` is what sorts the whole map.

| Field | Type | What it means |
| --- | --- | --- |
| `id` | string | **Unique across every harness.** A UUID is fine; otherwise prefix it, e.g. `my-harness:1234` |
| `title` | string | Thread title. `'Untitled thread'` if the harness has none |
| `preview` | string | First prompt, trimmed — shown on the thread card |
| `project` | string | Repo/folder **name**. This is what claims a hex zone |
| `projectPath` | string | Absolute path to the repo root |
| `worktree` | string | Worktree name, or `''` |
| `cwd` | string | Where the thread is actually working |
| `gitBranch` | string | Branch name, or `''` |
| `model` / `effort` | string | Shown on the thread card |
| `createdAt` | number | Epoch ms |
| `lastActivityAt` | number | Epoch ms. Sorts the colony and drives the "asleep for 3 days" behaviour |
| `lastFocusedAt` | number | Epoch ms, `0` if unknowable |
| `running` | boolean | Working **right now** — the astronaut hammers away |
| `unread` | boolean | Moved on since you last looked — the astronaut stops and holds a `?` |
| `hasError` | boolean | Errored — the astronaut slumps, red eyes |
| `starred` / `routine` / `prState` | | Optional extras; `prState: 'merged'` triggers the confetti |
| `archived` | boolean | Archived in the harness's own records. Read-only — reporting it is all an adapter does |
| `sizeBytes` | number | Transcript size. **This is how finished a building looks**, on a log scale |
| `source` | string | Free-form, for your own bookkeeping (the Claude adapter uses `desktop` / `cli`) |
| `canOpen` | boolean | Whether this thread can be opened. The UI greys the button out |
| `ref` | object | **Opaque.** Whatever *you* need to find this thread again |

### About `ref`

`ref` is the whole reason the browser does not know what a session id looks like. Your adapter
puts whatever it needs in there, the page hands it straight back on open and archive, and
nothing between the two ever inspects it.

Keep it small and keep it serialisable — it makes a round trip through JSON on every action.
Do not put a file handle, a class instance, or a secret in it.

## Ground rules

- **Read-only. No exceptions.** `data/colony.json` is the only file Bot Crossing writes,
  anywhere. A harness's transcripts and records are somebody's actual work; the colony is a
  viewer, not an editor. If an adapter seems to need a write, it does not — say so in an issue.
- **Never run anything out of another application's bundle.** Not to read from it, not to
  execute it. Only files under the user's own home directory. Opening a thread goes through a
  URL the OS resolves, or a command the user already has on `PATH`.
- **Never block the scan.** It runs on a poll. Cache anything expensive against file mtime —
  see `transcriptMeta` in `claude-code.mjs`, which is what keeps a 12MB transcript from being
  reparsed every few seconds.
- **Read heads, not whole files.** `readHead` in `../lib/fsutil.mjs` pulls the first chunk and
  drops a trailing partial line, so `JSON.parse` never sees half a record.
- **Expect malformed data.** A session being written *right now* is a normal thing to trip
  over. Skip that record and move on; do not throw the pass away.
- **Never widen `id` collisions.** The colony keys its archive list and saved layout on `id`.
  Two harnesses handing back the same id would merge two unrelated threads into one astronaut.

### Pruning ghosts

Three prune rules across two adapters have converged on the same shape of problem: the harness's index outlives the thing
it indexes, so the scan starts from the union and prunes back to what is real. The shared
rules, if your harness has an index that can go stale:

- **Prune from the union, never from one side alone.** Antigravity drops summary-index rows
  with no backing file and annotation orphans; Cursor drops index-only stubs, contentless
  stubs, same-conversation copies under different slugs (newest wins), and stale
  transcript-only rows.
- **Fail open.** When the backing store is unreadable, the prune rules that depend on it stay
  off — a missing index must never hide transcripts by itself.
- **Archive flags are not deletion signals.** They fill the thread's `archived` field and never
  the prune decision.
- **One chat, one astronaut** — ids never widen in the process.

## Starting points

Verified on a real machine:

- **Claude Code** — desktop records in
  `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`
  (`%APPDATA%\Claude\claude-code-sessions\…` on Windows); CLI transcripts in
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; live processes in
  `~/.claude/sessions/*.json`. Implemented in `claude-code.mjs`.
- **Codex CLI** — transcripts in `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`,
  with records shaped `{ timestamp, type, payload }`, and what looks like an index at
  `~/.codex/session_index.jsonl`. Implemented in `codex.mjs` (local store, `CODEX_HOME`
  override, opened through `codex://`).

For anything else, the fastest way in is usually to start a throwaway session in that harness
and watch which files change:

```bash
find ~ -maxdepth 4 -newermt '-2 minutes' -type f 2>/dev/null | grep -iv Library/Caches
```

## Hermes

I read my own session store for this one — the `sessions` table in the
agent's state DB, opened read-only, one SQL pass per scan plus a first-user
preview per session. One astronaut per bot: the default profile plus every
named profile with its own store shows up as its own pilot. Scheduled runs
are skipped (each one would stand on the map as an astronaut nobody ever
talks to). Archiving is colony-internal (`data/colony.json`) — the store is
never written; open/new-session
grey out per the interface (terminal sessions have no link to hand back).
Sessions run from the agent home bucket to `Hermes`; anything else takes its
project name from its repo folder, optionally relabelled for display via
`HERMES_PROJECT_ALIASES` (comma-separated `from=to` pairs, `from` matched
case-insensitively, malformed pairs skipped — operator environment, never
hardcoded names, since stored session roots keep their old folder string).

## Cursor

I mapped this one against a real install (3.19.x on a second machine, colony on
Linux). Two places matter, and one tempting one does not:

- Per-chat transcripts in `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`
  — JSONL lines shaped `{role, message:{content:[...]}}`. The first user line carries
  the prompt inside `<user_query>` plus a `<timestamp>` tag (strip the parenthetical
  zone before `Date.parse`). No title, no archive flag, no focus signal in the file.
- The search index at `Cursor/User/globalStorage/conversation-search.db` (a few hundred
  KB, no WAL) — table `conversations(id, title, branches, updated_at, is_archived)`
  plus a `conversation_fts` body I use as the preview fallback. Titles and the archive
  flag live here. The remaining columns (source, scope, fingerprints) and the other
  tables carry no liveness signal — I dumped them all to be sure.
- The per-workspace `state.vscdb` files look promising but hold no chats (layout keys
  only; the `composerHeaders` table exists but is empty). I went down that hole so you
  don't have to. The 500MB+ global `state.vscdb` is never pulled either.

The index is append-only and deleted chats leave their transcript files behind, so
the scan starts from the union and then prunes the ghosts (on my install: 3 real
chats under 16 union rows). Index-only rows with no title and no FTS body are
skipped, as are contentless stubs (a lone usage-limit error line parses to no prompt
at all), same-conversation copies under different uuids (a cross-project move leaves
the old `.jsonl` frozen in place — newest transcript wins), and transcript-only rows
older than a day (deleting a chat drops its index row but leaves the files). Fresh
transcript-only rows and titled index-only rows still stand, and when the index
itself is unreadable the transcript-only rule stays off so a missing index never
hides transcripts by itself. A uuid filed under two project slugs (a stale move
copy) dedupes to the newest transcript. One chat, one astronaut — ids never widen.

`is_archived` is not a deletion signal — live chats sit on both sides of it — so it
only fills the thread's archived field, never the prune decision.

When the colony runs on the same machine as Cursor, point `CURSOR_DATA_DIR` (default
`~/.cursor`) and `CURSOR_SEARCH_DB` at the store and you're done. Over SSH, one
PowerShell pass emits the search index (base64, copied to temp first so a concurrent
write can't tear it), transcript stats, and first-line heads into a local snapshot:
`CURSOR_SSH_TARGET`, `CURSOR_REMOTE_PATH` (default `.cursor`), and
`CURSOR_REMOTE_SEARCH_DB` configure it; snapshots live under `CURSOR_SNAPSHOT_DIR`.
A failed pull or a torn snapshot keeps the previous one serving.

`BOT_CROSSING_CURSOR_PROJECTS` names the projects root outright (tests,
non-standard installs). Running/error come from the transcript tail for
local reads (`turn_ended` markers: a closed turn is not running, a failed
close is an error, pre-marker transcripts are never mid-turn); remote pulls
carry heads only, so remote threads keep the recency heuristic.

Read-only throughout: there is no `setArchived` (flipping the index's flag
from here would race the desktop app — archiving is colony-internal), and
there is no per-thread deep link, so opening says so while new sessions
offer the `cursor://file/<abs>` folder link. I verified
the scan against the app's own history panel (3 chats) after dumping every index row
with all columns, every transcript's head and tail, and the per-workspace composer
selections, and a corrupt snapshot degrades to the last good one without taking the
other harnesses down.

## Checking your work

`npm test` runs the suite (`test/harness.test.mjs` for the adapter contract plus
fixture-driven Codex/Cursor scans, `test/state.test.mjs` for colony migration and
merge-on-save). What a new adapter was verified against, and should clear too:

1. `node --check server/harnesses/my-harness.mjs`
2. With the app running, `GET /api/harnesses` lists every registered harness and whether
   `detect()` found it. If yours is missing or `detected: false`, stop here — nothing else
   will work until it shows up:

   ```bash
   curl -s localhost:5274/api/harnesses
   ```
3. Scan straight from node and look at the result — the number should match what the harness
   itself reports, and no field should be `undefined`:

   ```bash
   node -e 'import("./server/scan.mjs").then(async m => {
     const t = (await m.scanThreads()).filter(x => x.harness === "my-harness")
     console.log(t.length, "threads"); console.dir(t[0], { depth: 4 })
   })'
   ```
4. `npm run dev`, then confirm the astronauts appear on the right plots, the thread card fills
   in, and Open does what you expect.
5. Archive one thread and check the astronaut walks home on the next poll — the
   archive lives in `data/colony.json`, and nothing in the harness's own records changes.
