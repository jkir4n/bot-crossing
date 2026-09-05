/**
 * Cursor adapter (fork addition).
 *
 * Cursor is a VS Code fork, but its chats do NOT live in the per-workspace
 * `state.vscdb` files (verified: their ItemTable holds only layout keys, and
 * the `cursorDiskKV` / `composerHeaders` tables are empty). The real store is
 * file-based plus a small search index:
 *
 *   <home>/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl
 *     one JSONL transcript per chat. Lines are
 *     {role, message:{content:[{type, text, ...}]}}. The first user line
 *     carries `<timestamp>Thursday, Aug 13, 2026, 1:27 PM (UTC+5:30)</timestamp>`
 *     and the `<user_query>` prompt (preview/title fallback). No title, no
 *     archive flag, no focus signal anywhere in the file.
 *   <config>/Cursor/User/globalStorage/conversation-search.db (266KB, no WAL)
 *     SQLite table `conversations(id, title, branches, updated_at,
 *     is_archived, ...)` plus a `conversation_fts` body for preview fallback.
 *     This is where titles and the archive flag live.
 *
 * Two sources, merged per scan (local wins — it IS the live store):
 *
 *   1. Local store (UNION MEMBER). Same copy-never mechanics as the other
 *      adapters: transcript HEADS are read (never whole files), the search
 *      index is copied then queried (never live-queried), everything is
 *      mtime-cached per ground rules. Point at one with CURSOR_DATA_DIR
 *      (default `~/.cursor`) and CURSOR_SEARCH_DB, or leave both unset for
 *      this machine's defaults.
 *
 *   2. Remote snapshot (PRIMARY on a colony host). The store lives on another
 *      machine; one SSH PowerShell pass emits a MANIFEST (the search index as
 *      base64, transcript stats, transcript first-lines as base64) into a
 *      local snapshot file. The pull is signature-gated — a cheap stat runs
 *      at most once per STAT_TTL window, the bulk pull only when the
 *      signature changed, at most once per PULL_MIN window, in the background
 *      so a scan never blocks. One remote pass is self-consistent; the search
 *      index is copied to temp on the remote side before reading, so a
 *      mid-write pull fails verification and the previous snapshot keeps
 *      serving. The 572MB globalStorage/state.vscdb is NEVER pulled.
 *      Config: CURSOR_SSH_TARGET, CURSOR_REMOTE_PATH (default `.cursor`,
 *      forward slashes), CURSOR_REMOTE_SEARCH_DB (default
 *      `AppData/Roaming/Cursor/User/globalStorage/conversation-search.db`).
 *      Snapshots live under CURSOR_SNAPSHOT_DIR, else the user cache dir,
 *      else the tmpdir.
 *
 * The index and the transcript set do not fully overlap, so the scan starts
 * from their UNION — then prunes the ghosts the app leaves behind (verified
 * Sep 2026: 3 real chats under 16 union rows). A uuid filed under two
 * project slugs (a stale move copy) dedupes to the newest transcript, and:
 *
 *   1. Index-only rows with no title and no FTS body are skipped: the index
 *      is append-only and retains stub rows for empty/deleted composers
 *      (same ghost class as Antigravity's summary-index-only skip). A
 *      titled index-only row still stands with project 'unknown'.
 *   2. Contentless stubs are skipped: transcripts at or under 2KB whose head
 *      parses to no prompt at all (e.g. a lone usage-limit error line). At
 *      that size the head IS the whole file, so the parse is complete, not
 *      truncated — a real chat always opens with its first user prompt.
 *   3. Same-conversation copies under different uuids (a chat moved across
 *      projects leaves the old .jsonl frozen in place) dedupe by first
 *      prompt (timestamp + text): newest transcript wins, one chat, one
 *      astronaut, ids never widen.
 *   4. Transcript-only rows (no index entry) older than a day are skipped:
 *      deleting a chat removes its index row but leaves the .jsonl files
 *      behind (verified: frozen truncated copy + missing fts rowids). Under
 *      a day the row may simply not be indexed yet, so fresh ones stand
 *      with titles from their first prompt. When the index itself is
 *      unreadable this rule stays off and everything stands (fail-open).
 *
 * is_archived is deliberately NOT a discriminator: live chats sit on both
 * sides of it (a real session showed archived with no transcript loss).
 *
 * setArchived says so per the interface even though the index HAS an
 * is_archived flag: flipping it remotely would race the desktop app, which
 * rewrites its records from memory, so the colony keeps its own mark. There
 * is no verified deep link, so openThread/newSession say so too.
 * appStartedAt is omitted: with no outside write to stomp, there is no
 * memory-rewrite guard to drive.
 *
 * GAPS (labeled, not papered over): unread is always false (no focus signal
 * in either source); hasError is always false (would need transcript tails);
 * running is a 5-minute recency heuristic; model is always '' (not stored
 * per chat); lastFocusedAt is 0; project names for drive-rooted slugs are
 * approximate (the slug encoding loses separators — `d-Projects-Hudiy`
 * reads as `Hudiy`, with the drive letter and `Projects` root stripped);
 * remote previews come from the transcript
 * first line only (local falls back across the whole head).
 */

