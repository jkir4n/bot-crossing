/**
 * server/ha-solar.mjs — Home Assistant solar/battery/grid poller (fork-only).
 *
 * Own fetch loop, own state, own timer. Structural isolation from the thread
 * scan: this module imports NOTHING from scan.mjs or server/harnesses/, and
 * nothing there imports this. A dead HA degrades only GET /api/solar.
 *
 * SolarState contract (pinned with the renderer — change only in lockstep):
 *   { isDay, solarPowerW, batterySoC, batteryPowerW,
 *     cutoff, cutIn, source, stale, lastUpdatedAt, lastError }
 *   isDay: boolean|null — from HA sun.sun elevation; solar-W hysteresis fallback
 *   solarPowerW: number|null — W, >= 0
 *   batterySoC: number|null — %, 0..100
 *   batteryPowerW: number|null — W, NEGATIVE = discharging (JK BMS convention)
 *   cutoff: number|null — pass-through of the grid-connect SoC threshold
 *     (HA number entity: grid connects / battery cuts OUT at SoC <= cutoff)
 *   cutIn: number|null — pass-through of the grid-disconnect SoC threshold
 *     (HA number entity: grid releases / battery cuts back IN at SoC >= cutIn)
 *     Semantics recorded 2026-09-06 against live values (connect=20.0,
 *     disconnect=50.0, SoC=100, battery charging, grid 0W): consistent, but a
 *     full cut-over cycle has not been watched — labels are HA's, we pass them
 *     through and never infer from them.
 *   source: 'solar'|'battery'|'grid'|null — comes FROM HA's grid/mode entity
 *     value (string-mapped). The colony derives nothing: unconfigured, missing,
 *     numeric, or unrecognised grid entity => null, and the UI shows honestly
 *     only what HA provides.
 *   stale: boolean — true until first success; true after HA_STALE_AFTER
 *     consecutive failed rounds (401/403 goes stale immediately, once).
 *   lastUpdatedAt: epoch ms of last successful round, 0 if never.
 *   lastError: last failure message, null if none.
 *
 * Config (operator environment, never the repo):
 *   HA_BASE_URL / HA_TOKEN — absent => poller disabled, neutral state forever.
 *   HA_SOLAR_POWER_ENTITY / HA_BATTERY_SOC_ENTITY / HA_BATTERY_POWER_ENTITY
 *   HA_SUN_ENTITY (default sun.sun) / HA_GRID_ENTITY (default empty = source null)
 *   HA_CUTOFF_ENTITY / HA_CUTIN_ENTITY (threshold pass-through, optional fields)
 *   HA_POLL_MS (60000) / HA_TIMEOUT_MS (5000) / HA_STALE_AFTER (2)
 *   HA_SOLAR_DAY_ON_W (20) / HA_SOLAR_DAY_OFF_W (15) — isDay fallback only.
 */

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const cfg = () => ({
  baseUrl: (process.env.HA_BASE_URL || '').replace(/\/+$/, ''),
  token: process.env.HA_TOKEN || '',
  solarEntity: process.env.HA_SOLAR_POWER_ENTITY || 'sensor.power_production_now',
  socEntity: process.env.HA_BATTERY_SOC_ENTITY || 'sensor.stair_room_jk_bms_jk_bms_state_of_charge',
  powerEntity: process.env.HA_BATTERY_POWER_ENTITY || 'sensor.jk_bms_jk_bms_power',
  sunEntity: process.env.HA_SUN_ENTITY || 'sun.sun',
  gridEntity: process.env.HA_GRID_ENTITY || '',
  cutoffEntity: process.env.HA_CUTOFF_ENTITY || 'number.grid_input_grid_connect_soc_threshold',
  cutinEntity: process.env.HA_CUTIN_ENTITY || 'number.grid_input_grid_disconnect_soc_threshold',
  pollMs: Math.max(5000, num(process.env.HA_POLL_MS, 60000)),
  timeoutMs: Math.max(1000, num(process.env.HA_TIMEOUT_MS, 5000)),
  staleAfter: Math.max(1, Math.floor(num(process.env.HA_STALE_AFTER, 2))),
  dayOnW: num(process.env.HA_SOLAR_DAY_ON_W, 20),
  dayOffW: num(process.env.HA_SOLAR_DAY_OFF_W, 15),
});

const neutral = (lastError = null) => ({
  isDay: null,
  solarPowerW: null,
  batterySoC: null,
  batteryPowerW: null,
  cutoff: null,
  cutIn: null,
  source: null,
  stale: true,
  lastUpdatedAt: 0,
  lastError,
});

