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
 * Night-lighting multiplier. Dims a notch on genuine battery discharge, never
 * on grid or solar surplus. A null source still dims on discharge: current
 * flowing out of the battery is a measurement, not a guess about grid state.
 */
export function solarDimFactor(solar) {
  if (!isSolarFresh(solar)) return 1
  const discharging = Number.isFinite(solar.batteryPowerW) && solar.batteryPowerW < 0
  if (!discharging) return 1
  if (solar.source === 'grid' || solar.source === 'solar') return 1
  return SOLAR_BATTERY_DIM
}

/** Where the HA time-source holds the clock, or null when it should not push. */
export function solarTimeTarget(solar) {
  if (!isSolarFresh(solar) || solar.isDay === null || solar.isDay === undefined) return null
  return solar.isDay ? SOLAR_DAY_TARGET : SOLAR_NIGHT_TARGET
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
