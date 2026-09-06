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
 * src/world/power-zone.js plus the roof-panel node the town's old glint used —
 * keep the two in lockstep.
 */
import { NodeIO } from '@gltf-transform/core'
import { POWER_NODES } from '../src/world/power-zone.js'

const WANTED = [...new Set([...POWER_NODES, 'roofmodule_solarpanels', 'windturbine_low', 'windturbine_low_fan'])]

const doc = await new NodeIO().read('public/assets/spacebase.glb')
const have = new Set()
for (const node of doc.getRoot().listNodes()) have.add(node.getName())

const missing = WANTED.filter((n) => !have.has(n))
if (missing.length) {
  console.error(`verify-power-nodes: missing from public/assets/spacebase.glb: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`verify-power-nodes: ${WANTED.length}/${have.size} zone nodes present`)
