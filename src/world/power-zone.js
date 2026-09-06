import * as THREE from 'three'
import { Plot, createLabel, POWER_CELL, DECK_TOP, PLOT_CELL } from './plots.js'
import {
  Composer,
  decorate,
  structureUniforms,
  buildingUniforms,
  BUILDING_SCALE,
} from './buildings.js'
import { part, hasPart, atlasTexture } from './kit.js'
import { mulberry } from './planet.js'
import {
  solarGlintLevel,
  batteryLitCount,
  batteryBelowCutoff,
  rigGlowOn,
  turbineSpinning,
  batteryFlow,
} from '../game/solar.js'

/**
 * The power zone — one quiet fenced plot on the colony edge that shows what
 * the house's energy is doing, in the colony's own building language.
 *
 * Ground: a real Plot (deck, kerb, lamp post, clutter), so the tile rhythm is
 * the tile rhythm, not an imitation of it. Structures: kit parts through the
 * same Composer + reveal-shader path as every other building — no new models,
 * no new colours, no new material path.
 *
 * Tile plan (plot-local scene units, default camera at azimuth 45°):
 *   west  solar array, pure 3x2 `solarpanel` rows — nothing else in its box
 *   back  battery bank, four `cargo_A` blocks in one 1x4 row, west-to-east
 *         fill order, fronts to the walkway
 *   front-east  first rig, clear of the bank's sightline from the default camera
 *   mid-west    second rig, opposite the first across the tile — the open
 *               middle strip's west end, clear of the walkway centre
 *   kerb  containers / small depot / lights as scenery, all inside the deck
 *
 *   solar array  rows of `solarpanel`; live output glints on the panel cells
 *                of THIS mesh only (its own uGlint — town glass stays dark)
 *   battery bank four double-scale `cargo_A` blocks in a straight row — the
 *                bank IS the gauge, so four batteries read as one row. Block
 *                i (west to east) lights for its quartile, one per 25 % SoC,
 *                brighter while charging; at or under HA's cutoff the row
 *                dims and the empty blocks carry a faint guard glow
 *   rigs         two `drill_structure` + `drill_module` bases, each with a
 *                `windturbine_low` mast on its roof and that mast's fan on
 *                top — one composite silhouette each, same recipe twice. Grid
 *                mode reads twice on BOTH: each composite carries a steady
 *                POWER_ACCENT emissive AND its fan turns, both if and only if
 *                HA names grid — dark and still on solar, battery, null,
 *                stale. No second behavior, no fake states.
 *   fence        containers / cargodepot / lights ringing the kerb as scenery
 *
 * Clearances were measured from the glb's own bounding boxes in scene units
 * (0.5+ between structures, 0.8+ to scenery, every corner inside the hex)
 * and the sightlines checked from the default camera, so neither rig covers
 * the bank or the array. See the tweak-3 handoff for the numbers.
 *
 * Town night lighting stays full bright on every source — no source-based
 * dimming anywhere. The rigs' glow, the bank's fill and the panel glint are
 * the only power story in the colony.
 *
 * Pure display throughout: every target derives from the SolarState via
 * src/game/solar.js. The recorder payload (`history`) is accepted and ignored —
 * the colony never aggregates it, so there is nothing to render from it.
 */

/** Amber, from the plot palette — reads as utility, and repos never take it. */
export const POWER_ACCENT = 0xb8942a
/** Plot id the click path matches on — never the display name. */
export const POWER_PLOT_ID = 'power-zone'
/** Construction seed: the yard is laid out the same on every reload. */
const YARD_SEED = 20260906
/** Rig glow: steady POWER_ACCENT emissive while HA names grid. Calm, no pulse. */
const RIG_GLOW = 0.9
/** Roof plane of the drill structure in pack units — the mast stands on it. */
const TOWER_Y = 2.0
/** Hub height of the low turbine mast, as modelled (matches the town recipe). */
const LOW_HUB = 0.89
/** Rooftop fan cruise: the town masts' slow turn, fixed so every load agrees. */
const FAN_RATE = 0.22
/** Battery bank: four blocks in one straight row, west-to-east fill order. */
const BANK_BLOCKS = 4
/** Block scale: double-size crates read as batteries, still inside the tile. */
const BANK_SCALE = 2.0
/** Row pitch in scene units (blocks are 1.45 wide — a tight single row). */
const BANK_PITCH = 1.6
/** Row centre on the back strip: array/rig clear in z, fence clear all round. */
const BANK_AT = { x: -0.55, z: -2.9 }
/**
 * Second rig spot: the middle strip's west end, opposite the first rig
 * across the tile. Measured box gaps from the glb's own bounding boxes in
 * scene units: 0.5+ to the bank/array, 2.8+ to the first rig, 0.8+ to the
 * fence crates, every corner inside the hex; the walkway centre and the
 * bank's sightline from the default camera stay clear.
 */
