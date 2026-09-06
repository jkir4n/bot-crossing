/**
 * Verify the kit nodes the power zone is built from.
 *
 * The zone composes its array/battery/station/fence out of KayKit's Space Base
 * Bits by node name, so a re-packed spacebase.glb that renames or drops one
 * would throw at runtime, mid-frame. This fails the build instead: it runs as
 * the last step of `npm run assets` (which `npm run build` always runs first),
 * against the same checked-in glb the browser loads.
 *
 * Exit 1 listing every missing node. The list mirrors POWER_NODES in
 * src/world/power-zone.js plus the town-shared nodes the zone does not own —
 * the roof-panel node behind the old town glint (the low turbine pair used
 * to be town-only; since tweak-2 the rooftop fan owns them too, so they ride
 * in POWER_NODES and are listed twice) — keep the two in lockstep.
 *
 * Then the beacon-anchor regression: the mast lamp seat (BEACON_SEAT, pure
 * data in src/game/solar.js) is checked against the packed triangles in the
 * rig composer's frame — the head's inner face must lie flush on steel, and
 * the head must hang whole below the measured rotor floor and outside the
 * swept cylinder. A re-packed mast that moves the steel fails here, not as
 * a floating cube mid-frame.
 */
import { NodeIO } from '@gltf-transform/core'
import { POWER_NODES } from '../src/world/power-zone.js'
import { BEACON_SEAT } from '../src/game/solar.js'

/** Composer offsets the rig recipe owns (TOWER_Y + fan hub in power-zone.js). */
const TOWER_Y = 2.0
const FAN_HUB_LOCAL_Y = 0.89

const fail = (msg) => {
  console.error(`verify-power-nodes: ${msg}`)
  process.exit(1)
}

const WANTED = [...new Set([...POWER_NODES, 'roofmodule_solarpanels', 'windturbine_low', 'windturbine_low_fan'])]

const doc = await new NodeIO().read('public/assets/spacebase.glb')
const have = new Set()
for (const node of doc.getRoot().listNodes()) have.add(node.getName())

const missing = WANTED.filter((n) => !have.has(n))
if (missing.length) {
  fail(`missing from public/assets/spacebase.glb: ${missing.join(', ')}`)
}
console.log(`verify-power-nodes: ${WANTED.length}/${have.size} zone nodes present`)

// ── beacon anchor against the packed triangles ───────────────────────────
//
// Kit nodes ship unrotated at unit scale, so packed frames are composer
// frames modulo the recipe's translate (mast +TOWER_Y, fan +hub). Vertices
// alone cannot prove a seat: the lattice keeps few of them where the lamp
// sits, so the head's inner face is measured against triangle surfaces.

const byName = new Map()
for (const node of doc.getRoot().listNodes()) byName.set(node.getName(), node)

const RIG_OFFSET = { drill_structure: 0, drill_module: 1, windturbine_low: TOWER_Y, windturbine_low_fan: TOWER_Y + FAN_HUB_LOCAL_Y }
const rigTris = []
for (const [name, dy] of Object.entries(RIG_OFFSET)) {
  const mesh = byName.get(name)?.getMesh()
  if (!mesh) fail(`${name}: no packed mesh to measure the beacon seat against`)
  for (const prim of mesh.listPrimitives()) {
    const arr = prim.getAttribute('POSITION').getArray()
    const at = (i) => [arr[i * 3], arr[i * 3 + 1] + dy, arr[i * 3 + 2]]
    const idx = prim.getIndices()?.getArray()
    if (idx) {
      for (let i = 0; i < idx.length; i += 3) rigTris.push([at(idx[i]), at(idx[i + 1]), at(idx[i + 2])])
    } else {
      for (let i = 0; i < prim.getAttribute('POSITION').getCount(); i += 3) rigTris.push([at(i), at(i + 1), at(i + 2)])
    }
  }
}

// Closest point on triangle to p (RTCD 5.1.5).
const closestOnTri = (p, a, b, c) => {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b)
  const d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const w = d1 / (d1 - d3)
    return [a[0] + ab[0] * w, a[1] + ab[1] * w, a[2] + ab[2] * w]
  }
  const cp = sub(p, c)
  const d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]
  }
  const denom = 1 / (va + vb + vc)
  const w = vb * denom, u = vc * denom
  return [a[0] + ab[0] * w + ac[0] * u, a[1] + ab[1] * w + ac[1] * u, a[2] + ab[2] * w + ac[2] * u]
}
const triDist = (p) => {
  let best = Infinity
  for (const [a, b, c] of rigTris) {
    const q = closestOnTri(p, a, b, c)
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    if (d < best) best = d
  }
  return best
}

const { head } = BEACON_SEAT
const half = head.size / 2
const inner = head.x - half
// The whole inner face must lie on steel — flush, not floating, not buried.
let faceWorst = 0
for (let i = 0; i < 5; i++) {
  for (let j = 0; j < 5; j++) {
    faceWorst = Math.max(faceWorst, triDist([inner, head.y - half + (2 * half * i) / 4, -half + (2 * half * j) / 4]))
  }
}
if (!(faceWorst <= 0.02)) fail(`lamp inner face stands ${faceWorst.toFixed(2)} off the steel (flush is <= 0.02)`)
const centerClear = triDist([head.x, head.y, 0])
if (!(centerClear >= 0.03)) fail(`lamp head center is ${centerClear.toFixed(2)} into the steel (swallowed, not seated)`)

// The head must hang on the mast body, whole below the measured rotor floor
// and outside the swept cylinder about the hub — reach from fan vertices.
const fanPts = []
{
  const mesh = byName.get('windturbine_low_fan').getMesh()
  for (const prim of mesh.listPrimitives()) {
    const arr = prim.getAttribute('POSITION').getArray()
    for (let i = 0; i < prim.getAttribute('POSITION').getCount(); i++) {
      fanPts.push([arr[i * 3], arr[i * 3 + 1]])
    }
  }
}
const hubY = TOWER_Y + FAN_HUB_LOCAL_Y
const reach = Math.max(...fanPts.map(([x, y]) => Math.hypot(x, y)))
const headTop = head.y + half
if (!(head.y - half > TOWER_Y && headTop < hubY - reach)) {
  fail(`lamp head [${(head.y - half).toFixed(2)}..${headTop.toFixed(2)}] leaves the mast body or enters the sweep floor ${(hubY - reach).toFixed(2)}`)
}
const cornerClear = Math.hypot(inner, headTop - hubY)
if (!(cornerClear > reach)) fail(`lamp head inner-top corner ${cornerClear.toFixed(2)} inside the measured blade reach ${reach.toFixed(2)}`)
console.log(`verify-power-nodes: beacon seat flush (face off ${faceWorst.toFixed(3)}) and rotor-clear (reach ${reach.toFixed(2)}, floor ${(hubY - reach).toFixed(2)})`)
