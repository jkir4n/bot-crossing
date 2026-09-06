/**
 * Fixture harness for the solar tile's pure presentation module (src/game/solar.js).
 *
 * Plain node, no imports beyond the module itself — it is dependency-free on purpose.
 * Feeds fake SolarStates through the whole matrix — the three source states, stale and
 * missing payloads, null fields, the glint ceiling — and asserts the visuals land
 * exactly where the design matrix says: glint level, night-dim factor, HA clock
 * target, the one-line readout, and the power zone's fill/guard/glow/spin/flow helpers.
 *
 * Colony rule: pure display of HA facts. A null source is neutral, always — the
 * colony never infers a conserving state from discharge alone. History is a
 * verbatim recorder payload the colony never aggregates: present or absent, it
 * changes nothing rendered.
 *
 * Run: node tools/solar-fixtures.mjs   (exit 1 on any mismatch)
 */

import {
  isSolarFresh,
  solarGlintLevel,
  solarDimFactor,
  solarTimeTarget,
  solarReadout,
  batteryFillLevel,
  batteryBelowCutoff,
  rigGlowOn,
  turbineSpinning,
  batteryFlow,
  hasSolarHistory,
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

function zone(title, solar, expect) {
  console.log(`\n${title}`)
  check('  fill', batteryFillLevel(solar), expect.fill)
  check('  guard', batteryBelowCutoff(solar), expect.guard)
  check('  glow', rigGlowOn(solar), expect.glow)
  check('  spin', turbineSpinning(solar), expect.spin)
  check('  flow', batteryFlow(solar), expect.flow)
  check('  hasHistory', hasSolarHistory(solar), expect.hasHistory)
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
  '2. battery discharging (evening, HA says battery, conserving)',
  state({ isDay: false, solarPowerW: 0, batterySoC: 55, batteryPowerW: -300, source: 'battery' }),
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
  '5. discharging with NO source word stays neutral (null source, no inference)',
  state({ isDay: false, batteryPowerW: -250, batterySoC: 40, source: null }),
  {
    fresh: true,
    glint: 0,
    dim: 1,
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

// ── power zone ──────────────────────────────────────────────────────────────────────

zone('10. zone battery day (charging, above cutoff)', state({ solarPowerW: 1500, batteryPowerW: 400, batterySoC: 82, cutoff: 20, cutIn: 50, source: 'solar' }), {
  fill: 0.82,
  guard: false,
  glow: false,
  spin: false,
  flow: 'charge',
  hasHistory: false,
})

zone('11. zone grid mode (rig glows + fan turns, guard reads HA numbers)', state({ isDay: false, batterySoC: 18, batteryPowerW: 0, cutoff: 20, cutIn: 50, source: 'grid' }), {
  fill: 0.18,
  guard: true,
  glow: true,
  spin: true,
  flow: 'idle',
  hasHistory: false,
})

zone('12. zone battery mode (conserving, rig dark + still)', state({ isDay: false, batterySoC: 55, batteryPowerW: -300, cutoff: 20, source: 'battery' }), {
  fill: 0.55,
  guard: false,
  glow: false,
  spin: false,
  flow: 'discharge',
  hasHistory: false,
})

zone('13. zone null source (neutral: rig dark + still, no guard without cutoff)', state({ batterySoC: 40, batteryPowerW: -250, source: null }), {
  fill: 0.4,
  guard: false,
  glow: false,
  spin: false,
  flow: 'discharge',
  hasHistory: false,
})

zone('14. zone history present changes nothing rendered', state({ solarPowerW: 1500, batteryPowerW: 400, batterySoC: 82, cutoff: 20, source: 'solar', history: [[{ entity_id: 'sensor.x', state: '1.5', last_changed: 't' }]] }), {
  fill: 0.82,
  guard: false,
  glow: false,
  spin: false,
  flow: 'charge',
  hasHistory: true,
})

zone('15. zone stale/nulls (everything neutral, never NaN)', state({ stale: true, solarPowerW: null, batterySoC: null, batteryPowerW: null, cutoff: null, source: null }), {
  fill: null,
  guard: false,
  glow: false,
  spin: false,
  flow: 'unknown',
  hasHistory: false,
})

zone('16. zone null payload (same neutral)', null, {
  fill: null,
  guard: false,
  glow: false,
  spin: false,
  flow: 'unknown',
  hasHistory: false,
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
// Null source never dims, even mid-discharge: discharge without HA's source word is neutral.
check('null source + discharge is neutral, not conserving', solarDimFactor(state({ batteryPowerW: -250, source: null })), 1)
check('undefined source + discharge is neutral too', solarDimFactor(state({ batteryPowerW: -250, source: undefined })), 1)
check('battery source + discharge dims', solarDimFactor(state({ batteryPowerW: -1, source: 'battery' })), SOLAR_BATTERY_DIM)
check('battery source without discharge never dims', solarDimFactor(state({ batteryPowerW: 0, source: 'battery' })), 1)
check('stale battery discharge never dims', solarDimFactor(state({ batteryPowerW: -500, source: 'battery', stale: true })), 1)
// Zone helpers: clamps, cutoffs, glow, flow, history shape.
check('fill clamps at full', batteryFillLevel(state({ batterySoC: 140 })), 1)
check('fill clamps at empty', batteryFillLevel(state({ batterySoC: -4 })), 0)
check('fill null SoC is null', batteryFillLevel(state({ batterySoC: null })), null)
check('guard needs HA cutoff (none => false)', batteryBelowCutoff(state({ batterySoC: 5, cutoff: null })), false)
check('guard at exactly cutoff', batteryBelowCutoff(state({ batterySoC: 20, cutoff: 20 })), true)
check('guard above cutoff', batteryBelowCutoff(state({ batterySoC: 21, cutoff: 20 })), false)
check('glow on solar source is dark', rigGlowOn(state({ source: 'solar' })), false)
check('glow on stale grid is dark', rigGlowOn(state({ source: 'grid', stale: true })), false)
check('glow on null source is dark', rigGlowOn(state({ source: null })), false)
check('glow on fresh grid is on', rigGlowOn(state({ source: 'grid' })), true)
check('spin on solar source is still', turbineSpinning(state({ source: 'solar' })), false)
check('spin on battery source is still', turbineSpinning(state({ source: 'battery' })), false)
check('spin on stale grid is still', turbineSpinning(state({ source: 'grid', stale: true })), false)
check('spin on null source is still', turbineSpinning(state({ source: null })), false)
check('spin on fresh grid turns', turbineSpinning(state({ source: 'grid' })), true)
check('spin follows glow on every source', ['solar', 'battery', 'grid', null, undefined].every((source) => turbineSpinning(state({ source })) === rigGlowOn(state({ source }))), true)
check('flow idle at 0 W', batteryFlow(state({ batteryPowerW: 0 })), 'idle')
check('flow unknown on NaN', batteryFlow(state({ batteryPowerW: Number.NaN })), 'unknown')
check('empty history array reads as absent', hasSolarHistory(state({ history: [] })), false)
check('non-array history reads as absent', hasSolarHistory(state({ history: { samples: [] } })), false)
check('history never moves the glint', solarGlintLevel(state({ solarPowerW: 1500, history: [[1, 2]] })), 0.5)
check('history never moves the dim', solarDimFactor(state({ batteryPowerW: -300, source: 'battery', history: [[1]] })), SOLAR_BATTERY_DIM)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.error('FIXTURE MATRIX FAILED')
  process.exit(1)
}
console.log('Fixture matrix matches the design exactly.')