let state = neutral();
let timer = null;
let inFlight = false;
let failures = 0;
let staleNotified = false;
let started = false;
let warnedEntities = new Set();
let authDeadLogged = false;

const TAG = 'bot-crossing: ha-solar:';

/** HA reads 'unavailable'/'unknown' as strings — those parse to null, never NaN. */
function parseNumeric(entity) {
  if (!entity || typeof entity.state !== 'string') return null;
  const raw = entity.state.trim().toLowerCase();
  if (raw === '' || raw === 'unknown' || raw === 'unavailable' || raw === 'none') return null;
  const n = Number(entity.state);
  if (!Number.isFinite(n)) return null;
  const unit = String(entity.attributes?.unit_of_measurement || '').trim().toLowerCase();
  if (unit === 'kw' || unit === 'kilowatt') return n * 1000;
  if (unit === 'mw' || unit === 'megawatt') return n * 1000000;
  return n; // W, %, and unitless counts pass through as-is
}

/**
 * source comes FROM HA, never derived. Only an explicit mode string maps;
 * numeric grid watts (e.g. sensor.grid_input_grid_power) or anything
 * unrecognised => null — a guessed 'grid' state would be dishonest.
 */
function parseSource(entity) {
  if (!entity || typeof entity.state !== 'string') return null;
  const s = entity.state.trim().toLowerCase();
  if (s === '' || s === 'unknown' || s === 'unavailable' || s === 'none') return null;
  if (Number.isFinite(Number(s))) return null;
  if (/(^|[^a-z])solar([^a-z]|$)|(^|[^a-z])pv([^a-z]|$)/.test(s)) return 'solar';
  if (s.includes('battery') || s.includes('bat ')) return 'battery';
  if (s.includes('grid') || s.includes('mains') || s.includes('utility') || s.includes('bypass')) return 'grid';
  return null;
}

function parseIsDay(sunEntity, solarW, prev) {
  const elev = sunEntity ? Number(sunEntity.attributes?.elevation) : NaN;
  if (Number.isFinite(elev)) {
    if (elev > 0) return true;
    if (elev < 0) return false;
    return prev; // exactly on the horizon: hold
  }
  // Fallback only: production-W hysteresis (an overcast midday must use sun.sun).
  const { dayOnW, dayOffW } = cfg();
  if (solarW !== null) {
    if (solarW > dayOnW) return true;
    if (solarW < dayOffW) return false;
  }
  return prev;
}

async function fetchEntity(base, token, timeoutMs, id) {
  const res = await fetch(`${base}/api/states/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`HA rejected the token (HTTP ${res.status}) — check HA_TOKEN`);
    err.code = 'HA_AUTH';
    throw err;
  }
  if (res.status === 404) {
    const err = new Error(`HA entity not found: ${id} — renamed device? fix env, restart`);
    err.code = 'HA_MISSING';
    err.entity = id;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HA HTTP ${res.status} for ${id}`);
    err.code = 'HA_HTTP';
    throw err;
  }
  return res.json();
}

function warnOnce(key, msg) {
  if (warnedEntities.has(key)) return;
  warnedEntities.add(key);
  console.warn(`${TAG}${msg}`);
}

