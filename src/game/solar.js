/**
 * Solar presentation state — pure derivation from the /api/solar SolarState.
 *
 * The renderer stays dumb: every number rendered comes from the payload (the
 * backend's env-config), never from house logic here. The only constants in
 * this file are display-side: a glow ceiling and sky-clock stops. A stale
 * payload or null fields always collapse to neutral.
 *
 * Dependency-free on purpose, so the fixture harness (tools/solar-fixtures.mjs)
 * can feed fake SolarStates through the whole matrix under plain node.
 */

/** Display-normalization ceiling for panel glint, from the solar design notes. */
export const SOLAR_GLINT_FULL_W = 3000
/** Sky-clock stops the HA time-source damps toward (0.5 noon, 0.94 night). */
export const SOLAR_DAY_TARGET = 0.5
export const SOLAR_NIGHT_TARGET = 0.94
/** How long a slider drag (or L) holds the clock in HA mode before the follow resumes. */
export const SOLAR_PEEK_MS = 60000

/** Fresh means the backend vouches for the values. Anything else is neutral. */
export function isSolarFresh(solar) {
  return Boolean(solar) && solar.stale === false
}

/**
 * Panel glint 0..1, proportional to live output up to the display ceiling.
 * Zero when stale, missing, or producing nothing — panels sit dark at night.
 */
export function solarGlintLevel(solar) {
  if (!isSolarFresh(solar)) return 0
  const w = solar.solarPowerW
  if (!Number.isFinite(w) || w <= 0) return 0
  return Math.min(1, w / SOLAR_GLINT_FULL_W)
}

/** Where the HA time-source holds the clock, or null when it should not push. */
export function solarTimeTarget(solar) {
  if (!isSolarFresh(solar) || solar.isDay === null || solar.isDay === undefined) return null
  return solar.isDay ? SOLAR_DAY_TARGET : SOLAR_NIGHT_TARGET
}

// ── power zone (1:1 HA displays, no inference) ───────────────────────────────

/**
 * Battery fill 0..1 straight from batterySoC, or null when HA gives nothing
 * usable. The zone's gauge lights that many quartiles; null lights none.
 */
export function batteryFillLevel(solar) {
  if (!isSolarFresh(solar)) return null
  const s = solar.batterySoC
  if (!Number.isFinite(s)) return null
  return Math.min(1, Math.max(0, s / 100))
}

/**
 * How many of the bank's blocks light for the current charge, in fill order.
 * Null or stale SoC lights none — the row sits dark, never guessed. The
 * count is what the zone writes onto its blocks; the mapping lives here so
 * the fixture harness can pin it without a renderer.
 */
export function batteryLitCount(solar, blocks = 4) {
  const fill = batteryFillLevel(solar)
  if (fill === null) return 0
  return Math.round(fill * blocks)
}

/**
 * True only when HA reports both a state of charge and its own grid-connect
 * threshold and the charge sits at or under it. Drives the zone's dimmed
 * battery + guard glow — a label of HA's numbers, never a computed state.
 */
export function batteryBelowCutoff(solar) {
  if (!isSolarFresh(solar)) return false
  const s = solar.batterySoC
  const c = solar.cutoff
  if (!Number.isFinite(s) || !Number.isFinite(c)) return false
  return s <= c
}

/**
 * The rig glows if and only if HA names grid as the source. Stale,
 * null, solar and battery all read as dark — the house is on its own power.
 * Steady POWER_ACCENT emissive, no motion.
 */
export function rigGlowOn(solar) {
  return isSolarFresh(solar) && solar.source === 'grid'
}

/**
 * The rooftop fan turns if and only if HA names grid as the source — the
 * same single HA word as the rig glow, read as motion instead of light.
 * Stale, null, solar and battery all read as still air.
 */
export function turbineSpinning(solar) {
  return isSolarFresh(solar) && solar.source === 'grid'
}

// ── mast beacon (function of solar.source only, like glow/spin) ─────────────

