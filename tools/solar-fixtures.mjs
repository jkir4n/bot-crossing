/**
 * Fixture harness for the solar tile's pure presentation module (src/game/solar.js).
 *
 * Plain node, no imports beyond the module itself — it is dependency-free on purpose.
 * Feeds fake SolarStates through the whole matrix — the three source states, stale and
 * missing payloads, null fields, the glint ceiling — and asserts the visuals land
 * exactly where the design matrix says: glint level, night-dim factor, HA clock
 * target, and the one-line readout.
 *
 * Run: node tools/solar-fixtures.mjs   (exit 1 on any mismatch)
 */

import {
  isSolarFresh,
  solarGlintLevel,
  solarDimFactor,
  solarTimeTarget,
  solarReadout,
  SOLAR_GLINT_FULL_W,
  SOLAR_BATTERY_DIM,
  SOLAR_DAY_TARGET,
  SOLAR_NIGHT_TARGET,
} from '../src/game/solar.js'

let failures = 0
let checks = 0

const state = (over = {}) => ({
  isDay: true,
  solarPowerW: 0,
  batterySoC: 100,
  batteryPowerW: 0,
  cutoff: null,
  cutIn: null,
  source: null,
  stale: false,
  lastUpdatedAt: Date.now(),
  lastError: null,
  ...over,
})

