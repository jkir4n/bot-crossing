/**
 * OpenCode adapter (fork addition).
 *
 * Two paths, in preference order — both read-only except the archive flag:
 *
 *   1. `opencode serve` HTTP API over the LAN (OpenCode Desktop runs on the
 *      WinPC, same LAN). Configure with OPENCODE_SERVE_URL (or
 *      OPENCODE_SERVE_HOST / OPENCODE_SERVE_PORT, default port 4096).
 *      Optional basic auth via OPENCODE_SERVE_USERNAME / OPENCODE_SERVE_PASSWORD.
 *      Endpoints used: GET /session, GET /session/status, GET /project,
 *      GET /session/:id/message?limit=N (previews only, capped per scan).
 *
 *   2. Copy-then-query of the session store (`opencode.db`, the SQLite DB with
 *      `session` / `project` / `workspace` / `session_input` / `part` tables).
 *      The source is NEVER opened live: it is copied to a tmp snapshot first
 *      (db + wal, shm is rebuilt on open), because live-querying over a
 *      network share risks WAL corruption, and even locally a copy keeps the
 *      scan from ever locking the harness's own files. The copy is refreshed
 *      only when the source mtime/size changes (mtime cache, per ground rules).
 *      Point at a snapshot with OPENCODE_DB_PATH — e.g. a file pulled from the
 *      WinPC with scp — or leave unset for this machine's default store:
 *        scp 'user@winpc:.local/share/opencode/opencode.db*' /var/lib/bot-crossing/opencode/
 *        OPENCODE_DB_PATH=/var/lib/bot-crossing/opencode/opencode.db
 *
 * Archive flag is the store's own `session.time_archived` (null = active), set
 * with one atomic UPDATE after re-reading the row — the colony never invents
 * its own archive state. The serve API has no archive endpoint (only title
 * PATCH), so serve-sourced threads are view-only for archiving.
 *
 * Opening: a thread opens iff it has a `share_url` — there is no Desktop deep
 * link to hand back, so unshared threads report why per the interface.
 *
 * Times in the store are epoch milliseconds (verified against a live db).
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ---------------------------------------------------------------- config */