/**
 * Which blink pattern the rooftop mast lamps show. One state, one rhythm —
 * both rigs share it, so they blink in sync. Stale, null and unknown sources
 * read as dark: the colony never fakes a state.
 *   grid    -> 'double-flash' (two quick pulses, then a pause — beacon rhythm)
 *   battery -> 'pulse'        (one soft swell every few seconds)
 *   solar   -> 'steady'       (a calm constant glow)
 */
export function beaconPattern(solar) {
  if (!isSolarFresh(solar)) return 'dark'
  if (solar.source === 'grid') return 'double-flash'
  if (solar.source === 'battery') return 'pulse'
  if (solar.source === 'solar') return 'steady'
  return 'dark'
}

/**
 * Beacon brightness 0..1 for a pattern at `t` seconds. The renderer feeds the
 * shared frame clock, so both rig lamps march together; the renderer scales
 * by its own peak emissive. Calm by design: the double flash is two 0.14 s
 * pulses inside a 2.8 s period, the battery pulse one 1.6 s swell inside
 * 4 s — night-visible, never strobing. Unknown patterns and non-finite
 * clocks fall back to the pattern's resting level, never to a flash.
 */
export function beaconLevel(pattern, t) {
  if (pattern === 'steady') return 0.55
  if (pattern === 'double-flash') {
    if (!Number.isFinite(t)) return 0
    const p = ((t % 2.8) + 2.8) % 2.8
    return p < 0.14 || (p >= 0.28 && p < 0.42) ? 1 : 0
  }
  if (pattern === 'pulse') {
    if (!Number.isFinite(t)) return 0.06
    const ph = ((t % 4) + 4) % 4
    return ph < 1.6 ? 0.06 + 0.6 * Math.sin((Math.PI * ph) / 1.6) : 0.06
  }
  return 0
}

/** End-to-end beacon brightness straight from the SolarState and a clock. */
export function beaconBrightness(solar, t) {
  return beaconLevel(beaconPattern(solar), t)
}

// ── mast beacon seat (rig-composer pack units) ─────────────────────────────
//
// Measured from public/assets/spacebase.glb — every kit node there is
// unrotated at unit scale, so the packed frames ARE the composer's. The low
// mast stands 2.0..2.5 on the structure roof plane (a 0.65 cap), and its fan
// carries twin discs at z ±0.45 reaching 0.575 about the hub at 2.89. The
// old roof-corner seat (0.72, 2.06, -0.72) sat 0.26 clear of the nearest
// steel: the structure top (±0.60) leaves no ring beside the mast base
// (±0.57) to stand on, and the "widest face" bounds lied — per-axis maxima
// are the base flare, not steel at the lamp's height. Triangle-level probing
// finds the truth: the mast's +x face runs flat at x ≈ 0.40 across
// y 2.08..2.20, so the lamp head sits inner-face flush ON that plate, below
// the sweep, on the default (+x+z) camera's side. No arm, no standoff.

/**
 * Vertex-measured mast numbers the seat below is checked against. Rotor
 * floor is hub minus blade reach; the seat face is the mast's flat +x plate
 * under the lamp, from triangle-level probing of the packed glb.
 */
export const MAST_GEOMETRY = {
  roofY: 2.0,
  towerTopY: 2.5,
  faceXAtSeat: 0.4,
  hubY: 2.89,
  bladeReach: 0.575,
  rotorBottomY: 2.315,
}

/**
 * The lamp head per rig: one 0.12 cube, inner face flush on the mast's +x
 * plate. Pack units in the rig composer's frame — the renderer scales by
 * BUILDING_SCALE, the same space the rig composes in.
 */
export const BEACON_SEAT = {
  head: { x: 0.46, y: 2.14, z: 0, size: 0.12 },
}

/**
 * True when a lamp seat is visibly attached and rotor-clear: the head's
 * inner face sits on the mast plate (a graze reads as mounted; air reads as
 * floating), the head hangs on the mast body between roof and tower top,
 * whole below the rotor sweep and outside the swept cylinder.
 */
