/**
 * Solar presentation state — pure derivation from the /api/solar SolarState.
 *
 * The renderer stays dumb: every number rendered comes from the payload (the
 * backend's env-config), never from house logic here. The only constants in
 * this file are display-side: a glow ceiling, a dim depth, and sky-clock
 * stops. A stale payload or null fields always collapse to neutral.
 *
 * Dependency-free on purpose, so the fixture harness (tools/solar-fixtures.mjs)
 * can feed fake SolarStates through the whole matrix under plain node.
 */

/** Display-normalization ceiling for panel glint, from the solar design notes. */
export const SOLAR_GLINT_FULL_W = 3000
/** Night-lighting multiplier while the house runs on battery ("a notch"). */
export const SOLAR_BATTERY_DIM = 0.7
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

/**
 * Night-lighting multiplier. Dims a notch only when HA itself says the house
 * is on battery (source === 'battery') and current is flowing out of it. Grid
 * and solar never dim; a null source never dims either — without HA's own
 * source word, discharge is just a measurement, never a conserving state.
 */
export function solarDimFactor(solar) {
  if (!isSolarFresh(solar)) return 1
  if (solar.source !== 'battery') return 1
  const discharging = Number.isFinite(solar.batteryPowerW) && solar.batteryPowerW < 0
  return discharging ? SOLAR_BATTERY_DIM : 1
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
