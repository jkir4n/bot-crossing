/**
 * Remote presence for the thread panel: live / asleep / unreachable.
 *
 * The scan stamps remote threads (and only remote threads) with optional
 * `host` / `lastSeenAt` / `remote` fields — the colony-host clock at the last
 * contact that actually succeeded. Local threads carry none of these fields,
 * and for them every function here answers "not remote", so the panel renders
 * exactly as it always has.
 *
 * Bands are locked (research): under 10 minutes since last contact reads live;
 * 10 minutes to 2 hours reads asleep (dimmed, the existing dormant treatment);
 * past 2 hours — or a remote thread with no usable stamp at all — reads
 * unreachable (grey, with a small "last seen" chip). A stamp from the future
 * (clock skew between the two machines) clamps to now and reads live.
 *
 * Pure module, no DOM: the panel imports it, and the fixture exercises it in
 * node without a browser.
 */

/** Under this age a remote thread reads live — appearance unchanged. */
export const REMOTE_LIVE_MS = 10 * 60 * 1000
/** Past this age a remote thread reads unreachable — grey plus the chip. */
export const REMOTE_ASLEEP_MS = 2 * 60 * 60 * 1000

/**
 * Whether a thread carries any remote topology at all. Absence of all three
 * fields means a local thread: render as today, no presence, no chip.
 */
export function isRemoteThread(thread) {
  return (
    !!thread &&
    (thread.remote === true || typeof thread.host === 'string' || typeof thread.lastSeenAt === 'string')
  )
}

/**
 * Thread → 'live' | 'asleep' | 'unreachable', or null for local threads.
 * Local threads (no remote fields) always answer null: the feature is
 * invisible when the fields are missing.
 */
export function remotePresence(thread, now = Date.now()) {
  if (!isRemoteThread(thread)) return null
  const seen = Date.parse(thread.lastSeenAt)
  if (!Number.isFinite(seen)) return 'unreachable'
  const delta = Math.max(0, now - seen)
  if (delta < REMOTE_LIVE_MS) return 'live'
  if (delta < REMOTE_ASLEEP_MS) return 'asleep'
  return 'unreachable'
}

/** A stamp → local-time "HH:MM", or null when there is nothing usable to show. */
export function lastSeenClock(lastSeenAt) {
  const seen = Date.parse(lastSeenAt)
  if (!Number.isFinite(seen)) return null
  const d = new Date(seen)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Generic chip text for an unreachable row — the time when known, a dash when not. */
export function presenceNote(thread, presence = remotePresence(thread)) {
  if (presence !== 'unreachable') return ''
  const clock = lastSeenClock(thread?.lastSeenAt)
  return clock ? `last seen ${clock}` : 'last seen —'
}

/** The chip HTML for a panel row, or '' when the row earns none. */
export function presenceChip(thread, presence = remotePresence(thread)) {
  const note = presenceNote(thread, presence)
  return note ? `<span class="seen">${note}</span>` : ''
}

/** Extra row class for a presence, or '' when the row keeps its status colour. */
export function presenceClass(presence) {
  if (presence === 'asleep') return ' asleep'
  if (presence === 'unreachable') return ' unreachable'
  return ''
}

/**
 * The per-row repaint fragment for presence. Wired into the panel's row
 * signature so a lastSeenAt-only change on a poll actually repaints the row.
 * Local threads always contribute the same fragment: their rows repaint
 * exactly as often as before.
 */
export function presenceSig(thread) {
  return `${thread?.remote ? 1 : 0}:${thread?.lastSeenAt || ''}`
}

/**
 * One stamp summarising a repo for the legend signature: the latest lastSeenAt
 * across its threads, or '' when none carry one. Lets the legend notice a
 * lastSeenAt-only change without showing anything new itself.
 */
export function projectSeenStamp(threads) {
  let best = ''
  for (const t of threads || []) {
    if (typeof t?.lastSeenAt === 'string' && t.lastSeenAt > best) best = t.lastSeenAt
  }
  return best
}