export function isBeaconSeated(seat = BEACON_SEAT, mast = MAST_GEOMETRY) {
  if (!seat || !mast || typeof seat !== 'object' || typeof mast !== 'object') return false
  const { head } = seat
  if (!head || typeof head !== 'object') return false
  const nums = [head.x, head.y, head.z, head.size,
    mast.roofY, mast.towerTopY, mast.faceXAtSeat, mast.hubY, mast.bladeReach, mast.rotorBottomY]
  if (!nums.every(Number.isFinite)) return false
  if (head.size <= 0) return false
  const inner = head.x - head.size / 2
  const top = head.y + head.size / 2
  const bottom = head.y - head.size / 2
  const mounted =
    Math.abs(inner - mast.faceXAtSeat) <= 0.02 &&
    bottom > mast.roofY &&
    top < mast.towerTopY
  const clear =
    top < mast.rotorBottomY &&
    Math.hypot(inner, top - mast.hubY) > mast.bladeReach
  return mounted && clear
}

/** Which way energy is flowing through the battery, from its meter sign only. */
export function batteryFlow(solar) {
  if (!isSolarFresh(solar)) return 'unknown'
  const w = solar.batteryPowerW
  if (!Number.isFinite(w)) return 'unknown'
  if (w > 0) return 'charge'
  if (w < 0) return 'discharge'
  return 'idle'
}

/**
 * Which battery block carries the activity cue at the current reading:
 * west-to-east index (0-based) over `blocks`, or -1 for none. The cue sits
 * on the flow boundary — while charging the first unlit block fills next,
 * while discharging the last lit block drains — so exactly one block is ever
 * active. Idle, unknown, stale and null readings have no boundary in motion
 * and read -1: the row sits static.
 */
export function activeBlockIndex(solar, blocks = 4) {
  if (!Number.isInteger(blocks) || blocks <= 0) return -1
  const flow = batteryFlow(solar)
  if (flow !== 'charge' && flow !== 'discharge') return -1
  const lit = batteryLitCount(solar, blocks)
  return flow === 'charge' ? Math.min(lit, blocks - 1) : Math.max(lit - 1, 0)
}

/**
 * Activity glow 0..1 for the active block at `t` seconds. Discharge blinks
 * slow and deep (readable as giving out power); charge breathes shallow
 * around a bright seat, distinct from discharge at a glance. Idle, unknown,
 * stale, null and clockless readings hold 0 — the renderer leaves the row
 * static, never guessed.
 */
export function batteryActivityLevel(solar, t) {
  if (!Number.isFinite(t)) return 0
  const flow = batteryFlow(solar)
  if (flow === 'discharge') {
    const ph = ((Math.max(0, t) % 3.0) + 3.0) % 3.0
    return 0.15 + 0.85 * (0.5 - 0.5 * Math.cos((2 * Math.PI * ph) / 3.0))
  }
  if (flow === 'charge') {
    const ph = ((Math.max(0, t) % 5.6) + 5.6) % 5.6
    return 0.7 + 0.3 * (0.5 - 0.5 * Math.cos((2 * Math.PI * ph) / 5.6))
  }
  return 0
}

/**
 * Whether the optional verbatim recorder payload is present. The zone renders
 * nothing from it either way — this exists so callers can tell "absent" from
 * "empty" without touching its rows, which the colony never aggregates.
 */
export function hasSolarHistory(solar) {
  return Boolean(solar) && Array.isArray(solar.history) && solar.history.length > 0
}

const fmtW = (w) => (Number.isFinite(w) ? `${Math.round(w)} W` : '—')
const fmtPct = (s) => (Number.isFinite(s) ? `${s} %` : '—')

/**
 * The one-line panel readout: solar watts, battery percent, and a source mark
 * (up while charging, down while discharging, grid glyph on mains). Thresholds
 * the backend passes through ride in the tooltip, never as baked constants.
 */