import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { jsonLines, listDirs, num, readHead } from '../lib/fsutil.mjs'

/* ---------------------------------------------------------------- config */

const numEnv = (name, fallback) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** This machine's Cursor data home (never written to, only read). */
function dataHome() {
  const explicit = (process.env.CURSOR_DATA_DIR || '').trim()
  if (explicit) return explicit
  return path.join(os.homedir(), '.cursor')
}

/** Where the search index might live on this machine (never touched live). */
function searchDbCandidates() {
  const out = []
  if ((process.env.CURSOR_SEARCH_DB || '').trim()) out.push(process.env.CURSOR_SEARCH_DB.trim())
  const home = os.homedir()
  if (home) {
    out.push(path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'conversation-search.db'))
    out.push(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'conversation-search.db'))
    const appData = (process.env.APPDATA || '').trim()
    if (appData) out.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'conversation-search.db'))
  }
  return out
}

function snapshotDir() {
  const explicit = (process.env.CURSOR_SNAPSHOT_DIR || '').trim()
  if (explicit) return explicit
  const cache = (process.env.XDG_CACHE_HOME || '').trim()
  if (cache) return path.join(cache, 'bot-crossing', 'cursor')
  const home = os.homedir()
  if (home) return path.join(home, '.cache', 'bot-crossing', 'cursor')
  return path.join(os.tmpdir(), 'bot-crossing-cursor')
}

const SNAP_DIR = snapshotDir()
const SNAP_MANIFEST = path.join(SNAP_DIR, 'remote-manifest.json')
const SNAP_META = path.join(SNAP_DIR, 'remote-manifest.meta.json')
/** Local-source search-index copy (explicit CURSOR_SEARCH_DB or default). */
const LOCAL_SEARCH_DB = path.join(SNAP_DIR, 'local-search.db')

/**
 * The remote store, pulled over SSH. Operator environment, never the repo:
 * no machine names, LAN IPs, or SSH usernames live in this file.
 */
function remoteConfig() {
  const target = (process.env.CURSOR_SSH_TARGET || '').trim()
  if (!target) return null
  if (!/^[^@\s]+@[^@\s:]+$/.test(target)) {
    warnThrottled('target', `ignoring malformed snapshot SSH target (${target.length} chars)`)
    return null
  }
  const remotePath = (process.env.CURSOR_REMOTE_PATH || '.cursor').trim()
  if (!/^[A-Za-z0-9._/\\:-]+$/.test(remotePath) || remotePath.includes('..')) {
    warnThrottled('path', 'ignoring unsafe CURSOR_REMOTE_PATH')
    return null
  }
  const searchDb = (process.env.CURSOR_REMOTE_SEARCH_DB ||
    'AppData/Roaming/Cursor/User/globalStorage/conversation-search.db').trim()
  if (!/^[A-Za-z0-9._/\\:-]+$/.test(searchDb) || searchDb.includes('..')) {
    warnThrottled('searchdb', 'ignoring unsafe CURSOR_REMOTE_SEARCH_DB')
    return null
  }
  return { target, remotePath, searchDb }
}

/* ------------------------------------------------------- throttled warns */

/**
 * The UI polls /api/threads every few seconds; an unreachable remote must not
 * spam the journal on every poll. One line per key per minute is enough.
 */
const lastWarnAt = new Map()
function warnThrottled(key, msg) {
  const now = Date.now()
  if (now - (lastWarnAt.get(key) || 0) < 60 * 1000) return
  lastWarnAt.set(key, now)
  console.warn(`bot-crossing: cursor ${msg}`)
}

/* ------------------------------------------------------- transcript head */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Ticks (UTC, .NET epoch) -> epoch ms. */
const ticksToMs = (ticks) => Math.floor(num(ticks) / 10000 - 62135596800000)

/** Strip the <TAG>...</TAG> wrappers Cursor puts around the first prompt. */
function cleanPrompt(s) {
  return String(s)
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, ' ')
    .replace(/<\/?user_query>/gi, ' ')
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * `<timestamp>Thursday, Aug 13, 2026, 1:27 PM (UTC+5:30)</timestamp>` ->
 * epoch ms. The parenthetical zone breaks Date.parse, so it goes first.
 */
function parseStampTag(text) {
  const m = /<timestamp>([\s\S]*?)<\/timestamp>/i.exec(String(text))
  if (!m) return 0
  const cleaned = m[1].replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  const t = Date.parse(cleaned)
  return Number.isFinite(t) ? t : 0
}