const RIG2_AT = { x: -2.4, z: -0.6 }

/** Every kit node this module places. Checked at build time (see tools/). */
export const POWER_NODES = [
  'solarpanel',
  'drill_structure',
  'drill_module',
  'windturbine_low',
  'windturbine_low_fan',
  'cargodepot_A',
  'containers_A',
  'containers_B',
  'containers_C',
  'containers_D',
  'cargo_A',
  'lights',
]

export class PowerZone {
  constructor(settings) {
    this.settings = settings
    for (const name of POWER_NODES) {
      if (!hasPart(name)) throw new Error(`power-zone: kit has no part named "${name}"`)
    }
    // The rig's module rides at its modelled offset above the structure base,
    // and the low mast stands solo on the structure's roof plane.
    part('drill_structure', 'base', { solo: true }).dispose()
    part('drill_module').dispose()
    part('windturbine_low', 'base', { solo: true }).dispose()
    part('windturbine_low_fan').dispose()

    this.solar = null
    this._glint = 0
    this._rigGlow = 0
    // The rigs' shared clock: the vertex shader turns every rotor it sees with
    // the shared uTime, which can never stop for one mesh — so each rig mesh
    // carries a private clock instead, and both rigs read the same object, so
    // the two fans turn and hold mid-pose together. It only advances while HA
    // names grid.
    this._rigClock = { value: 0 }
    this._rigTime = 0
    this._bank = { lit: -1, intensity: -1, guard: null }
    this._dimmed = null

    // The ground: a one-cell Plot that belongs to no repo, so it never enters
    // the legend, the sidebar, the layout file, or the badge system. Its
    // seeded clutter comes off: the fence below dresses the kerb already, and
    // two scatter systems on one tile would stack crates inside the array.
    this.plot = new Plot({ id: POWER_PLOT_ID, name: 'Power', index: -1, cells: [POWER_CELL], accent: POWER_ACCENT })
    if (this.plot.clutter) {
      this.plot.group.remove(this.plot.clutter)
      this.plot.clutter.geometry.dispose()
      this.plot.clutter.material.dispose()
      this.plot.clutter = null
      this.plot.clutterSpots = []
    }

    this.structures = []

    this.array = this._raise(this._composeArray(), -2.9, 2.0)
    this.bank = this._buildBank()
    this.rig = this._raise(this._composeRig({ clock: this._rigClock }), 3.0, 1.1)
    this.rig2 = this._raise(this._composeRig({ clock: this._rigClock }), RIG2_AT.x, RIG2_AT.z)
    this.fence = this._raise(this._composeFence(), 0, 0)

    // Grid-mode light: each rig's own material carries a steady POWER_ACCENT
    // emissive, damped on/off like the array glint. Dark otherwise.
    for (const rig of [this.rig, this.rig2]) {
      rig.mesh.material.emissive = new THREE.Color(POWER_ACCENT)
      rig.mesh.material.emissiveIntensity = 0
    }

    this.label = createLabel('Power', POWER_ACCENT)
    this.label.position.set(this.plot.labelAnchor.x, 3.2, this.plot.labelAnchor.z)

    // Plot-local footprints for the navigation grid, in the Plot's own shape.
    this.structureSpots = this.structures.map((s) => ({ x: s.x, z: s.z, r: s.r }))
  }

  // ── construction ──────────────────────────────────────────────────────────

