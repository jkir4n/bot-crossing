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
 * Then the beacon-anchor regression: the sphere-on-a-goalpost seat
 * (BEACON_SEAT, pure data in src/game/solar.js) is checked against the packed
 * triangles in the rig composer's frame — the side mast foot must sit on the
 * structure roof (buried, never floating) standing off the cage sweep, the
 * overarm must ride above the measured sweep ceiling, and the sphere must sit
 * exactly on the arm on the axis, belly above the sweep and between the discs.
 * Rotor clearance is measured against the SWEPT volume (rotation preserves
 * each point's z and its radius about the hub, so per-triangle z/r intervals
 * decide), not against the unrotated pose. A re-packed kit that moves the
 * steel fails here, not as a floating sphere mid-frame.
 */
import { NodeIO } from '@gltf-transform/core'
import { POWER_NODES } from '../src/world/power-zone.js'
import { BEACON_SEAT, MAST_GEOMETRY } from '../src/game/solar.js'

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
// frames modulo the recipe's translate (mast +TOWER_Y, fan +hub, structure
// at 0, module +1). The fan is a drum cage — twin discs joined by shroud
// plates that sweep through the axis — so clearances are measured against
// the swept volume: a z-spin preserves each point's z and its radius about
// the hub, hence per-triangle z/r intervals (max radius over a triangle is
// always a vertex) decide whether the sweep can reach the side mast.

const byName = new Map()
for (const node of doc.getRoot().listNodes()) byName.set(node.getName(), node)

const HUB_Y = TOWER_Y + FAN_HUB_LOCAL_Y
const collectTris = (name, dy) => {
  const tris = []
  const mesh = byName.get(name)?.getMesh()
  if (!mesh) fail(`${name}: no packed mesh to measure the beacon seat against`)
  for (const prim of mesh.listPrimitives()) {
    const arr = prim.getAttribute('POSITION').getArray()
    const at = (i) => [arr[i * 3], arr[i * 3 + 1] + dy, arr[i * 3 + 2]]
    const idx = prim.getIndices()?.getArray()
    if (idx) {
      for (let i = 0; i < idx.length; i += 3) tris.push([at(idx[i]), at(idx[i + 1]), at(idx[i + 2])])
    } else {
      for (let i = 0; i < prim.getAttribute('POSITION').getCount(); i += 3) tris.push([at(i), at(i + 1), at(i + 2)])
    }
  }
  return tris
}
const mastTris = collectTris('windturbine_low', TOWER_Y)
const fanTris = collectTris('windturbine_low_fan', HUB_Y)
const structTris = [...collectTris('drill_structure', 0), ...collectTris('drill_module', 1)]
const rigTris = [...mastTris, ...fanTris, ...structTris]
if (!fanTris.length) fail('no fan triangles found — cannot measure the sweep')

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
const triDistTo = (tris, p) => {
  let best = Infinity
  for (const [a, b, c] of tris) {
    const q = closestOnTri(p, a, b, c)
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    if (d < best) best = d
  }
  return best
}

