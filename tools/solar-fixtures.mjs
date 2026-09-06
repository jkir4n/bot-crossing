/**
 * Fixture harness for the solar tile's pure presentation module (src/game/solar.js).
 *
 * Plain node, no imports beyond the module itself — it is dependency-free on purpose.
 * Feeds fake SolarStates through the whole matrix — the three source states, stale and
 * missing payloads, null fields, the glint ceiling — and asserts the visuals land
 * exactly where the design matrix says: glint level, HA clock
 * target, the one-line readout, and the power zone's fill/lit-count/guard/glow/spin/flow helpers.
 * The mast-lamp beacon asserts through the same door: one pattern per source word,
 * the rhythm pinned per pattern, and the travelling flow step pinned per current.
 * The power statistics panel asserts through the same door: live-state mapping
 * (nulls to dashes) with spin/glow unchanged. The panel renders live rows only —
 * recorder history stays a backend passthrough the panel never reads.
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
  solarTimeTarget,
  solarReadout,
  batteryFillLevel,
  batteryLitCount,
  batteryBelowCutoff,
  rigGlowOn,
  turbineSpinning,
  batteryFlow,
  beaconPattern,
  beaconLevel,
  beaconBrightness,
  flowPulseIndex,
  hasSolarHistory,
  powerPanel,
  powerHistorySeries,
  SOLAR_GLINT_FULL_W,
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
  haClockTarget: SOLAR_DAY_TARGET,
  text: '☀︎ 1500 W · 82 % · ▲',
  markInText: '▲',
})

scenario(
  '2. battery discharging (evening, HA says battery)',
  state({ isDay: false, solarPowerW: 0, batterySoC: 55, batteryPowerW: -300, source: 'battery' }),
  {
    fresh: true,
    glint: 0,
    haClockTarget: SOLAR_NIGHT_TARGET,
    text: '☀︎ 0 W · 55 % · ▼',
    markInText: '▼',
  }
)

scenario(
  '3. grid mode (after cutoff, mains)',
  state({ isDay: false, solarPowerW: 0, batterySoC: 18, batteryPowerW: 0, source: 'grid' }),
  {
    fresh: true,
    glint: 0,
    haClockTarget: SOLAR_NIGHT_TARGET,
    text: '☀︎ 0 W · 18 % · ▦',
    markInText: '▦',
  }
)

scenario(
  '3b. grid mode with residual battery flow',
  state({ isDay: false, solarPowerW: 0, batterySoC: 19, batteryPowerW: -40, source: 'grid' }),
  { fresh: true, glint: 0, haClockTarget: SOLAR_NIGHT_TARGET, text: '☀︎ 0 W · 19 % · ▦', markInText: '▦' }
)

scenario(
  '4. source=solar with battery draw',
  state({ solarPowerW: 2200, batteryPowerW: -60, source: 'solar' }),
  { fresh: true, glint: 2200 / SOLAR_GLINT_FULL_W, haClockTarget: SOLAR_DAY_TARGET, text: '☀︎ 2200 W · 100 % · ▼', markInText: '▼' }
)

scenario(
  '5. discharging with NO source word stays neutral (null source, no inference)',
  state({ isDay: false, batteryPowerW: -250, batterySoC: 40, source: null }),
  {
    fresh: true,
    glint: 0,
    haClockTarget: SOLAR_NIGHT_TARGET,
    text: '☀︎ 0 W · 40 % · ▼',
    markInText: '▼',
  }
)

scenario('6. stale payload fades everything to neutral', state({ stale: true, lastUpdatedAt: 0, lastError: 'fetch failed' }), {
  fresh: false,
  glint: 0,
  haClockTarget: null,
  text: '☀︎ — · —',
  readoutStale: true,
})

scenario('7. null payload (fetch threw) — same neutral', null, {
  fresh: false,
  glint: 0,
  haClockTarget: null,
  text: '☀︎ — · —',
  readoutStale: true,
})

scenario('8. fresh but backend has no grid entity: honest solar/battery only', state({ source: null, batteryPowerW: 150 }), {
  fresh: true,
  glint: 0,
  haClockTarget: SOLAR_DAY_TARGET,
  text: '☀︎ 0 W · 100 % · ▲',
  markInText: '▲',
})

scenario('9. null fields inside a fresh payload render as em-dashes, never NaN', state({ solarPowerW: null, batterySoC: null, batteryPowerW: null, isDay: null }), {
  fresh: true,
  glint: 0,
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

zone('12. zone battery mode (rig dark + still)', state({ isDay: false, batterySoC: 55, batteryPowerW: -300, cutoff: 20, source: 'battery' }), {
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

// ── power statistics panel ───────────────────────────────────────────────────

function panel(title, solar, expect) {
  console.log(`\n${title}`)
  const v = powerPanel(solar)
  check('  stale', v.stale, expect.stale)
  check('  sourceLabel', v.sourceLabel, expect.sourceLabel)
  check('  solarW', v.solarW, expect.solarW)
  check('  soc', v.soc, expect.soc)
  check('  batteryW', v.batteryW, expect.batteryW)
  check('  flowLabel', v.flowLabel, expect.flowLabel)
  check('  cutoff', v.cutoff, expect.cutoff)
  check('  cutIn', v.cutIn, expect.cutIn)
  check('  gridLine', v.gridLine, expect.gridLine)
  check('  subline', expect.stale ? v.subline : v.subline.startsWith('live'), expect.stale ? 'stale — showing neutral' : true)
}

panel('17. panel live (solar surplus, charging)', state({ solarPowerW: 1500, batteryPowerW: 400, batterySoC: 82, cutoff: 20, cutIn: 50, source: 'solar' }), {
  stale: false, sourceLabel: 'Solar', solarW: '1500 W', soc: '82 %', batteryW: '400 W · charging',
  flowLabel: 'Charging', cutoff: '20 %', cutIn: '50 %', gridLine: 'On own power',
})

panel('18. panel grid mode (mains, thresholds as HA reports them)', state({ isDay: false, solarPowerW: 0, batterySoC: 18, batteryPowerW: 0, cutoff: 20, cutIn: 50, source: 'grid' }), {
  stale: false, sourceLabel: 'Grid', solarW: '0 W', soc: '18 %', batteryW: '0 W · idle',
  flowLabel: 'Idle', cutoff: '20 %', cutIn: '50 %', gridLine: 'Grid connected',
})

panel('19. panel nulls render as em dashes, never NaN', state({ solarPowerW: null, batterySoC: null, batteryPowerW: null, cutoff: null, cutIn: null, source: null, isDay: null }), {
  stale: false, sourceLabel: '—', solarW: '—', soc: '—', batteryW: '—',
  flowLabel: '—', cutoff: '—', cutIn: '—', gridLine: '—',
})

panel('20. panel stale (everything neutral)', state({ stale: true, lastUpdatedAt: 0, lastError: 'fetch failed' }), {
  stale: true, sourceLabel: '—', solarW: '—', soc: '—', batteryW: '—',
  flowLabel: '—', cutoff: '—', cutIn: '—', gridLine: '—',
})

panel('21. panel null payload (same neutral)', null, {
  stale: true, sourceLabel: '—', solarW: '—', soc: '—', batteryW: '—',
  flowLabel: '—', cutoff: '—', cutIn: '—', gridLine: '—',
})

console.log('\n22. recorder history parses raw samples only (panel renders none of it)')
const histSolar = state({
  solarPowerW: 1500, batteryPowerW: -60, batterySoC: 81, source: 'solar',
  history: [
    [
      { entity_id: 'sensor.solar_power', state: '100', last_changed: 't0' },
      { entity_id: 'sensor.solar_power', state: '200', last_changed: 't1' },
      { entity_id: 'sensor.solar_power', state: '300', last_changed: 't2' },
    ],
    [
      { entity_id: 'sensor.battery_soc', state: '80.5', last_changed: 't0' },
      { entity_id: 'sensor.battery_soc', state: 'unavailable', last_changed: 't1' },
      { entity_id: 'sensor.battery_soc', state: '81', last_changed: 't2' },
    ],
  ],
})
const hseries = powerHistorySeries(histSolar)
check('  series count', hseries.length, 2)
check('  first id verbatim', hseries[0].id, 'sensor.solar_power')
check('  raw order, no averaging', JSON.stringify(hseries[0].points), JSON.stringify([100, 200, 300]))
check('  non-numeric drops out', JSON.stringify(hseries[1].points), JSON.stringify([80.5, 81]))
check('  history never moves the panel numbers', powerPanel(histSolar).solarW, '1500 W')
check('  empty history array reads as no series', powerHistorySeries(state({ history: [] })).length, 0)
check('  non-array history reads as no series', powerHistorySeries(state({ history: { samples: [] } })).length, 0)
check('  absent history reads as no series', powerHistorySeries(state()).length, 0)
// Spin/glow unchanged by the panel: same single HA source word, same answers.
check('  glow on panel grid payload is on', rigGlowOn(state({ source: 'grid' })), true)
check('  spin on panel grid payload turns', turbineSpinning(state({ source: 'grid' })), true)
check('  glow on panel solar payload is dark', rigGlowOn(state({ source: 'solar' })), false)
check('  spin on panel solar payload is still', turbineSpinning(state({ source: 'solar' })), false)

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
check('batteryPowerW NaN draws no arrow', !/[▲▼]/.test(solarReadout(state({ batteryPowerW: Number.NaN })).text), true)
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
// Bank row: SoC quartiles onto 4 blocks, west to east (0-25/25-50/50-75/75-100 -> 1/2/3/4 lit).
check('bank default arity is 4 blocks', batteryLitCount(state({ batterySoC: 50 })), 2)
check('bank null SoC lights none', batteryLitCount(state({ batterySoC: null }), 4), 0)
check('bank stale lights none', batteryLitCount(state({ stale: true, batterySoC: 90 }), 4), 0)
check('bank 0% lights none', batteryLitCount(state({ batterySoC: 0 }), 4), 0)
check('bank 10% lights none', batteryLitCount(state({ batterySoC: 10 }), 4), 0)
check('bank 13% lights one', batteryLitCount(state({ batterySoC: 13 }), 4), 1)
check('bank 25% lights one', batteryLitCount(state({ batterySoC: 25 }), 4), 1)
check('bank 38% lights two', batteryLitCount(state({ batterySoC: 38 }), 4), 2)
check('bank 50% lights two', batteryLitCount(state({ batterySoC: 50 }), 4), 2)
check('bank 63% lights three', batteryLitCount(state({ batterySoC: 63 }), 4), 3)
check('bank 75% lights three', batteryLitCount(state({ batterySoC: 75 }), 4), 3)
check('bank 88% lights four', batteryLitCount(state({ batterySoC: 88 }), 4), 4)
check('bank 100% lights four', batteryLitCount(state({ batterySoC: 100 }), 4), 4)
check('bank clamps above full', batteryLitCount(state({ batterySoC: 140 }), 4), 4)
check('bank clamps below empty', batteryLitCount(state({ batterySoC: -4 }), 4), 0)
check('empty history array reads as absent', hasSolarHistory(state({ history: [] })), false)
check('non-array history reads as absent', hasSolarHistory(state({ history: { samples: [] } })), false)
check('history never moves the glint', solarGlintLevel(state({ solarPowerW: 1500, history: [[1, 2]] })), 0.5)

// ── mast beacon + flow pulse ──────────────────────────────────────────────────

console.log('\n23. beacon pattern follows the source word only (stale/null/unknown read dark)')
check('grid reads double-flash', beaconPattern(state({ source: 'grid' })), 'double-flash')
check('battery reads pulse', beaconPattern(state({ source: 'battery' })), 'pulse')
check('solar reads steady', beaconPattern(state({ source: 'solar' })), 'steady')
check('null source reads dark', beaconPattern(state({ source: null })), 'dark')
check('missing source reads dark', beaconPattern(state({})), 'dark')
check('unknown source word reads dark', beaconPattern(state({ source: 'mains' })), 'dark')
check('stale grid reads dark', beaconPattern(state({ source: 'grid', stale: true })), 'dark')
check('null payload reads dark', beaconPattern(null), 'dark')

console.log('\n24. beacon rhythms pinned per pattern (double flash / slow pulse / steady / dark)')
check('double-flash first pulse on', beaconLevel('double-flash', 0.05), 1)
check('double-flash gap between pulses', beaconLevel('double-flash', 0.2), 0)
check('double-flash second pulse on', beaconLevel('double-flash', 0.35), 1)
check('double-flash trailing edge', beaconLevel('double-flash', 0.5), 0)
check('double-flash long pause stays dark', beaconLevel('double-flash', 1.5), 0)
check('double-flash wraps to the next period', beaconLevel('double-flash', 2.85), 1)
check('double-flash rests dark without a clock', beaconLevel('double-flash', Number.NaN), 0)
check('pulse starts from its dim base', beaconLevel('pulse', 0), 0.06)
check('pulse swells mid-beat', Math.abs(beaconLevel('pulse', 0.8) - 0.66) < 1e-9, true)
check('pulse rests at base between beats', beaconLevel('pulse', 2.5), 0.06)
check('pulse rests at base without a clock', beaconLevel('pulse', Number.NaN), 0.06)
check('steady holds its soft glow', beaconLevel('steady', 123.4), 0.55)
check('dark holds at any clock', beaconLevel('dark', 0.05), 0)
check('unknown pattern never flashes', beaconLevel('strobe', 0.05), 0)
check('grid payload flashes end to end', beaconBrightness(state({ source: 'grid' }), 0.05), 1)
check('grid payload pauses end to end', beaconBrightness(state({ source: 'grid' }), 1.5), 0)
check('battery payload rests end to end', beaconBrightness(state({ source: 'battery', batteryPowerW: -300 }), 2.5), 0.06)
check('solar payload glows end to end', beaconBrightness(state({ source: 'solar' }), 9.9), 0.55)
check('stale payload never lights end to end', beaconBrightness(state({ source: 'grid', stale: true }), 0.05), 0)
check('null payload never lights end to end', beaconBrightness(null, 0.05), 0)

console.log('\n25. flow pulse walks the row with the current (discharge west->east, charge back)')
check('discharge starts west', flowPulseIndex(state({ batteryPowerW: -300, source: 'battery' }), 0), 0)
check('discharge steps east', flowPulseIndex(state({ batteryPowerW: -300, source: 'battery' }), 1.5), 1)
check('discharge reaches far east', flowPulseIndex(state({ batteryPowerW: -300, source: 'battery' }), 4.3), 3)
check('discharge wraps to west', flowPulseIndex(state({ batteryPowerW: -300, source: 'battery' }), 5.7), 0)
check('charge starts east', flowPulseIndex(state({ batteryPowerW: 400, source: 'solar' }), 0), 3)
check('charge steps west', flowPulseIndex(state({ batteryPowerW: 400, source: 'solar' }), 1.5), 2)
check('charge reaches far west', flowPulseIndex(state({ batteryPowerW: 400, source: 'solar' }), 4.3), 0)
check('idle shows no step', flowPulseIndex(state({ batteryPowerW: 0, source: 'grid' }), 1.5), -1)
check('null watts show no step', flowPulseIndex(state({ batteryPowerW: null }), 1.5), -1)
check('stale shows no step', flowPulseIndex(state({ batteryPowerW: -300, stale: true }), 0.5), -1)
check('null payload shows no step', flowPulseIndex(null, 0.5), -1)
check('no clock shows no step', flowPulseIndex(state({ batteryPowerW: -300 }), Number.NaN), -1)
check('empty row shows no step', flowPulseIndex(state({ batteryPowerW: -300 }), 1.5, 0), -1)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.error('FIXTURE MATRIX FAILED')
  process.exit(1)
}
console.log('Fixture matrix matches the design exactly.')