  /** Merge composer parts into a decorated mesh on the colony's scale. */
  _finish(composer, { clock = null } = {}) {
    const geo = composer.finish()
    geo.scale(BUILDING_SCALE, BUILDING_SCALE, BUILDING_SCALE)
    // `scale()` moves positions, not the rotor pivots stored alongside them.
    const pivot = geo.getAttribute('aPivot')
    if (pivot) {
      for (let i = 0; i < pivot.count * 3; i++) pivot.array[i] *= BUILDING_SCALE
      pivot.needsUpdate = true
    }
    geo.computeBoundingBox()
    const box = geo.boundingBox
    const uniforms = structureUniforms({
      accent: POWER_ACCENT,
      height: box.max.y,
      minY: box.min.y,
      night: buildingUniforms.uNight,
      // A private clock freezes the shader spin mid-pose; the shared one never stops.
      time: clock || buildingUniforms.uTime,
    })
    const material = decorate(
      new THREE.MeshStandardMaterial({
        map: atlasTexture(),
        roughness: 0.6,
        metalness: 0,
        emissive: 0x000000,
        side: THREE.FrontSide,
      }),
      uniforms
    )
    const mesh = new THREE.Mesh(geo, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    const footprint = Math.max(Math.abs(box.max.x), Math.abs(box.min.x), Math.abs(box.max.z), Math.abs(box.min.z))
    return { mesh, uniforms, footprint }
  }

  /** Stand a finished structure on the deck and record its nav footprint. */
  _raise(built, x, z) {
    built.mesh.position.set(x, DECK_TOP, z)
    this.plot.group.add(built.mesh)
    this.structures.push({ x, z, r: built.footprint * 0.8 })
    return built
  }

  _composeArray() {
    // Pure panel rows: the old lamp + crate props shared the array's box and
    // pushed it into the bank. Scenery lives on the kerb fence now.
    const rand = mulberry(YARD_SEED)
    const c = new Composer()
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        c.add('solarpanel', {
          x: (i - 1) * 1.05,
          z: (j - 0.5) * 0.62,
          ry: 0.06 * (rand() - 0.5),
        })
      }
    }
    return this._finish(c)
  }

  _composeRig({ clock } = {}) {
    // One composite silhouette, bottom to top: structure solo, its module at
    // the modelled offset, the low mast solo standing on the roof plane, and
    // that mast's fan at hub height — the town antenna's slow vertex-shader
    // spin recipe, gated by the rig's private clock (see update).
    return this._finish(
      new Composer()
        .add('drill_structure', { solo: true })
        .add('drill_module', { y: 1 })
        .add('windturbine_low', { solo: true, y: TOWER_Y })
        .add('windturbine_low_fan', { y: TOWER_Y + LOW_HUB, spin: FAN_RATE }),
      { clock }
    )
  }

  _composeFence() {
    const rand = mulberry(YARD_SEED + 1)
    const c = new Composer()
    // The depot rides the roomy north slot: on the tight west slot its corner
    // hung a full unit past the deck edge. A small crate takes the west slot.
    const props = ['containers_A', 'cargodepot_A', 'containers_C', 'containers_B', 'containers_D', 'lights']
    this.fenceSpots = []
    ;[0.3, 1.3, 2.4, 3.5, 4.6, 5.6].forEach((a, i) => {
      const name = props[i % props.length]
      const s = name === 'lights' ? 1.1 : name === 'cargodepot_A' ? 0.7 : 1.35
      const geo = part(name)
      geo.scale(s, s, s)
      geo.rotateY(rand() * Math.PI * 2)
      const r = PLOT_CELL * (0.68 + rand() * 0.06)
      const px = Math.cos(a) * r
      const pz = Math.sin(a) * r
      geo.computeBoundingBox()
      const box = geo.boundingBox
      const spread = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5
      geo.translate(px, 0, pz)
      const count = geo.attributes.position.count
      geo.setAttribute('aEmissive', new THREE.BufferAttribute(new Float32Array(count).fill(0), 1))
      geo.setAttribute('aSpin', new THREE.BufferAttribute(new Float32Array(count).fill(0), 1))
      geo.setAttribute('aPivot', new THREE.BufferAttribute(new Float32Array(count * 3).fill(0), 3))
      c.parts.push(geo)
      this.fenceSpots.push({ x: px, z: pz, r: Math.max(0.45, spread * 0.86) })
    })
    return this._finish(c)
  }

  _buildBank() {
    // Four double-scale blocks in one straight row along the back strip:
    // the bank IS the gauge, so the charge reads left to right (west to
    // east from the default camera), one quartile per block. Quartile,
    // flow-brightness and guard logic are unchanged — only the bodies are
    // gone and the crates grew into batteries.
    const probe = part('cargo_A')
    probe.computeBoundingBox()
    const box = probe.boundingBox.clone()
    probe.dispose()
    const bank = new THREE.Group()
    this.bankBlocks = []
    for (let i = 0; i < BANK_BLOCKS; i++) {
      const geo = part('cargo_A')
      geo.translate(-box.min.x - (box.max.x - box.min.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
      geo.scale(BANK_SCALE, BANK_SCALE, BANK_SCALE)
      const material = new THREE.MeshStandardMaterial({
        map: atlasTexture(),
        roughness: 0.6,
        metalness: 0.05,
        emissive: POWER_ACCENT,
        emissiveIntensity: 0,
      })
      const mesh = new THREE.Mesh(geo, material)
      mesh.castShadow = true
      mesh.position.set(
        BANK_AT.x + (i - (BANK_BLOCKS - 1) / 2) * BANK_PITCH,
        DECK_TOP,
        BANK_AT.z
      )
      bank.add(mesh)
      this.bankBlocks.push(mesh)
    }
    this.plot.group.add(bank)
    for (const m of this.bankBlocks) {
      const b = new THREE.Box3().setFromObject(m)
      const s = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5
      this.structures.push({ x: m.position.x, z: m.position.z, r: Math.max(0.45, s * 0.8) })
    }
    return bank
  }

  // ── live state ────────────────────────────────────────────────────────────

  setSolar(solar) {
    this.solar = solar && typeof solar === 'object' ? solar : null
  }

  /**
   * One frame of the zone. `night` is the sky's night factor; hover/ui mirror
   * the colony's own label rules so the plate behaves like every quiet plot's.
   */
  update(dt, elapsed, night, { hovered = false, uiVisible = true, showLabels = true } = {}) {
    // Array glint: damped like the town's old glow, gated by the same toggle.
    const glintOn = this.settings.get('solarGlint') !== false
    const glintTarget = glintOn ? solarGlintLevel(this.solar) : 0
    const k = 1 - Math.exp(-dt * 1.5)
    this._glint += (glintTarget - this._glint) * k
    if (Math.abs(this._glint) < 0.001) this._glint = 0
    this.array.uniforms.uGlint.value = this._glint

    // Battery row: fill quartiles west to east, flow brightness, cutoff guard.
    const flow = batteryFlow(this.solar)
    const guard = batteryBelowCutoff(this.solar)
    const lit = batteryLitCount(this.solar, BANK_BLOCKS)
    const intensity = flow === 'charge' ? 2.0 : flow === 'idle' ? 1.6 : 1.2
    const g = this._bank
    if (g.lit !== lit || g.intensity !== intensity || g.guard !== guard) {
      this._bank = { lit, intensity, guard }
      this.bankBlocks.forEach((mesh, i) => {
        if (i < lit) mesh.material.emissiveIntensity = intensity
        else mesh.material.emissiveIntensity = guard ? 0.35 : 0
      })
    }
    if (this._dimmed !== guard) {
      this._dimmed = guard
      for (const mesh of this.bankBlocks) mesh.material.color.setScalar(guard ? 0.55 : 1)
    }

    // Station rigs: grid glow plus rooftop fans, or darkness and still air.
    // Damped glow so the changeover reads as a lamp warming, not a blink;
    // the fans hold mid-pose the moment grid leaves — the private clock the
    // shaders read simply stops advancing.
    const rigTarget = rigGlowOn(this.solar) ? 1 : 0
    this._rigGlow += (rigTarget - this._rigGlow) * k
    if (Math.abs(this._rigGlow - rigTarget) < 0.001) this._rigGlow = rigTarget
    this.rig.mesh.material.emissiveIntensity = this._rigGlow * RIG_GLOW
    this.rig2.mesh.material.emissiveIntensity = this._rigGlow * RIG_GLOW
    if (turbineSpinning(this.solar)) this._rigTime += dt
    this._rigClock.value = this._rigTime

    // Deck kerb + lamps follow the town's night lighting, never urgent.
    this.plot.setNight(night, false, elapsed)

    // Name plate: the quiet-plot rule — on hover, while chrome is up.
    const wanted = uiVisible && showLabels && hovered ? 1 : 0
    const next = THREE.MathUtils.damp(this.label.material.opacity, wanted, 9, dt)
    this.label.material.opacity = next
    this.label.visible = next > 0.01
  }

  /** World-space clear circle for scatter, and nav footprints. */
  scatterClear() {
    return { x: this.plot.center.x, z: this.plot.center.z, r: 8.6 }
  }

  navSpots() {
    const at = (s) => ({ x: this.plot.center.x + s.x, z: this.plot.center.z + s.z, r: s.r })
    return [...this.structureSpots.map(at), ...(this.plot.clutterSpots || []).map(at), ...(this.fenceSpots || []).map(at)]
  }

  dispose() {
    this.plot.dispose()
    this.rig.mesh.geometry.dispose()
    this.rig.mesh.material.dispose()
    this.rig2.mesh.geometry.dispose()
    this.rig2.mesh.material.dispose()
    for (const m of this.bankBlocks) {
      m.geometry.dispose()
      m.material.dispose()
    }
    this.label.userData.dispose?.()
  }
}