/** One REST round: fetch every configured entity, fold into SolarState. */
export async function fetchOnce() {
  const c = cfg();
  if (!c.baseUrl || !c.token) {
    state = { ...neutral('HA not configured'), lastUpdatedAt: state.lastUpdatedAt };
    return { ...state };
  }
  if (inFlight) return { ...state }; // skip a tick — never stack on a slow HA
  inFlight = true;
  try {
    const ids = [c.solarEntity, c.socEntity, c.powerEntity, c.sunEntity];
    if (c.gridEntity) ids.push(c.gridEntity);
    if (c.cutoffEntity) ids.push(c.cutoffEntity);
    if (c.cutinEntity) ids.push(c.cutinEntity);
    const got = {};
    const problems = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          got[id] = await fetchEntity(c.baseUrl, c.token, c.timeoutMs, id);
        } catch (err) {
          got[id] = null;
          problems.push(err);
        }
      }),
    );

    const authDead = problems.find((e) => e.code === 'HA_AUTH');
    if (authDead) {
      // Dead token: one clear line + neutral now, not a crash loop.
      if (!authDeadLogged) {
        authDeadLogged = true;
        console.warn(`${TAG}${authDead.message}`);
      }
      failures += 1;
      const keepUpdatedAt = state.lastUpdatedAt;
      state = { ...neutral(authDead.message), lastUpdatedAt: keepUpdatedAt };
      return { ...state };
    }
    authDeadLogged = false;

    for (const p of problems) {
      if (p.code === 'HA_MISSING') warnOnce(`missing:${p.entity}`, ` ${p.message}`);
    }

    const solarW = parseNumeric(got[c.solarEntity]);
    const soc = parseNumeric(got[c.socEntity]);
    const battW = parseNumeric(got[c.powerEntity]);
    const cutoff = c.cutoffEntity ? parseNumeric(got[c.cutoffEntity]) : null;
    const cutIn = c.cutinEntity ? parseNumeric(got[c.cutinEntity]) : null;
    const source = c.gridEntity ? parseSource(got[c.gridEntity]) : null;

    if (c.gridEntity && got[c.gridEntity] && source === null) {
      warnOnce(`grid:${c.gridEntity}`, ` grid entity ${c.gridEntity} has no mappable mode value (state=${JSON.stringify(got[c.gridEntity].state)}) — source stays null, no guessing`);
    }
    if (c.cutoffEntity && got[c.cutoffEntity] && cutoff === null) {
      warnOnce(`cutoff:${c.cutoffEntity}`, ` threshold entity ${c.cutoffEntity} unreadable (state=${JSON.stringify(got[c.cutoffEntity].state)}) — cutoff stays null`);
    }
    if (c.cutinEntity && got[c.cutinEntity] && cutIn === null) {
      warnOnce(`cutin:${c.cutinEntity}`, ` threshold entity ${c.cutinEntity} unreadable (state=${JSON.stringify(got[c.cutinEntity].state)}) — cutIn stays null`);
    }

    const requiredOk = solarW !== null && soc !== null && battW !== null;
    if (!requiredOk) {
      failures += 1;
      const msg = `incomplete round (stale after ${c.staleAfter} consecutive failures): ` +
        [solarW === null && c.solarEntity, soc === null && c.socEntity, battW === null && c.powerEntity]
          .filter(Boolean).join(', ');
      if (failures >= c.staleAfter) {
        if (!staleNotified) {
          staleNotified = true;
          console.warn(`${TAG}stale — ${msg}`);
        }
        const keepUpdatedAt = state.lastUpdatedAt;
        state = { ...neutral(msg), lastUpdatedAt: keepUpdatedAt };
      }
      // Single blip: keep last good values, stale:false.
      return { ...state };
    }

    failures = 0;
    staleNotified = false;
    const recovered = state.stale && state.lastUpdatedAt > 0;
    state = {
      isDay: parseIsDay(got[c.sunEntity], solarW, state.isDay),
      solarPowerW: Math.max(0, Math.round(solarW)),
      batterySoC: Math.round(Math.min(100, Math.max(0, soc)) * 10) / 10,
      batteryPowerW: Math.round(battW),
      cutoff: cutoff === null ? null : Math.round(cutoff * 10) / 10,
      cutIn: cutIn === null ? null : Math.round(cutIn * 10) / 10,
      source,
      stale: false,
      lastUpdatedAt: Date.now(),
      lastError: null,
    };
    if (recovered) console.log(`${TAG}recovered — fresh values`);
    return { ...state };
  } finally {
    inFlight = false;
  }
}

/** Never throws; the /api/solar route depends on that. */
export function getSolarState() {
  try {
    return { ...state };
  } catch {
    return neutral('state read failed');
  }
}

/** Idempotent start. Disabled without HA_BASE_URL/HA_TOKEN — logs once. */
export function startPolling() {
  if (started) return;
  started = true;
  const c = cfg();
  if (!c.baseUrl || !c.token) {
    state = neutral('HA not configured');
    console.log(`${TAG}disabled (no HA_BASE_URL/HA_TOKEN) — /api/solar serves neutral`);
    return;
  }
  console.log(`${TAG}polling ${c.pollMs}ms: ${c.solarEntity}, ${c.socEntity}, ${c.powerEntity} (+sun/thresholds)`);
  fetchOnce().catch((err) => console.warn(`${TAG}first round failed — ${err?.message || err}`));
  timer = setInterval(() => {
    fetchOnce().catch((err) => console.warn(`${TAG}round failed — ${err?.message || err}`));
  }, c.pollMs);
  if (timer.unref) timer.unref();
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