function check(name, actual, expected) {
  checks++
  const ok = Object.is(actual, expected)
  if (!ok) {
    failures++
    console.error(`  FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
  return ok
}

function scenario(title, solar, expect) {
  console.log(`\n${title}`)
  check('  fresh', isSolarFresh(solar), expect.fresh)
  check('  glint', solarGlintLevel(solar), expect.glint)
  check('  dim', solarDimFactor(solar), expect.dim)
  check('  haClockTarget', solarTimeTarget(solar), expect.haClockTarget)
  const ro = solarReadout(solar)
  check('  readout.text', ro.text, expect.text)
  if (expect.markInText !== undefined) {
    check('  readout.mark', expect.markInText === null ? !ro.text.includes('▲') && !ro.text.includes('▼') && !ro.text.includes('▦') : ro.text.includes(expect.markInText), true)
  }
  check('  readout.stale', ro.stale, expect.readoutStale ?? !expect.fresh)
}

// ── the matrix ────────────────────────────────────────────────────────────────────────

scenario('1. solar surplus (day, charging)', state({ solarPowerW: 1500, batteryPowerW: 400, batterySoC: 82 }), {
  fresh: true,
  glint: 0.5,
  dim: 1,
  haClockTarget: SOLAR_DAY_TARGET,
  text: '☀︎ 1500 W · 82 % · ▲',
  markInText: '▲',
})

scenario(
  '2. battery discharging (evening, conserving)',
  state({ isDay: false, solarPowerW: 0, batterySoC: 55, batteryPowerW: -300 }),
  {
    fresh: true,
    glint: 0,
    dim: SOLAR_BATTERY_DIM,
    haClockTarget: SOLAR_NIGHT_TARGET,
    text: '☀︎ 0 W · 55 % · ▼',
    markInText: '▼',
  }
)

scenario(
  '3. grid mode (after cutoff, mains, never dims)',
  state({ isDay: false, solarPowerW: 0, batterySoC: 18, batteryPowerW: 0, source: 'grid' }),
  {
    fresh: true,
    glint: 0,
    dim: 1,
    haClockTarget: SOLAR_NIGHT_TARGET,
    text: '☀︎ 0 W · 18 % · ▦',
    markInText: '▦',
  }
)

scenario(
  '3b. grid mode with residual battery flow still never dims',
  state({ isDay: false, solarPowerW: 0, batterySoC: 19, batteryPowerW: -40, source: 'grid' }),
  { fresh: true, glint: 0, dim: 1, haClockTarget: SOLAR_NIGHT_TARGET, text: '☀︎ 0 W · 19 % · ▦', markInText: '▦' }
)

scenario(
  '4. source=solar keeps lights warm-normal even mid battery draw',
  state({ solarPowerW: 2200, batteryPowerW: -60, source: 'solar' }),
  { fresh: true, glint: 2200 / SOLAR_GLINT_FULL_W, dim: 1, haClockTarget: SOLAR_DAY_TARGET, text: '☀︎ 2200 W · 100 % · ▼', markInText: '▼' }
)

scenario(
  '5. discharging with no source entity (current operator setup) still dims',
  state({ isDay: false, batteryPowerW: -250, batterySoC: 40 }),
  {
    fresh: true,
    glint: 0,
    dim: SOLAR_BATTERY_DIM,
    haClockTarget: SOLAR_NIGHT_TARGET,
    text: '☀︎ 0 W · 40 % · ▼',
    markInText: '▼',
  }
)

scenario('6. stale payload fades everything to neutral', state({ stale: true, lastUpdatedAt: 0, lastError: 'fetch failed' }), {
  fresh: false,
  glint: 0,
  dim: 1,
  haClockTarget: null,
  text: '☀︎ — · —',
  readoutStale: true,
})

scenario('7. null payload (fetch threw) — same neutral', null, {
  fresh: false,
  glint: 0,
  dim: 1,
  haClockTarget: null,
  text: '☀︎ — · —',
  readoutStale: true,
})

scenario('8. fresh but backend has no grid entity: honest solar/battery only', state({ source: null, batteryPowerW: 150 }), {
  fresh: true,
  glint: 0,
  dim: 1,
  haClockTarget: SOLAR_DAY_TARGET,
  text: '☀︎ 0 W · 100 % · ▲',
  markInText: '▲',
})

scenario('9. null fields inside a fresh payload render as em-dashes, never NaN', state({ solarPowerW: null, batterySoC: null, batteryPowerW: null, isDay: null }), {
  fresh: true,
  glint: 0,
  dim: 1,
  haClockTarget: null,
  text: '☀︎ — · —',
})

// ── finer points ──────────────────────────────────────────────────────────────────────

console.log('\nFine points')
check('glint caps at the ceiling (6000 W of 3000)', solarGlintLevel(state({ solarPowerW: 6000 })), 1)
check('glint exactly at ceiling', solarGlintLevel(state({ solarPowerW: SOLAR_GLINT_FULL_W })), 1)
check('glint ignores negative solarW (bad sensor)', solarGlintLevel(state({ solarPowerW: -50 })), 0)
check('idle battery (0 W) draws no arrow', solarReadout(state({ batteryPowerW: 0 })).text.includes('·  ·'), false)
check('idle battery text has no arrow', !/[▲▼▦]/.test(solarReadout(state({ batteryPowerW: 0 })).text), true)
check('thresholds ride the tooltip, not the line', solarReadout(state({ cutoff: 20, cutIn: 50 })).title.includes('grid at 20 % / release 50 %'), true)
check('tooltip never bakes a threshold when HA passes none', solarReadout(state({ cutoff: null, cutIn: null })).title.includes('grid at'), false)
check('tooltip carries source only when HA provides it', solarReadout(state({ source: 'battery' })).title.includes('source: battery'), true)
check('null-source tooltip omits source', solarReadout(state()).title.includes('source:'), false)
check('stale tooltip says so', solarReadout(state({ stale: true })).title.startsWith('Solar data stale'), true)
check('non-finite watts are rejected', solarGlintLevel(state({ solarPowerW: Number.NaN })), 0)
check('batteryPowerW NaN neither dims nor arrows', (() => {
  const s = state({ batteryPowerW: Number.NaN })
  return solarDimFactor(s) === 1 && !/[▲▼]/.test(solarReadout(s).text)
})(), true)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.error('FIXTURE MATRIX FAILED')
  process.exit(1)
}
console.log('Fixture matrix matches the design exactly.')