/** First user text out of parsed JSONL records (full-parse, then fallback). */
function firstUserText(records, rawHead) {
  for (const r of records) {
    if (!r || typeof r !== 'object' || r.role !== 'user') continue
    const content = r.message && typeof r.message === 'object' ? r.message.content : null
    if (typeof content === 'string' && content.trim()) return content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          return part.text
        }
      }
    }
  }
  // Truncated head: the text sits at a predictable offset, regex it out.
  const m = /"text"\s*:\s*"((?:[^"\\]|\\.){0,2000})/.exec(String(rawHead))
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`)
    } catch {
      return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"')
    }
  }
  return ''
}

function parseTranscriptHead(head) {
  const records = jsonLines(head || '')
  const text = firstUserText(records, head || '')
  return { createdAt: parseStampTag(text), preview: cleanPrompt(text).slice(0, 280) }
}

/**
 * Project slug -> { project, projectPath }. Drive-rooted slugs
 * (`d-Projects-Hudiy`) decode to a best-effort Windows path; the slug
 * encoding loses separators, so multi-word names read with spaces and the
 * approximation is documented, not hidden. The leading drive letter and the
 * projects-root segment (`Projects`, case-insensitive — the <projects-folder>
 * folder all WinPC repos live under) are display-only noise, so the project
 * name drops them while projectPath keeps the true path. The no-folder
 * bucket reads as Cursor's own panel labels it: `No Repo`. Anything else
 * stands as-is.
 */
function projectOfSlug(slug) {
  if (!slug || typeof slug !== 'string') return { project: 'unknown', projectPath: '' }
  if (slug === 'empty-window') return { project: 'No Repo', projectPath: '' }
  const m = /^([a-zA-Z])-(.+)$/.exec(slug)
  if (m && m[2].includes('-')) {
    const rest = m[2].split('-').filter(Boolean)
    const named = rest.length > 1 && /^projects$/i.test(rest[0]) ? rest.slice(1) : rest
    return {
      project: named.join(' '),
      projectPath: `${m[1].toUpperCase()}:/${rest.join('/')}`,
    }
  }
  return { project: slug || 'unknown', projectPath: '' }
}

/* ------------------------------------------------------------ local store */

const HEAD_BYTES = 8192
/** Transcript heads are expensive to re-read, so keep them until the file changes. */
const headCache = new Map()
let localIndexCache = { key: '', index: new Map() }

async function cachedTranscriptHead(file) {
  let stat = null
  try {
    stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size === 0) return null
  } catch {
    return null
  }
  const key = `${file} ${stat.mtimeMs}:${stat.size}`
  const hit = headCache.get(file)
  if (hit && hit.key === key) return hit.parsed
  let parsed = null
  try {
    // The whole head, not just line 0: usage-limit stubs and tool-only
    // prefixes carry no prompt, the first user record can sit lines down.
    // readHead already dropped the trailing partial line.
    parsed = parseTranscriptHead(await readHead(file, HEAD_BYTES))
  } catch {
    parsed = null
  }
  if (headCache.size > 2000) headCache.clear()
  headCache.set(file, { key, parsed })
  return parsed
}

/** stat signature (db + wal) — the copy refreshes only when this changes. */
function sourceKey(source) {
  const sig = (f) => {
    try {
      const st = fs.statSync(f)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return '-'
    }
  }
  return `${sig(source)}|${sig(source + '-wal')}`
}

/**
 * Copy the search index to a snapshot, never opening the source itself —
 * locally a copy never locks the harness's files.
 */
function snapshotSearchDb(source) {
  const key = sourceKey(source)
  if (localIndexCache.key === key) {
    try {
      if (fs.statSync(LOCAL_SEARCH_DB).isFile()) return LOCAL_SEARCH_DB
    } catch {
      /* snapshot vanished — fall through and re-copy */
    }
  }
  fs.mkdirSync(SNAP_DIR, { recursive: true })
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.rmSync(LOCAL_SEARCH_DB + suffix, { force: true })
    } catch {
      /* already gone */
    }
  }
  fs.copyFileSync(source, LOCAL_SEARCH_DB)
  try {
    fs.copyFileSync(source + '-wal', LOCAL_SEARCH_DB + '-wal')
  } catch {
    /* fully checkpointed — the db file alone is a consistent view */
  }
  localIndexCache.key = key
  return LOCAL_SEARCH_DB
}

function resolveSearchDb() {
  for (const file of searchDbCandidates()) {
    try {
      if (file && fs.statSync(file).isFile()) return file
    } catch {
      /* missing — next candidate */
    }
  }
  return ''
}

/**
 * The search index as id -> { title, branch, updatedAt, archived }.
 * Malformed rows are skipped, a broken file reads as empty — never fatal.
 */
function querySearchIndex(dbFile) {
  const index = new Map()
  let db = null
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
    if (!tables.has('conversations')) return index
    const rows = db.prepare(
      'SELECT id, title, branches, updated_at, is_archived FROM conversations LIMIT 5000').all()
    for (const r of rows) {
      if (!r || typeof r.id !== 'string' || !UUID_RE.test(r.id)) continue
      index.set(r.id, {
        title: typeof r.title === 'string' ? r.title : '',
        branch: typeof r.branches === 'string' ? r.branches : '',
        updatedAt: num(r.updated_at),
        archived: num(r.is_archived) !== 0,
      })
    }
  } catch {
    /* mid-write copy or new shape — index stays whatever parsed so far */
  } finally {
    try {
      db && db.close()
    } catch {
      /* already gone */
    }
  }
  return index
}

/** FTS body fallback for previews when no transcript head exists. */
function queryFtsBody(dbFile, id) {
  let db = null
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
    if (!tables.has('conversation_fts')) return ''
    const row = db.prepare('SELECT body FROM conversation_fts WHERE rowid = (SELECT fts_rowid FROM conversations WHERE id = ? LIMIT 1)').get(id)
    if (row && typeof row.body === 'string') return cleanPrompt(row.body).slice(0, 280)
  } catch {
    /* best effort only */
  } finally {
    try {
      db && db.close()
    } catch {
      /* already gone */
    }
  }
  return ''
}

/* ------------------------------------------------------- ghost pruning */

/**
 * Transcripts at or under this size are fully covered by one head read, so
 * a head that parses to nothing means the file holds no prompt — not a
 * truncated read. Real chats always open with their first user prompt.
 */
const STUB_MAX_BYTES = 2048

/**
 * A transcript with no index row is a deleted chat (deletion drops the row
 * but leaves the .jsonl) — unless it is this fresh, in which case the row
 * may simply not be indexed yet.
 */
const INDEXLESS_TTL_MS = 24 * 60 * 60 * 1000

const headPreview = (rec) => (rec.head && typeof rec.head.preview === 'string' ? rec.head.preview : '')
const headCreated = (rec) => num(rec.head && rec.head.createdAt)
const idxTitle = (rec) => (rec.idx && typeof rec.idx.title === 'string' ? rec.idx.title.trim() : '')

/** Newest transcript wins; ties break bigger, then lexicographically — stable. */
function contentWinner(u1, r1, u2, r2) {
  const m1 = num(r1.tx.mtime)
  const m2 = num(r2.tx.mtime)
  if (m1 !== m2) return m1 > m2 ? u1 : u2
  const s1 = num(r1.tx.size)
  const s2 = num(r2.tx.size)
  if (s1 !== s2) return s1 > s2 ? u1 : u2
  return u1 < u2 ? u1 : u2
}

/**
 * Drop deleted/empty-conversation ghosts from a uuid -> { idx, tx, head }
 * map, in place. Runs on every records-producing site (local store,
 * remote-manifest build, and snapshot serve) so each source is clean on
 * its own and pre-prune snapshots come out clean too. indexRows is the number of parsed
 * index entries behind these records — 0 when the index was unreadable,
 * which disables the transcript-only rule (fail-open: a missing index must
 * never hide transcripts by itself).
 */
function pruneGhostRecords(records, indexRows) {
  for (const [uuid, rec] of [...records]) {
    const txSize = num(rec.tx && rec.tx.size)
    // 1. Index-only stub rows: no transcript, no title, no FTS preview.
    if (!rec.tx && !idxTitle(rec) && !headPreview(rec)) {
      records.delete(uuid)
      continue
    }
    // 2. Contentless stubs: tiny transcript, fully parsed, yet no prompt.
    if (rec.tx && txSize <= STUB_MAX_BYTES && !headPreview(rec) && !headCreated(rec)) {
      records.delete(uuid)
      continue
    }
    // 4. Transcript-only and stale: the index row is gone (deleted chat).
    if (!rec.idx && rec.tx && indexRows > 0 && Date.now() - num(rec.tx.mtime) > INDEXLESS_TTL_MS) {
      records.delete(uuid)
    }
  }
  // 3. Same conversation under two uuids (a cross-project move leaves the
  // old .jsonl frozen): same first prompt -> one survivor, newest wins.
  const byContent = new Map()
  for (const [uuid, rec] of [...records]) {
    if (!rec.tx) continue
    const created = headCreated(rec)
    const preview = headPreview(rec)
    if (!created || !preview) continue
    const key = `${created}\n${preview.slice(0, 80)}`
    const prev = byContent.get(key)
    if (prev === undefined) {
      byContent.set(key, uuid)
      continue
    }
    const winner = contentWinner(prev, records.get(prev), uuid, rec)
    const loser = winner === prev ? uuid : prev
    records.delete(loser)
    byContent.set(key, winner)
  }
  return records
}

/**
 * Every conversation the local store knows, keyed by uuid: index entry,
 * transcript stats, transcript head. A uuid filed under two project slugs
 * (a stale move copy) keeps the newest transcript. One bad file never fails
 * the pass.
 */
async function readLocal(home) {
  const records = new Map()
  const ensure = (uuid) => {
    let r = records.get(uuid)
    if (!r) {
      r = { idx: null, tx: null, head: null }
      records.set(uuid, r)
    }
    return r
  }
  const searchSrc = resolveSearchDb()
  let searchSnap = ''
  if (searchSrc) {
    try {
      searchSnap = snapshotSearchDb(searchSrc)
    } catch {
      /* copy failed — transcripts still stand on their own */
    }
  }
  if (searchSnap) {
    for (const [uuid, entry] of querySearchIndex(searchSnap)) ensure(uuid).idx = entry
  }
  const projectsRoot = path.join(home, 'projects')
  for (const slugDir of await listDirs(projectsRoot)) {
    const slug = path.basename(slugDir)
    const txRoot = path.join(slugDir, 'agent-transcripts')
    for (const uuidDir of await listDirs(txRoot)) {
      const uuid = path.basename(uuidDir)
      if (!UUID_RE.test(uuid)) continue
      const jl = path.join(uuidDir, `${uuid}.jsonl`)
      let stat = null
      try {
        stat = await fsp.stat(jl)
        if (!stat.isFile()) continue
      } catch {
        continue
      }
      const tx = { project: slug, size: stat.size, mtime: Math.floor(stat.mtimeMs) }
      const rec = ensure(uuid)
      if (!rec.tx || tx.mtime > rec.tx.mtime) {
        rec.tx = tx
        try {
          rec.head = await cachedTranscriptHead(jl)
        } catch {
          rec.head = null
        }
      }
    }
  }
  // Index-only rows have no transcript head: the FTS body is their preview.
  if (searchSnap) {
    for (const [uuid, rec] of records) {
      if (!rec.head?.preview && rec.idx) {
        try {
          const body = queryFtsBody(searchSnap, uuid)
          if (body) rec.head = { createdAt: num(rec.idx.updatedAt), preview: body }
        } catch {
          /* preview stays '' */
        }
      }
    }
  }
  let indexRows = 0
  if (searchSnap) {
    for (const rec of records.values()) {
      if (rec.idx) indexRows++
    }
  }
  pruneGhostRecords(records, indexRows)
  return { records, searchSnap }
}

async function storePresent(home) {
  try {
    const stat = await fsp.stat(path.join(home, 'projects'))
    if (stat.isDirectory()) return true
  } catch {
    /* next candidate */
  }
  return resolveSearchDb() !== ''
}

/* ------------------------------------------------- remote snapshot pull */

/** Minimum gap between bulk pulls — the store ticks on every app write. */
function pullMinMs() {
  return numEnv('CURSOR_PULL_MIN_SECONDS', 180) * 1000
}

function statTTLMs() {
  return numEnv('CURSOR_STAT_TTL_SECONDS', 60) * 1000
}

/** PowerShell single-line pass: stats only, no file contents. */
function statScript(rel, searchRel) {
  const q = rel.replace(/'/g, "''")
  const sq = searchRel.replace(/'/g, "''")
  return (
    `$ErrorActionPreference='SilentlyContinue';` +
    `$r=Join-Path $env:USERPROFILE '${q}';` +
    `$s=Get-Item -LiteralPath (Join-Path $env:USERPROFILE '${sq}');$ss=0;$st=0;` +
    `if($s){$ss=$s.Length;$st=$s.LastWriteTimeUtc.Ticks};` +
    `$n=0;$tb=0;$mx=0;` +
    `foreach($dd in (Get-ChildItem -LiteralPath (Join-Path $r 'projects') -Directory)){` +
    `$at=Join-Path $dd.FullName 'agent-transcripts';if(Test-Path -LiteralPath $at){` +
    `foreach($t in (Get-ChildItem -LiteralPath $at -Directory)){` +
    `$jl=Join-Path $t.FullName ($t.Name+'.jsonl');` +
    `foreach($f in (Get-Item -LiteralPath $jl)){` +
    `$n++;$tb+=$f.Length;if($f.LastWriteTimeUtc.Ticks -gt $mx){$mx=$f.LastWriteTimeUtc.Ticks}}}}};` +
    `Write-Output ('SIG|'+$ss+'|'+$st+'|'+$n+'|'+$tb+'|'+$mx)`
  )
}

/**
 * PowerShell single-line pass: the whole snapshot in one stdout. One remote
 * pass is self-consistent by construction. Base64 throughout so free text
 * (titles, prompts) can never break the line protocol. The search index is
 * copied to temp before reading so a concurrent app write cannot tear it.
 */
function manifestScript(rel, searchRel) {
  const q = rel.replace(/'/g, "''")
  const sq = searchRel.replace(/'/g, "''")
  return (
    `$ErrorActionPreference='SilentlyContinue';` +
    `$r=Join-Path $env:USERPROFILE '${q}';Write-Output 'MANIFEST1';` +
    `$tmp=Join-Path $env:TEMP 'cursor-search-copy.db';` +
    `Copy-Item -LiteralPath (Join-Path $env:USERPROFILE '${sq}') -Destination $tmp -Force;` +
    `Write-Output ('SEARCH|'+[Convert]::ToBase64String([IO.File]::ReadAllBytes($tmp)));` +
    `Remove-Item -LiteralPath $tmp -Force;` +
    `foreach($dd in (Get-ChildItem -LiteralPath (Join-Path $r 'projects') -Directory)){` +
    `$at=Join-Path $dd.FullName 'agent-transcripts';if(Test-Path -LiteralPath $at){` +
    `foreach($t in (Get-ChildItem -LiteralPath $at -Directory)){` +
    `$jl=Join-Path $t.FullName ($t.Name+'.jsonl');` +
    `foreach($f in (Get-Item -LiteralPath $jl)){` +
    `Write-Output ('TX|'+$dd.Name+'|'+$t.Name+'|'+$f.Length+'|'+$f.LastWriteTimeUtc.Ticks);` +
    `foreach($ln in (Get-Content -LiteralPath $jl -TotalCount 1)){` +
    `$L=$ln;if($L.Length -gt 1500){$L=$L.Substring(0,1500)};` +
    `Write-Output ('TXH|'+$t.Name+'|'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($L)))}}}}} ;` +
    // A project dir with no transcripts leaves a failed Get-ChildItem as
    // the final statement, which stdin-mode PowerShell reports as exit 1
    // despite complete output — so pin the exit code explicitly. A genuinely
    // broken script never reaches here and still fails loudly.
    `exit 0`
  )
}

const sshArgs = (cfg) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', cfg.target, 'powershell -NoProfile -Command -']

let statCache = { at: 0, sig: '', ok: false }

function remoteStat(cfg, force = false) {
  const now = Date.now()
  if (!force && now - statCache.at < statTTLMs() && statCache.sig) return statCache
  let sig = ''
  let ok = false
  try {
    const out = spawnSync('ssh', sshArgs(cfg), {
      input: statScript(cfg.remotePath, cfg.searchDb),
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
    })
    if (out.status === 0 && out.stdout) {
      for (const line of String(out.stdout).split('\n')) {
        const m = line.replace(/\r/g, '').match(/^SIG\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)$/)
        if (m) {
          sig = m.slice(1).join('|')
          ok = true
        }
      }
    }
  } catch {
    ok = false
  }
  // Cache negatives too (sig '' + ok false still records `at`): an
  // unreachable remote costs one slow scan per STAT_TTL, not one per poll.
  statCache = { at: now, sig: ok ? sig : statCache.sig, ok }
  return statCache
}

function parseManifestText(text) {
  const manifest = { search: '', tx: {}, heads: {} }
  let marked = false
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r/g, '')
    if (line === 'MANIFEST1') {
      marked = true
      continue
    }
    const pipe = line.indexOf('|')
    if (pipe < 0) continue
    const kind = line.slice(0, pipe)
    const rest = line.slice(pipe + 1)
    try {
      if (kind === 'SEARCH') {
        if (/^[A-Za-z0-9+/=\r\n]+$/.test(rest.trim()) && rest.length > 100) manifest.search = rest.trim()
      } else if (kind === 'TX') {
        const [slug, uuid, size, mtime] = rest.split('|')
        if (uuid && UUID_RE.test(uuid) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(slug || '')) {
          const prev = manifest.tx[uuid]
          const mtimeMs = ticksToMs(mtime)
          if (!prev || mtimeMs > prev.mtime) {
            manifest.tx[uuid] = { project: slug, size: num(size), mtime: mtimeMs }
          }
        }
      } else if (kind === 'TXH') {
        const i = rest.indexOf('|')
        if (i > 0) {
          const uuid = rest.slice(0, i)
          if (UUID_RE.test(uuid) && !manifest.heads[uuid]) manifest.heads[uuid] = rest.slice(i + 1)
        }
      }
    } catch {
      /* one bad line never fails the manifest */
    }
  }
  if (!marked) throw new Error('remote manifest missing marker')
  if (!manifest.search && !Object.keys(manifest.tx).length) {
    throw new Error('remote manifest empty')
  }
  return manifest
}

const b64utf8 = (b64) => globalThis.Buffer.from(b64, 'base64').toString('utf8')

/**
 * Manifest into the same shape readLocal() returns: index rows queried off
 * the embedded search db (written to a temp file — node:sqlite needs one),
 * transcript heads parsed from first lines, FTS bodies filling preview gaps.
 */
function manifestRecords(manifest) {
  const records = new Map()
  const ensure = (uuid) => {
    let r = records.get(uuid)
    if (!r) {
      r = { idx: null, tx: null, head: null }
      records.set(uuid, r)
    }
    return r
  }
  let searchFile = ''
  if (manifest.search) {
    try {
      fs.mkdirSync(SNAP_DIR, { recursive: true })
      searchFile = path.join(SNAP_DIR, 'remote-search.db.next')
      fs.writeFileSync(searchFile, globalThis.Buffer.from(manifest.search, 'base64'))
      for (const [uuid, entry] of querySearchIndex(searchFile)) ensure(uuid).idx = entry
    } catch {
      /* index stays absent — transcripts still stand on their own */
      searchFile = ''
    }
  }
  for (const [uuid, tx] of Object.entries(manifest.tx)) ensure(uuid).tx = tx
  for (const [uuid, b64] of Object.entries(manifest.heads)) {
    try {
      const head = parseTranscriptHead(b64utf8(b64))
      if (head.preview || head.createdAt) ensure(uuid).head = head
    } catch {
      /* skip that head */
    }
  }
  // Index-only rows have no transcript head: the FTS body is their preview.
  if (searchFile) {
    try {
      for (const [uuid, rec] of records) {
        if (!rec.head?.preview && rec.idx) {
          const body = queryFtsBody(searchFile, uuid)
          if (body) rec.head = { createdAt: num(rec.idx.updatedAt), preview: body }
        }
      }
    } catch {
      /* previews stay '' — the threads still stand on the map */
    } finally {
      try {
        fs.rmSync(searchFile, { force: true })
        fs.rmSync(searchFile + '-shm', { force: true })
        fs.rmSync(searchFile + '-wal', { force: true })
        fs.rmSync(searchFile + '-journal', { force: true })
      } catch {
        /* best effort */
      }
    }
  }
  let indexRows = 0
  if (manifest.search) {
    for (const rec of records.values()) {
      if (rec.idx) indexRows++
    }
  }
  pruneGhostRecords(records, indexRows)
  return { records }
}

function readSnapshotFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object' || !raw.snapshot) throw new Error('snapshot has no snapshot')
  const records = new Map()
  for (const [uuid, rec] of Object.entries(raw.snapshot)) {
    if (!UUID_RE.test(uuid) || !rec || typeof rec !== 'object') continue
    records.set(uuid, {
      idx: rec.idx && typeof rec.idx === 'object' ? rec.idx : null,
      tx: rec.tx && typeof rec.tx === 'object' ? rec.tx : null,
      head: rec.head && typeof rec.head === 'object' ? rec.head : null,
    })
  }
  if (!records.size) throw new Error('snapshot has no records')
  // Snapshots written before the ghost prune (or while the index pull was
  // failing) still carry deleted/empty rows: prune at serve time too. The
  // filter is idempotent, so already-clean snapshots pass through untouched.
  // indexRows counts parsed index entries — 0 disables the transcript-only
  // rule (fail-open, same as the build paths).
  let indexRows = 0
  for (const rec of records.values()) {
    if (rec.idx) indexRows++
  }
  pruneGhostRecords(records, indexRows)
  return records
}

function readRemoteMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAP_META, 'utf8'))
    if (raw && typeof raw === 'object' && typeof raw.sig === 'string') return raw
  } catch {
    /* no meta yet — first pull */
  }
  return null
}

function snapshotReady(meta, sig) {
  if (!meta || meta.sig !== sig) return false
  try {
    return fs.statSync(SNAP_MANIFEST).isFile()
  } catch {
    return false
  }
}

let pullInFlight = false
let lastPullAttempt = 0

function finishPull(sig, text) {
  pullInFlight = false
  let manifest
  try {
    manifest = parseManifestText(text)
  } catch (err) {
    warnThrottled('pull-parse', `snapshot pull unusable (${err.message}) — keeping previous snapshot`)
    return
  }
  // Verify before publish: the index must still decode and the records must
  // still build. A mid-write pull that fails here is discarded and the
  // previous snapshot keeps serving until the next window retries.
  let snapshot = null
  try {
    const { records } = manifestRecords(manifest)
    if (!records.size) throw new Error('no records')
    snapshot = {}
    for (const [uuid, rec] of records) snapshot[uuid] = rec
  } catch (err) {
    warnThrottled('pull-verify', `snapshot pull failed verification (${err.message}) — keeping previous snapshot`)
    return
  }
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true })
    const next = `${SNAP_MANIFEST}.next`
    fs.writeFileSync(next, JSON.stringify({ v: 1, pulledAt: Date.now(), snapshot }))
    fs.renameSync(next, SNAP_MANIFEST)
    fs.writeFileSync(SNAP_META, JSON.stringify({ sig, pulledAt: Date.now() }))
    console.warn(`bot-crossing: cursor snapshot refreshed (${Object.keys(snapshot).length} conversations)`)
  } catch (err) {
    warnThrottled('pull-swap', `snapshot pull could not go live (${err.message}) — keeping previous snapshot`)
  }
}

/**
 * Start a background manifest pull. Never blocks the scan: the previous
 * snapshot (or local-only, on first run) keeps serving until the new copy
 * verifies and swaps in.
 */
function startBackgroundPull(cfg, sig) {
  if (pullInFlight) return
  const now = Date.now()
  if (now - lastPullAttempt < pullMinMs()) return
  lastPullAttempt = now
  pullInFlight = true
  let child
  try {
    child = spawn('ssh', sshArgs(cfg), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  } catch (err) {
    pullInFlight = false
    warnThrottled('pull-spawn', `snapshot pull could not start (${err.message})`)
    return
  }
  let text = ''
  let tooBig = false
  try {
    child.stdin.write(manifestScript(cfg.remotePath, cfg.searchDb))
    child.stdin.end()
  } catch {
    pullInFlight = false
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    return
  }
  const timer = setTimeout(() => {
    tooBig = true
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }, 120000)
  child.stdout.on('data', (chunk) => {
    if (tooBig) return
    text += chunk.toString('utf8')
    if (text.length > 32 * 1024 * 1024) {
      tooBig = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  })
  child.on('error', () => {
    clearTimeout(timer)
    pullInFlight = false
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    // The manifest verifies before publish, so a nonzero exit with complete
    // output still lands (Windows stdin-mode exit codes are flaky — see the
    // `exit 0` note on manifestScript). Only an empty or truncated pull fails.
    if (tooBig || !text) {
      pullInFlight = false
      if (!tooBig) warnThrottled('pull-ssh', 'snapshot pull failed (remote busy) — keeping previous snapshot')
      return
    }
    if (code !== 0) warnThrottled('pull-code', `snapshot pull exited ${code} with output — verifying anyway`)
    finishPull(sig, text)
  })
}

/**
 * Local path of the remote snapshot manifest, or '' when there is nothing
 * usable. Kicks off a background refresh when stale — the scan uses whatever
 * is on disk meanwhile, so a down remote degrades to the last snapshot
 * instead of breaking the scan.
 */
function ensureRemoteSnapshot() {
  const cfg = remoteConfig()
  if (!cfg) return ''
  let stat
  try {
    stat = remoteStat(cfg)
  } catch {
    stat = { ok: false, sig: '' }
  }
  const meta = readRemoteMeta()
  if (stat.ok && stat.sig) {
    if (snapshotReady(meta, stat.sig)) return SNAP_MANIFEST
    startBackgroundPull(cfg, stat.sig)
    // Stale-but-present snapshot still serves while the refresh flies.
    try {
      if (fs.statSync(SNAP_MANIFEST).isFile()) return SNAP_MANIFEST
    } catch {
      /* first pull still running — local-only this scan */
    }
    return ''
  }
  // Remote unreachable: last snapshot stands in, whatever its age.
  if (meta) {
    try {
      if (fs.statSync(SNAP_MANIFEST).isFile()) return SNAP_MANIFEST
    } catch {
      /* snapshot vanished — nothing to serve */
    }
  }
  return ''
}

/* ---------------------------------------------------------- merge + scan */

/** Updated within this window counts as working right now. */
const RECENT_WINDOW_MS = 5 * 60 * 1000

function toThread(uuid, rec, remote) {
  const idx = rec.idx || {}
  const tx = rec.tx || {}
  const head = rec.head || {}
  const { project, projectPath } = projectOfSlug(tx.project || '')
  const title = idx.title || head.preview || 'Untitled thread'
  const createdAt = num(head.createdAt) || num(idx.updatedAt) || num(tx.mtime)
  const lastActivityAt = Math.max(num(tx.mtime), num(idx.updatedAt), num(head.createdAt))
  return {
    id: `cursor:${uuid}`,
    title,
    preview: head.preview || '',
    project: project || 'unknown',
    projectPath,
    worktree: '',
    cwd: projectPath,
    gitBranch: idx.branch || '',
    model: '',
    effort: '',
    createdAt,
    lastActivityAt,
    lastFocusedAt: 0,
    running: Date.now() - lastActivityAt < RECENT_WINDOW_MS,
    unread: false,
    hasError: false,
    archived: Boolean(idx.archived),
    sizeBytes: num(tx.size) || 500,
    source: tx.size ? (remote ? 'transcript-remote' : 'transcript') : 'index-only',
    canOpen: false,
    canArchive: false,
    ref: { conversationId: uuid, via: remote ? 'snapshot' : 'local' },
  }
}

async function detect() {
  if (remoteConfig()) return true
  try {
    return await storePresent(dataHome())
  } catch {
    return false
  }
}

async function scanThreads() {
  const byId = new Map()
  const snapFile = ensureRemoteSnapshot()
  if (snapFile) {
    try {
      for (const [uuid, rec] of readSnapshotFile(snapFile)) byId.set(uuid, { rec, remote: true })
    } catch (err) {
      warnThrottled('remote-scan', `remote snapshot unreadable (${err.message}) — keeping previous on next pull`)
    }
  }
  const home = dataHome()
  try {
    if (await storePresent(home)) {
      const { records } = await readLocal(home)
      for (const [uuid, rec] of records) byId.set(uuid, { rec, remote: false })
    }
  } catch (err) {
    warnThrottled('local-scan', `local store unreadable (${err.message})`)
  }
  if (!byId.size) {
    if (!remoteConfig() && !(await storePresent(home))) {
      throw new Error('No Cursor store found (set CURSOR_SSH_TARGET or CURSOR_DATA_DIR)')
    }
    throw new Error('No Cursor store readable right now')
  }
  return [...byId].map(([uuid, { rec, remote }]) => toThread(uuid, rec, remote))
}

/* ---------------------------------------------------------------- actions */

function openThread() {
  return { ok: false, error: 'Cursor threads open in the desktop app — no link scheme verified yet.' }
}

function newSession() {
  return { ok: false, error: 'Cursor sessions start in the desktop app, not from the colony.' }
}

async function setArchived() {
  return { ok: false, error: 'Cursor archiving stays in the desktop app — the colony keeps its own archive mark.' }
}

export default {
  id: 'cursor',
  name: 'Cursor',
  detect,
  scanThreads,
  openThread,
  newSession,
  setArchived,
}
