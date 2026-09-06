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
  solarDimFactor,
  batteryFillLevel,
  batteryBelowCutoff,
  rigGlowOn,
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
 *   solar array  rows of `solarpanel`; live output glints on the panel cells
 *                of THIS mesh only (its own uGlint — town glass stays dark)
 *   battery bank a `basemodule` building; a four-block `cargo_A` gauge beside
 *                it lights one quartile per 25 % SoC, brighter while charging;
 *                at or under HA's cutoff the bank dims and the empty blocks
 *                carry a faint guard glow
 *   power station a `drill_structure` + `drill_module` rig whose emissive
 *                glows steady if and only if HA names grid as the source —
 *                dark on solar, battery, null, stale. No motion.
 *   fence        containers / cargodepot / lights ringing the kerb as scenery
 *
 * Pure display throughout: every target derives from the SolarState via
 * src/game/solar.js. The recorder payload (`history`) is accepted and ignored —
 * the colony never aggregates it, so there is nothing to render from it.
 */

/** Amber, from the plot palette — reads as utility, and repos never take it. */
export const POWER_ACCENT = 0xb8942a
/** Construction seed: the yard is laid out the same on every reload. */
const YARD_SEED = 20260906
/** Rig glow: steady POWER_ACCENT emissive while HA names grid. Calm, no pulse. */
const RIG_GLOW = 0.9
/** Gauge blocks: one per quartile. */
const GAUGE_BLOCKS = 4