export function solarReadout(solar) {
  if (!isSolarFresh(solar)) {
    return {
      text: '☀︎ — · —',
      title: 'Solar data stale — scene is showing the neutral look',
      stale: true,
    }
  }
  const mark =
    solar.source === 'grid'
      ? '▦'
      : Number.isFinite(solar.batteryPowerW)
        ? solar.batteryPowerW > 0
          ? '▲'
          : solar.batteryPowerW < 0
            ? '▼'
            : ''
        : ''
  const text = [`☀︎ ${fmtW(solar.solarPowerW)}`, fmtPct(solar.batterySoC), mark]
    .filter((p) => p !== '')
    .join(' · ')
  const flow = Number.isFinite(solar.batteryPowerW)
    ? solar.batteryPowerW > 0
      ? 'charging'
      : solar.batteryPowerW < 0
        ? 'discharging'
        : 'idle'
    : 'unknown'
  const bits = [`Solar ${fmtW(solar.solarPowerW)}`, `battery ${fmtPct(solar.batterySoC)} (${flow})`]
  if (solar.source) bits.push(`source: ${solar.source}`)
  if (Number.isFinite(solar.cutoff) || Number.isFinite(solar.cutIn)) {
    bits.push(`grid at ${fmtPct(solar.cutoff)} / release ${fmtPct(solar.cutIn)}`)
  }
  if (solar.lastUpdatedAt) bits.push(`updated ${new Date(solar.lastUpdatedAt).toLocaleTimeString()}`)
  if (solar.lastError) bits.push(solar.lastError)
  return { text, title: bits.join(' · '), stale: false }
}

// ── power statistics panel (1:1 HA displays, no inference) ────────────────────

const DASH = '—'

const fmtPanelW = (w) => (Number.isFinite(w) ? `${Math.round(w)} W` : DASH)
const fmtPanelPct = (s) => (Number.isFinite(s) ? `${s} %` : DASH)

/**
 * Verbatim recorder samples, grouped per entity array exactly as HA returned
 * them. Each entry keeps its own entity id (from its first tagged sample) and
 * its raw numeric states in order — non-numeric states drop out, nothing is
 * joined, sliced, sorted or aggregated. Absent/empty reads as [].
 */
export function powerHistorySeries(solar) {
  const h = solar ? solar.history : undefined
  if (!Array.isArray(h)) return []
  const out = []
  h.forEach((group, i) => {
    if (!Array.isArray(group)) return
    const tagged = group.find((s) => s && typeof s === 'object' && typeof s.entity_id === 'string')
    const points = []
    for (const s of group) {
      const v = Number(s && typeof s === 'object' ? s.state : s)
      if (Number.isFinite(v)) points.push(v)
    }
    if (points.length) out.push({ id: tagged ? tagged.entity_id : `series ${i + 1}`, points })
  })
  return out
}

/**
 * Display-ready power statistics: every field is HA's own value formatted, or
 * an em dash when fresh data has nothing usable. Stale/null payloads dash
 * everything and carry the recorder note — the panel never fakes a number.
 */
export function powerPanel(solar) {
  const fresh = isSolarFresh(solar)
  const flow = batteryFlow(solar)
  const flowWord =
    flow === 'charge' ? 'charging' : flow === 'discharge' ? 'discharging' : flow === 'idle' ? 'idle' : null
  const source = fresh ? solar.source : null
  const series = fresh ? powerHistorySeries(solar) : []
  return {
    stale: !fresh,
    source,
    sourceLabel: source === 'solar' ? 'Solar' : source === 'battery' ? 'Battery' : source === 'grid' ? 'Grid' : DASH,
    solarW: fresh ? fmtPanelW(solar.solarPowerW) : DASH,
    soc: fresh ? fmtPanelPct(solar.batterySoC) : DASH,
    batteryW: fresh
      ? Number.isFinite(solar.batteryPowerW)
        ? `${Math.round(solar.batteryPowerW)} W · ${flowWord}`
        : DASH
      : DASH,
    flow,
    flowLabel: flowWord ? flowWord[0].toUpperCase() + flowWord.slice(1) : DASH,
    cutoff: fresh ? fmtPanelPct(solar.cutoff) : DASH,
    cutIn: fresh ? fmtPanelPct(solar.cutIn) : DASH,
    gridLine: source === 'grid' ? 'Grid connected' : source === 'solar' || source === 'battery' ? 'On own power' : DASH,
    subline: fresh
      ? solar.lastUpdatedAt
        ? `live · updated ${new Date(solar.lastUpdatedAt).toLocaleTimeString()}`
        : 'live'
      : 'stale — showing neutral',
    history: {
      present: series.length > 0,
      note: series.length > 0 ? null : 'no history from HA',
      series,
    },
  }
}