const { center, radius, pole, arm } = BEACON_SEAT
const bottom = center.y - radius
const top = center.y + radius
// Mounted by construction: the sphere belly on the arm, the mast into the arm.
if (Math.abs(bottom - arm.y1) > 1e-9) fail(`sphere belly ${bottom} leaves the overarm ${arm.y1}`)
if (Math.abs(pole.topY - arm.y1) > 1e-9) fail(`side mast tip ${pole.topY} leaves the overarm ${arm.y1}`)
if (!(arm.x0 <= center.x && center.x <= pole.x && pole.x <= arm.x1)) fail('overarm does not span the axis to the side mast')
if (!(pole.baseY <= TOWER_Y)) fail(`side mast foot ${pole.baseY} sits above the structure roof (floating, not buried)`)
// The foot stands on the structure roof: roof steel at the foot point.
const footTouch = triDistTo(structTris, [pole.x, TOWER_Y, pole.z])
if (!(footTouch <= 0.01)) fail(`side mast foot stands ${footTouch.toFixed(2)} off the structure roof (floating, not mounted)`)
// The side mast stands free of the mast flank its whole run (no clipping).
let flankWorst = Infinity
for (let y = pole.baseY; y <= pole.topY; y += 0.1) {
  flankWorst = Math.min(flankWorst, triDistTo(mastTris, [pole.x - pole.radius, y, pole.z]))
}
if (!(flankWorst >= 0.05)) fail(`side mast stands ${flankWorst.toFixed(2)} off the mast flank (clipping the mast)`)
// The sweep, measured: ceiling from blade reach; lane reach from the max
// tri radius whose z-interval touches the side mast's z-lane; blade gap from
// the closest blade-steel vertex to the axis plane. Rotation preserves z and
// hub radius, so a fan triangle threatens the side mast only when its
// z-interval touches the lane AND its max radius (always a vertex) reaches
// the mast's radial clearance. The pure-data constants in solar.js are only
// as honest as these measures, so they are re-checked here, not trusted.
let sweepR = 0
let laneRHi = 0
let bladeMinZ = Infinity
{
  const mesh = byName.get('windturbine_low_fan').getMesh()
  for (const prim of mesh.listPrimitives()) {
    const arr = prim.getAttribute('POSITION').getArray()
    for (let i = 0; i < prim.getAttribute('POSITION').getCount(); i++) {
      const r = Math.hypot(arr[i * 3], arr[i * 3 + 1])
      if (r > sweepR) sweepR = r
      if (r > 0.2 && Math.abs(arr[i * 3 + 2]) < bladeMinZ) bladeMinZ = Math.abs(arr[i * 3 + 2])
    }
  }
}
const laneHalf = Math.abs(pole.z) + pole.radius + 0.03
for (const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] of fanTris) {
  const zLo = Math.min(az, bz, cz), zHi = Math.max(az, bz, cz)
  if (zLo <= laneHalf && zHi >= -laneHalf) {
    const rHi = Math.max(Math.hypot(ax, ay - HUB_Y), Math.hypot(bx, by - HUB_Y), Math.hypot(cx, cy - HUB_Y))
    if (rHi > laneRHi) laneRHi = rHi
  }
}
const sweepTop = HUB_Y + sweepR
if (Math.abs(MAST_GEOMETRY.bladeTopY - sweepTop) > 0.01) fail(`bladeTopY constant ${MAST_GEOMETRY.bladeTopY} left the measured sweep ceiling ${sweepTop.toFixed(2)}`)
if (!(MAST_GEOMETRY.bladeInnerZ <= bladeMinZ)) fail(`bladeInnerZ constant ${MAST_GEOMETRY.bladeInnerZ} wider than the measured blade gap ${bladeMinZ.toFixed(2)}`)
if (!(MAST_GEOMETRY.forkSweepR >= laneRHi)) fail(`forkSweepR constant ${MAST_GEOMETRY.forkSweepR} under the measured lane reach ${laneRHi.toFixed(2)}`)
if (!(pole.x - pole.radius >= MAST_GEOMETRY.forkSweepR + 0.05)) fail(`side mast stands ${pole.x - pole.radius} off the axis against fork sweep ${MAST_GEOMETRY.forkSweepR}`)
const radialClear = Math.hypot(pole.x - pole.radius, 0)
let threatHi = 0
for (const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] of fanTris) {
  const zLo = Math.min(az, bz, cz), zHi = Math.max(az, bz, cz)
  const rHi = Math.max(Math.hypot(ax, ay - HUB_Y), Math.hypot(bx, by - HUB_Y), Math.hypot(cx, cy - HUB_Y))
  if (zLo <= laneHalf && zHi >= -laneHalf && rHi >= radialClear - 0.03) threatHi = Math.max(threatHi, rHi)
}
if (threatHi > 0) fail(`sweep reaches the side mast (rotor steel to radius ${threatHi.toFixed(2)} in the mast lane)`)
// The overarm and the sphere belly ride above the sweep ceiling; the sphere
// sits between the discs and is swallowed by nothing; it crowns the rig.
if (!(arm.y0 >= sweepTop + 0.03)) fail(`overarm ${arm.y0} inside the sweep ceiling ${sweepTop.toFixed(2)}`)
if (!(bottom >= sweepTop + 0.03)) fail(`sphere belly ${bottom.toFixed(2)} inside the sweep ceiling ${sweepTop.toFixed(2)}`)
if (!(Math.abs(center.z) + radius + 0.05 <= bladeMinZ)) fail(`sphere edge ${Math.abs(center.z) + radius} outside the measured blade gap ${bladeMinZ.toFixed(2)}`)
const centerClear = triDistTo(rigTris, [center.x, center.y, center.z])
if (!(centerClear >= radius - 0.01)) fail(`sphere center is ${centerClear.toFixed(2)} off the steel (swallowed, not seated)`)
let rigTop = -Infinity
for (const [a, b, c] of rigTris) for (const v of [a, b, c]) if (v[1] > rigTop) rigTop = v[1]
if (!(top > rigTop && top > sweepTop)) fail(`sphere top ${top.toFixed(2)} below the rig's own steel ${Math.max(rigTop, sweepTop).toFixed(2)}`)
console.log(`verify-power-nodes: beacon seated (foot touch ${footTouch.toFixed(3)}, flank ${flankWorst.toFixed(2)}, sweep ceiling ${sweepTop.toFixed(2)}, blade gap ${bladeMinZ.toFixed(2)}) and highest (${top.toFixed(2)} over steel ${Math.max(rigTop, sweepTop).toFixed(2)})`)