/** Base URL of `opencode serve`, or '' when the serve path is unconfigured. */
function serveBase() {
  const url = (process.env.OPENCODE_SERVE_URL || '').trim().replace(/\/+$/, '')
  if (url) return url
  const host = (process.env.OPENCODE_SERVE_HOST || '').trim()
  if (!host) return ''
  const port = (process.env.OPENCODE_SERVE_PORT || '4096').trim()
  const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`
  return `${withScheme.replace(/\/+$/, '')}:${port}`
}

function serveHeaders() {
  const password = process.env.OPENCODE_SERVE_PASSWORD
  if (!password) return {}
  const user = process.env.OPENCODE_SERVE_USERNAME || 'opencode'
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
}

/** Candidate homes: the sandbox-proof real home first, then the usual ones. */
function homeCandidates() {
  const homes = [process.env.HERMES_REAL_HOME, process.env.HOME, os.homedir()].filter(Boolean)
  return [...new Set(homes)]
}

/** Where the session store might live on this machine (never touched live). */
function dbCandidates() {
  const out = []
  if (process.env.OPENCODE_DB_PATH) out.push(process.env.OPENCODE_DB_PATH)
  for (const h of homeCandidates()) out.push(path.join(h, '.local', 'share', 'opencode', 'opencode.db'))
  return out
}

function resolveSourceDB() {
  for (const file of dbCandidates()) {
    try {
      if (file && fs.statSync(file).isFile()) return file
    } catch {
      /* missing — next candidate */
    }
  }
  return ''
}

async function detect() {
  if (serveBase()) return true
  return resolveSourceDB() !== ''
}

/* ------------------------------------------------------------ serve path */

const SERVE_TIMEOUT_MS = 4000
/** Previews cost one HTTP call per session — cap them; oldest threads go without. */
const SERVE_PREVIEW_SESSIONS = 30
const SERVE_PREVIEW_LIMIT = 20

async function serveGet(base, route) {
  const res = await fetch(`${base}${route}`, {
    headers: { accept: 'application/json', ...serveHeaders() },
    signal: AbortSignal.timeout(SERVE_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`opencode serve ${route} -> HTTP ${res.status}`)
  return res.json()
}

const asArray = (v) => (Array.isArray(v) ? v : [])
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** First user prompt out of a serve message list [{info:{role},parts:[{type,text}]}]. */
function servePreview(messages) {
  for (const m of asArray(messages)) {
    if (!m || typeof m !== 'object') continue
    if (str(m.info && m.info.role).toLowerCase() !== 'user') continue
    for (const p of asArray(m.parts)) {
      if (p && typeof p === 'object' && p.type === 'text' && str(p.text).trim()) {
        return str(p.text).trim().slice(0, 280)
      }
    }
  }
  return ''
}

function serveThread(s, projects, statuses) {
  const time = (s && typeof s === 'object' && typeof s.time === 'object' && s.time) || {}
  const createdAt = num(s.time_created ?? time.created)
  const lastActivityAt = num(s.time_updated ?? time.updated ?? createdAt)
  const id = str(s.id)
  const projectID = str(s.projectID ?? s.project_id)
  const project = projects.get(projectID)
  const directory = str(s.directory)
  const projectPath = (project && project.worktree && project.worktree !== '/'
    ? str(project.worktree)
    : str(project && project.directory)) || directory
  const status = statuses.get(id)
  const running = status === 'running'
    || (status && typeof status === 'object' && (status.type === 'running' || status.running === true))
    || Date.now() - lastActivityAt < RECENT_WINDOW_MS
  const shareUrl = str(s.share_url ?? s.shareUrl)
  return {
    id: `opencode:${id}`,
    title: str(s.title) || 'Untitled thread',
    preview: '',
    project: (project && project.name) || (projectPath ? path.basename(projectPath) : '') || 'unknown',
    projectPath,
    worktree: '',
    cwd: directory,
    gitBranch: str((project && project.branch) ?? s.branch),
    model: str(s.modelID ?? s.model_id ?? (s.model && s.model.modelID) ?? s.model),
    effort: '',
    createdAt,
    lastActivityAt,
    lastFocusedAt: 0,
    running,
    unread: false,
    hasError: false,
    archived: false,
    sizeBytes: 500,
    source: 'serve',
    canOpen: Boolean(shareUrl),
    canArchive: false,
    ref: { sessionId: id, via: 'serve', shareUrl },
  }
}

async function scanViaServe() {
  const base = serveBase()
  const sessions = asArray(await serveGet(base, '/session'))
  let statuses = new Map()
  try {
    const raw = await serveGet(base, '/session/status')
    if (raw && typeof raw === 'object') statuses = new Map(Object.entries(raw))
  } catch {
    /* status is best-effort; recency fills in below */
  }
  let projects = new Map()
  try {
    for (const p of asArray(await serveGet(base, '/project'))) {
      if (p && typeof p === 'object' && p.id) {
        projects.set(str(p.id), {
          name: str(p.name),
          worktree: str(p.worktree),
          directory: str(p.directory),
          branch: str(p.branch),
        })
      }
    }
  } catch {
    /* names fall back to the session directory basename */
  }
  const ordered = sessions
    .filter((s) => s && typeof s === 'object' && s.id)
    .sort((a, b) => num((b.time && b.time.updated) ?? b.time_updated) - num((a.time && a.time.updated) ?? a.time_updated))
  const threads = ordered.map((s) => serveThread(s, projects, statuses))
  // Previews, newest first, bounded concurrency so one slow session
  // cannot hold the scan hostage.
  const ids = threads.slice(0, SERVE_PREVIEW_SESSIONS)
  const queue = ids.map((t, i) => [t, ordered[i]])
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [t, s] = queue.pop()
      try {
        const messages = asArray(await serveGet(base, `/session/${encodeURIComponent(s.id)}/message?limit=${SERVE_PREVIEW_LIMIT}`))
        t.preview = servePreview(messages)
      } catch {
        /* preview stays '' — the thread still stands on the map */
      }
    }
  }))
  return threads
}

/* --------------------------------------------------------------- db path */

/** Updated within this window counts as working right now (db path only). */
const RECENT_WINDOW_MS = 5 * 60 * 1000

const SNAPSHOT_DIR = path.join(os.tmpdir(), 'bot-crossing-opencode')
const SNAPSHOT_DB = path.join(SNAPSHOT_DIR, 'opencode.db')
let snapshotCache = { key: '', source: '' }

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
 * Copy the store to a tmp snapshot, never opening the source itself —
 * the source may sit on a network share where live SQLite access risks
 * WAL corruption, and locally a copy never locks the harness's files.
 */
function snapshotDB(source) {
  const key = sourceKey(source)
  if (snapshotCache.key === key && snapshotCache.source === source) {
    try {
      if (fs.statSync(SNAPSHOT_DB).isFile()) return SNAPSHOT_DB
    } catch {
      /* snapshot vanished — fall through and re-copy */
    }
  }
  // Same-file guard: OPENCODE_DB_PATH already pointing at the snapshot.
  try {
    if (fs.realpathSync(source) === fs.realpathSync(SNAPSHOT_DB)) {
      snapshotCache = { key, source }
      return SNAPSHOT_DB
    }
  } catch {
    /* snapshot does not exist yet — normal first run */
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  // Remove a stale wal/shm first: a previous snapshot's wal must never
  // shadow a source that has since checkpointed.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.rmSync(SNAPSHOT_DB + suffix, { force: true })
    } catch {
      /* already gone */
    }
  }
  fs.copyFileSync(source, SNAPSHOT_DB)
  try {
    fs.copyFileSync(source + '-wal', SNAPSHOT_DB + '-wal')
  } catch {
    /* fully checkpointed — the db file alone is a consistent view */
  }
  snapshotCache = { key, source }
  return SNAPSHOT_DB
}

const openRead = (file) => new DatabaseSync(file, { readOnly: true })

function tableNames(db) {
  try {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
  } catch {
    return new Set()
  }
}

/** First user prompt from the message/part tables (fallback when session_input is absent). */
function partsPreview(db, tables, sessionId) {
  if (!tables.has('part') || !tables.has('message')) return ''
  let rows = []
  try {
    rows = db.prepare(
      `SELECT p.data AS pdata, m.data AS mdata FROM part p
         JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ? ORDER BY p.time_created ASC LIMIT 25`
    ).all(sessionId)
  } catch {
    return ''
  }
  for (const row of rows) {
    let msg = null
    let part = null
    try {
      msg = JSON.parse(row.mdata)
    } catch {
      continue
    }
    if (!msg || typeof msg !== 'object' || str(msg.role).toLowerCase() !== 'user') continue
    try {
      part = JSON.parse(row.pdata)
    } catch {
      continue
    }
    if (part && typeof part === 'object' && part.type === 'text' && str(part.text).trim()) {
      return str(part.text).trim().slice(0, 280)
    }
  }
  return ''
}

const THREAD_SQL = `
  SELECT s.id, s.project_id, s.workspace_id, s.directory, s.title, s.agent, s.model,
         s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
         s.share_url, s.time_created, s.time_updated, s.time_archived,
         p.name AS project_name,
         w.branch AS ws_branch,
         (SELECT pd.directory FROM project_directory pd
           WHERE pd.project_id = s.project_id LIMIT 1) AS project_dir,
         __FIRST_PROMPT__ AS first_prompt
    FROM session s
    LEFT JOIN project p ON p.id = s.project_id
    LEFT JOIN workspace w ON w.id = s.workspace_id
   ORDER BY s.time_updated DESC
`

function toThread(row, preview) {
  const projectPath = str(row.project_dir) || str(row.directory)
  const tokens = num(row.tokens_input) + num(row.tokens_output) + num(row.tokens_reasoning)
  const lastActivityAt = num(row.time_updated) || num(row.time_created)
  const shareUrl = str(row.share_url)
  return {
    id: `opencode:${row.id}`,
    title: str(row.title) || 'Untitled thread',
    preview,
    project: str(row.project_name) || (projectPath ? path.basename(projectPath) : '') || 'unknown',
    projectPath,
    worktree: '',
    cwd: str(row.directory),
    gitBranch: str(row.ws_branch),
    model: str(row.model),
    effort: '',
    createdAt: num(row.time_created),
    lastActivityAt,
    lastFocusedAt: 0,
    running: Date.now() - lastActivityAt < RECENT_WINDOW_MS,
    unread: false,
    hasError: false,
    archived: row.time_archived != null,
    sizeBytes: tokens > 0 ? tokens * 4 : 500,
    source: 'db',
    canOpen: Boolean(shareUrl),
    canArchive: true,
    ref: { sessionId: str(row.id), via: 'db', shareUrl },
  }
}

function scanViaDB(source) {
  const snap = snapshotDB(source)
  const db = openRead(snap)
  try {
    const tables = tableNames(db)
    if (!tables.has('session')) throw new Error('opencode snapshot has no session table')
    const hasInput = tables.has('session_input')
    const sql = THREAD_SQL.replace(
      '__FIRST_PROMPT__',
      hasInput
        ? `(SELECT si.prompt FROM session_input si
              WHERE si.session_id = s.id ORDER BY si.time_created ASC LIMIT 1)`
        : `NULL`
    )
    let rows = []
    try {
      rows = db.prepare(sql).all()
    } catch (err) {
      throw new Error(`opencode session query failed: ${err.message}`)
    }
    return rows.map((row) => {
      let preview = str(row.first_prompt).trim().slice(0, 280)
      // Skip this record's parts lookup only when the prompt already speaks.
      if (!preview) {
        try {
          preview = partsPreview(db, tables, row.id)
        } catch {
          preview = ''
        }
      }
      return toThread(row, preview)
    })
  } finally {
    db.close()
  }
}

async function scanThreads() {
  const base = serveBase()
  if (base) {
    try {
      return await scanViaServe()
    } catch (err) {
      // Serve preferred but never gating: fall through to the store copy.
      console.warn(`bot-crossing: opencode serve unreachable (${err.message}) — falling back to db copy`)
    }
  }
  const source = resolveSourceDB()
  if (!source) throw new Error('No OpenCode session store found (set OPENCODE_DB_PATH or OPENCODE_SERVE_URL)')
  return scanViaDB(source)
}

/* ---------------------------------------------------------------- actions */

function openThread(ref) {
  const url = ref && typeof ref.shareUrl === 'string' ? ref.shareUrl.trim() : ''
  if (url && /^https?:\/\//i.test(url)) return { ok: true, url }
  return { ok: false, error: 'That thread is not shared — open it in the OpenCode Desktop app.' }
}

function newSession() {
  return { ok: false, error: 'OpenCode sessions start in the Desktop app or terminal, not from the colony.' }
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

async function setArchived(ref, archived) {
  const sessionId = ref && ref.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return { ok: false, error: 'Missing thread ref' }
  }
  if (!ref || ref.via !== 'db') {
    return { ok: false, error: 'Serve-listed OpenCode sessions are view-only — archive in the Desktop app.' }
  }
  const source = resolveSourceDB()
  if (!source) return { ok: false, error: 'No OpenCode session store found' }
  try {
    fs.accessSync(source, fs.constants.W_OK)
  } catch {
    return { ok: false, error: 'The OpenCode store is read-only here — archive in the Desktop app.' }
  }
  let db
  try {
    db = new DatabaseSync(source)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  try {
    // Re-read first: only flip the flag on the session we think it is.
    const row = db.prepare('SELECT id FROM session WHERE id = ?').get(sessionId)
    if (!row || row.id !== sessionId) return { ok: false, error: 'No such session in the OpenCode store' }
    const stamp = archived ? Date.now() : null
    const info = db.prepare('UPDATE session SET time_archived = ? WHERE id = ?').run(stamp, sessionId)
    if (info.changes === 0) return { ok: false, error: 'No such session in the OpenCode store' }
    // The snapshot now lies — force a re-copy on the next scan.
    snapshotCache = { key: '', source: '' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  } finally {
    db.close()
  }
}

export default {
  id: 'opencode',
  name: 'OpenCode',
  detect,
  scanThreads,
  openThread,
  newSession,
  setArchived,
}
