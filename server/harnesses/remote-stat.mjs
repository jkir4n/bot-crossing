/**
 * Shared remote-topology helpers (fork addition).
 *
 * Consumed by the remote-snapshot adapters (opencode, cursor, antigravity)
 * so they stamp the same optional fields the same way. The local adapter
 * never imports this module, which keeps its threads byte-identical.
 *
 * Contract (seam): thread objects MAY carry host/lastSeenAt/remote.
 * Absence means a local thread and renders exactly as today.
 *
 * lastSeenAt semantics: colony-host clock only. Each adapter stamps
 * Date.now() at its last successful remote contact (stat success, fresh
 * pull) and emits it as ISO. Remote wall-clock values are never forwarded,
 * so cross-machine skew cannot flip a liveness band. Merging two stamps
 * takes the later one as ISO.
 */

const FALLBACK_HOST = 'WinPC'

/**
 * Generic host label from operator environment. Tries each env name in
 * order, first non-blank value wins, else the generic fallback. The value
 * is a display label only, never a connection target.
 */
export function remoteHostLabel(names = [], fallback = FALLBACK_HOST, env = process.env) {
  for (const name of names) {
    const v = (env && env[name]) || ''
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return fallback
}

/**
 * Fold a stat result into the remembered last-success stamp. Returns the
 * updated stamp: stat.at when stat.ok, otherwise the previous value, so an
 * unreachable scan keeps the stale stamp instead of losing it.
 */
export function noteRemoteSeen(stat, prevAt = 0) {
  const at = stat && stat.ok ? Number(stat.at) : NaN
  if (Number.isFinite(at) && at > 0) return at
  return Number.isFinite(prevAt) && prevAt > 0 ? prevAt : 0
}

function asMs(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function isoOf(ms) {
  if (!ms) return undefined
  try {
    const d = new Date(ms)
    const t = d.getTime()
    if (!Number.isFinite(t) || t <= 0) return undefined
    return d.toISOString()
  } catch {
    return undefined
  }
}

/**
 * ISO stamp for one scan. Prefers the live stat when it succeeded,
 * otherwise falls back to the remembered stamp and then to the persisted
 * pull time, so a restart or a failed scan still serves the stale value.
 * Returns undefined when nothing usable exists (caller omits the field;
 * remote:true without lastSeenAt reads as unreachable downstream).
 */
export function remoteSeenIso(stat, prevAt = 0, metaAt = 0) {
  if (stat && stat.ok) {
    const iso = isoOf(asMs(stat.at))
    if (iso) return iso
  }
  const remembered = asMs(prevAt)
  if (remembered) {
    const iso = isoOf(remembered)
    if (iso) return iso
  }
  return isoOf(asMs(metaAt))
}

/**
 * Later of two ISO stamps, for overlay merges. Missing/invalid sides lose;
 * both missing yields undefined.
 */
export function maxSeenIso(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN
  const tb = typeof b === 'string' ? Date.parse(b) : NaN
  const okA = Number.isFinite(ta) && ta > 0
  const okB = Number.isFinite(tb) && tb > 0
  if (okA && okB) return new Date(Math.max(ta, tb)).toISOString()
  if (okA) return new Date(ta).toISOString()
  if (okB) return new Date(tb).toISOString()
  return undefined
}

/**
 * Stamp a remote thread. Always sets host + remote:true; adds lastSeenAt
 * only when known.
 */
export function withRemoteTopology(thread, { host, lastSeenAt } = {}) {
  const out = { ...thread, host: host || FALLBACK_HOST, remote: true }
  if (typeof lastSeenAt === 'string' && lastSeenAt) out.lastSeenAt = lastSeenAt
  return out
}
