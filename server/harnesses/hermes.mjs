/**
 * Hermes Agent adapter (fork addition).
 *
 * Reads the agent's own session store — the `sessions` table in
 * `~/.hermes/state.db`, opened read-only — plus a first-user-message preview
 * per session. One SQL pass per scan; a 500-session store answers in
 * milliseconds, so no mtime cache is needed.
 *
 * Hermes sessions live in the terminal and chat apps, which have no deep
 * link to hand back: `openThread` / `newSession` say so per the interface
 * and the UI greys those buttons out. Archiving flips the harness's own
 * `archived` flag with a single atomic UPDATE, so the thread lands in
 * Hermes's archived list rather than only disappearing here.
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

const DB = path.join(os.homedir(), '.hermes', 'state.db')

const openRead = () => new DatabaseSync(DB, { readOnly: true })

function toThread(row) {
  const root = row.git_repo_root || row.cwd || ''
  // Sessions run from the agent home (or with no cwd) are all the same
  // project — don't let basename case/dirname split one bot into many.
  const home = process.env.HOME || '/home/hermes'
  const isHome = !root || root === home || root === home + '/.hermes'
  const project = isHome ? 'Hermes' : path.basename(root)
  // Keep projectPath canonical too: the colony keys plots on (name, path),
  // so three spellings of home would be re-split into three plots downstream.
  const projectPath = isHome ? home : root
  const createdAt = Math.round((row.started_at || 0) * 1000)
  const lastActivityAt = Math.round(((row.last_activity_at || row.ended_at || row.started_at) || 0) * 1000)
  const tokens = (row.input_tokens || 0) + (row.output_tokens || 0)
  return {
    id: `hermes:${row.id}`,
    title: row.title || 'Untitled thread',
    preview: (row.first_user || '').trim().slice(0, 280),
    project,
    projectPath,
    worktree: '',
    cwd: row.cwd || '',
    gitBranch: row.git_branch || '',
    model: row.model || '',
    effort: '',
    createdAt,
    lastActivityAt,
    lastFocusedAt: 0,
    running: row.ended_at == null,
    unread: Boolean(
      row.last_activity_at && row.last_read_at && row.last_activity_at > row.last_read_at
    ),
    hasError: false,
    archived: row.archived === 1,
    sizeBytes: tokens > 0 ? tokens * 4 : (row.message_count || 0) * 500,
    source: row.source || '',
    canOpen: false,
    canArchive: true,
    ref: { sessionId: row.id },
  }
}

async function detect() {
  try {
    openRead().close()
    return true
  } catch {
    return false
  }
}

async function scanThreads() {
  const db = openRead()
  try {
    const rows = db.prepare(`
      SELECT s.id, s.title, s.model, s.source, s.cwd, s.git_branch, s.git_repo_root,
             s.started_at, s.ended_at, s.message_count,
             s.input_tokens, s.output_tokens, s.archived,
             s.last_activity_at, s.last_read_at,
             (SELECT substr(m.content, 1, 280) FROM messages m
               WHERE m.session_id = s.id AND m.role = 'user' AND m.active = 1
               ORDER BY m.id ASC LIMIT 1) AS first_user
        FROM sessions s
       -- Cron executions are scheduled runs, not threads: each one would
       -- stand on the map as an astronaut nobody ever talks to. Skip them.
       WHERE s.hidden = 0 AND s.source != 'cron'
       ORDER BY COALESCE(s.last_activity_at, s.ended_at, s.started_at) DESC
    `).all()
    return rows.map(toThread)
  } finally {
    db.close()
  }
}

function openThread() {
  return { ok: false, error: 'Hermes sessions live in the terminal and chat apps — there is no link to open.' }
}

function newSession() {
  return { ok: false, error: 'Hermes sessions start in the terminal, not from the colony.' }
}

async function setArchived(ref, archived) {
  const sessionId = ref && ref.sessionId
  if (!sessionId) return { ok: false, error: 'Missing thread ref' }
  try {
    const db = new DatabaseSync(DB)
    try {
      const info = db.prepare('UPDATE sessions SET archived = ? WHERE id = ?')
        .run(archived ? 1 : 0, sessionId)
      return info.changes > 0
        ? { ok: true }
        : { ok: false, error: 'No such session in the Hermes store' }
    } finally {
      db.close()
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export default {
  id: 'hermes',
  name: 'Hermes',
  detect,
  scanThreads,
  openThread,
  newSession,
  setArchived,
}