/** Every kit node this module places. Checked at build time (see tools/). */
export const POWER_NODES = [
  'solarpanel',
  'basemodule_C',
  'drill_structure',
  'drill_module',
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
    // The rig's module rides at its modelled offset above the structure base.
    part('drill_structure', 'base', { solo: true }).dispose()
    part('drill_module').dispose()

    this.solar = null
    this._glint = 0
    this._rigGlow = 0
    this._gauge = { lit: -1, intensity: -1, guard: null }
    this._dimmed = null

    // The ground: a one-cell Plot that belongs to no repo, so it never enters
    // the legend, the sidebar, the layout file, or the badge system. Its
    // seeded clutter comes off: the fence below dresses the kerb already, and
    // two scatter systems on one tile would stack crates inside the array.
    this.plot = new Plot({ id: 'power-zone', name: 'Power', index: -1, cells: [POWER_CELL], accent: POWER_ACCENT })
    if (this.plot.clutter) {
      this.plot.group.remove(this.plot.clutter)
      this.plot.clutter.geometry.dispose()
      this.plot.clutter.material.dispose()
      this.plot.clutter = null
      this.plot.clutterSpots = []
    }

    this.structures = []

    this.array = this._raise(this._composeArray(), -2.7, 0.5)
    this.battery = this._raise(this._composeBattery(), 0.2, -2.0)
    this.rig = this._raise(this._composeRig(), 2.7, -0.7)
    this.fence = this._raise(this._composeFence(), 0, 0)

    // Grid-mode light: the rig's own material carries a steady POWER_ACCENT
    // emissive, damped on/off like the array glint. Dark otherwise.
    this.rig.mesh.material.emissive = new THREE.Color(POWER_ACCENT)
    this.rig.mesh.material.emissiveIntensity = 0

    this._buildGauge()

    this.label = createLabel('Power', POWER_ACCENT)
    this.label.position.set(this.plot.labelAnchor.x, 3.2, this.plot.labelAnchor.z)

    // Plot-local footprints for the navigation grid, in the Plot's own shape.
    this.structureSpots = this.structures.map((s) => ({ x: s.x, z: s.z, r: s.r }))
  }

  // ── construction ──────────────────────────────────────────────────────────

  /** Merge composer parts into a decorated mesh on the colony's scale. */
  _finish(composer) {
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
      time: buildingUniforms.uTime,
      dim: buildingUniforms.uDim,
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
    c.add('lights', { x: 1.9, z: -0.7, s: 0.8 })
    c.add('containers_B', { x: -1.9, z: 0.7, ry: 0.4 })
    return this._finish(c)
  }

  _composeBattery() {
    const c = new Composer()
    c.add('basemodule_C')
    // West of the bank: east is the rig.
    c.add('containers_D', { x: -1.7, z: 0.6, ry: 0.4 })
    return this._finish(c)
  }

  _composeRig() {
    // Structure without its module, plus the module at its modelled offset —
    // the same solo-plus-offset shape as the town's turbine recipe.
    return this._finish(new Composer().add('drill_structure', { solo: true }).add('drill_module', { y: 1 }))
  }

  _composeFence() {
    const rand = mulberry(YARD_SEED + 1)
    const c = new Composer()
    const props = ['containers_A', 'containers_B', 'containers_C', 'cargodepot_A', 'containers_D', 'lights']
    this.fenceSpots = []
    ;[0.3, 1.3, 2.4, 3.5, 4.6, 5.6].forEach((a, i) => {
      const name = props[i % props.length]
      const geo = part(name)
      geo.scale(name === 'lights' ? 1.1 : 1.35, name === 'lights' ? 1.1 : 1.35, name === 'lights' ? 1.1 : 1.35)
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

  _buildGauge() {
    // Four crates in a row by the bank: fill quartiles, nothing more.
    const probe = part('cargo_A')
    probe.computeBoundingBox()
    const box = probe.boundingBox.clone()
    probe.dispose()
    const w = box.max.x - box.min.x
    const gauge = new THREE.Group()
    this.gaugeBlocks = []
    for (let i = 0; i < GAUGE_BLOCKS; i++) {
      const geo = part('cargo_A')
      geo.translate(-box.min.x - w / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
      geo.scale(1.2, 1.2, 1.2)
      const material = new THREE.MeshStandardMaterial({
        map: atlasTexture(),
        roughness: 0.6,
        metalness: 0.05,
        emissive: POWER_ACCENT,
        emissiveIntensity: 0,
      })
      const mesh = new THREE.Mesh(geo, material)
      mesh.castShadow = true
      mesh.position.set(0.2 + (i - (GAUGE_BLOCKS - 1) / 2) * (w * 1.2 + 0.3), DECK_TOP, 0.1)
      gauge.add(mesh)
      this.gaugeBlocks.push(mesh)
    }
    this.plot.group.add(gauge)
    for (const m of this.gaugeBlocks) {
      const b = new THREE.Box3().setFromObject(m)
      const s = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5
      this.structures.push({ x: m.position.x, z: m.position.z, r: Math.max(0.45, s * 0.8) })
    }
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

    // Battery: fill quartiles, flow brightness, cutoff guard.
    const fill = batteryFillLevel(this.solar)
    const flow = batteryFlow(this.solar)
    const guard = batteryBelowCutoff(this.solar)
    const lit = fill === null ? 0 : Math.round(fill * GAUGE_BLOCKS)
    const intensity = flow === 'charge' ? 2.0 : flow === 'idle' ? 1.6 : 1.2
    const g = this._gauge
    if (g.lit !== lit || g.intensity !== intensity || g.guard !== guard) {
      this._gauge = { lit, intensity, guard }
      this.gaugeBlocks.forEach((mesh, i) => {
        if (i < lit) mesh.material.emissiveIntensity = intensity
        else mesh.material.emissiveIntensity = guard ? 0.35 : 0
      })
    }
    if (this._dimmed !== guard) {
      this._dimmed = guard
      this.battery.mesh.material.color.setScalar(guard ? 0.55 : 1)
    }

    // Station rig: grid glow or darkness, nothing between. Damped so the
    // changeover reads as a lamp warming, not a blink.
    const rigTarget = rigGlowOn(this.solar) ? 1 : 0
    this._rigGlow += (rigTarget - this._rigGlow) * k
    if (Math.abs(this._rigGlow - rigTarget) < 0.001) this._rigGlow = rigTarget
    this.rig.mesh.material.emissiveIntensity = this._rigGlow * RIG_GLOW

    // Deck kerb + lamps follow the town's night dimming, never urgent.
    this.plot.setNight(night, false, elapsed, solarDimFactor(this.solar))

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
    for (const m of this.gaugeBlocks) {
      m.geometry.dispose()
      m.material.dispose()
    }
    this.label.userData.dispose?.()
  }
}
