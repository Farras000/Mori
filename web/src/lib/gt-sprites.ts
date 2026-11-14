import { Container, Graphics, ImageSource, Rectangle, Sprite, Texture } from 'pixi.js'
import { Color } from '@/lib/color'
import type { ItemRecord } from '@/lib/api'
import { textureCacheManager } from '@/lib/texture-cache'
import { TILE_PX } from '@/lib/tile-layer'

export interface GtCharacterTextures {
  head: Texture
  headAir: Texture
  eyes: Texture
  arm: Texture
  feetBack: Texture
  feetFront: Texture
}

export interface GtWorldUiTextures {
  sun: Texture | null
  cloud: Texture | null
  pickupBox: Texture | null
}

const seedUrlCache = new Map<string, string>()
const seedTextureCache = new Map<string, Texture>()
const clothingTextureCache = new Map<number, Texture>()
const clothingInFlight = new Map<number, Promise<Texture | null>>()
const sheetSourceByFile = new Map<string, Promise<ImageSource | null>>()

async function getOrCreateCharacterSheetSource(fileName: string): Promise<ImageSource | null> {
  const normalized = fileName.replace(/^game\//i, '').trim()
  if (!normalized) return null
  const existing = sheetSourceByFile.get(normalized)
  if (existing) {
    const src = await existing
    if (src && !src.destroyed) return src
    sheetSourceByFile.delete(normalized)
  }
  const promise = textureCacheManager
    .getSheetBitmap(normalized)
    .then((bmp) => new ImageSource({ resource: bmp, scaleMode: 'nearest' }))
    .catch(() => null)
  sheetSourceByFile.set(normalized, promise)
  const resolved = await promise
  if (!resolved) {
    sheetSourceByFile.delete(normalized)
  }
  return resolved
}

async function sliceSheetTexture(
  fileName: string,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Promise<Texture | null> {
  const source = await getOrCreateCharacterSheetSource(fileName)
  if (!source || source.destroyed) return null
  const maxW = source.pixelWidth || source.width || 0
  const maxH = source.pixelHeight || source.height || 0
  if (sx < 0 || sy < 0 || sx >= maxW || sy >= maxH) return null
  const w = Math.max(1, Math.min(sw, maxW - sx))
  const h = Math.max(1, Math.min(sh, maxH - sy))
  return new Texture({ source, frame: new Rectangle(sx, sy, w, h) })
}

/** Resolve cell coordinates `(x, y)` for a wearable item, supporting `extra_options` fallback. */
function resolveClothingCellCoords(item: ItemRecord): { tx: number; ty: number } {
  if (item.texture_x >= 0 && item.texture_y >= 0) {
    return { tx: item.texture_x, ty: item.texture_y }
  }
  const match = item.extra_options?.match(/(-?\d+)\s*,\s*(-?\d+)/)
  if (match) {
    return { tx: Math.max(0, Number(match[1]) || 0), ty: Math.max(0, Number(match[2]) || 0) }
  }
  return { tx: Math.max(0, item.texture_x || 0), ty: Math.max(0, item.texture_y || 0) }
}

/** Load and cache a crisp Pixi texture for an equipped wearable item without sticky failure caching. */
function getClothingSpriteTexture(item: ItemRecord): Promise<Texture | null> {
  const existing = clothingTextureCache.get(item.id)
  if (existing && !existing.destroyed) return Promise.resolve(existing)

  const pending = clothingInFlight.get(item.id)
  if (pending) return pending

  const promise = (async () => {
    const candidates = [item.texture_file_name, item.texture_path_2]
      .map((s) => (s || '').replace(/^game\//i, '').trim())
      .filter((s, idx, arr) => s.length > 0 && arr.indexOf(s) === idx)
    const { tx, ty } = resolveClothingCellCoords(item)

    for (const fileName of candidates) {
      const isLongHand = /^player_longhanditem\d*\.rttex$/i.test(fileName)
      const cellW = isLongHand ? 64 : 32
      const cellH = 32
      const tex = await sliceSheetTexture(fileName, tx * cellW, ty * cellH, cellW, cellH)
      if (tex && !tex.destroyed) {
        clothingTextureCache.set(item.id, tex)
        return tex
      }
    }
    return null
  })().finally(() => {
    clothingInFlight.delete(item.id)
  })

  clothingInFlight.set(item.id, promise)
  return promise
}

let charTexturesPromise: Promise<GtCharacterTextures | null> | null = null
let worldUiTexturesPromise: Promise<GtWorldUiTextures | null> | null = null

/** Load a Pixi Texture with crisp nearest-neighbor scaling from a decoded URL. */
export async function loadCrispTextureFromUrl(url: string | null): Promise<Texture | null> {
  if (!url) return null
  try {
    const img = new Image()
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Image load failed'))
      setTimeout(() => reject(new Error('Image load timeout')), 6000)
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, img.width)
    canvas.height = Math.max(1, img.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0)
    const texture = Texture.from(canvas)
    if (texture.source) {
      texture.source.scaleMode = 'nearest'
    }
    return texture
  } catch {
    return null
  }
}

/** Load and slice official Growtopia character layers directly from decoded GPU sheets. */
export function loadGtCharacterTextures(): Promise<GtCharacterTextures | null> {
  if (!charTexturesPromise) {
    charTexturesPromise = (async () => {
      // Slice head/torso (top 24px) separately from lower legs (y=24..32) so hip-pivoted legs swing cleanly
      const [head, headAir, eyes, arm, feetBack, feetFront] = await Promise.all([
        sliceSheetTexture('player_head.rttex', 0, 0, 32, 24),
        sliceSheetTexture('player_head.rttex', 0, 32, 32, 24),
        sliceSheetTexture('player_eyes.rttex', 0, 0, 32, 32),
        sliceSheetTexture('player_arm.rttex', 0, 0, 8, 12),
        sliceSheetTexture('player_feet.rttex', 0, 0, 32, 32),
        sliceSheetTexture('player_feet.rttex', 0, 32, 32, 32),
      ])
      if (!head || !eyes || !arm || !feetBack || !feetFront) {
        charTexturesPromise = null
        return null
      }
      return {
        head,
        headAir: headAir || head,
        eyes,
        arm,
        feetBack,
        feetFront,
      }
    })().catch(() => {
      charTexturesPromise = null
      return null
    })
  }
  return charTexturesPromise
}

/** Load official Growtopia sun, cloud, and dropped item pickup box sprites. */
export function loadGtWorldUiTextures(): Promise<GtWorldUiTextures | null> {
  if (!worldUiTexturesPromise) {
    worldUiTexturesPromise = (async () => {
      const [sun, cloud, pickupBox] = await Promise.all([
        sliceSheetTexture('sun.rttex', 0, 0, 161, 160),
        sliceSheetTexture('cloud.rttex', 0, 0, 197, 111),
        sliceSheetTexture('pickup_box.rttex', 0, 0, 32, 20),
      ])
      if (!sun && !cloud && !pickupBox) {
        worldUiTexturesPromise = null
        return null
      }
      return { sun, cloud, pickupBox }
    })().catch(() => {
      worldUiTexturesPromise = null
      return null
    })
  }
  return worldUiTexturesPromise
}

function drawSeedSpriteSlice(
  ctx: CanvasRenderingContext2D,
  sheet: ImageBitmap,
  sx: number,
  sy: number,
  colorVal?: number,
) {
  const w = 16
  const h = 16
  const temp = document.createElement('canvas')
  temp.width = w
  temp.height = h
  const tctx = temp.getContext('2d')
  if (!tctx) return
  tctx.imageSmoothingEnabled = false
  if (sx + w <= sheet.width && sy + h <= sheet.height) {
    tctx.drawImage(sheet, sx, sy, w, h, 0, 0, w, h)
  }
  if (colorVal && colorVal !== 0) {
    const c = new Color(colorVal)
    const imgData = tctx.getImageData(0, 0, w, h)
    const d = imgData.data
    const r = c.getRed() / 255
    const g = c.getGreen() / 255
    const b = c.getBlue() / 255
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) {
        d[i] = Math.floor(d[i] * r)
        d[i + 1] = Math.floor(d[i + 1] * g)
        d[i + 2] = Math.floor(d[i + 2] * b)
      }
    }
    tctx.putImageData(imgData, 0, 0)
  }
  ctx.drawImage(temp, 0, 0)
}

/** Composite a crisp 16x16 Growtopia seed canvas from `seed.rttex`. */
async function buildSeedCanvas(
  baseSprite: number,
  overlaySprite: number,
  baseColor?: number,
  overlayColor?: number,
): Promise<HTMLCanvasElement | null> {
  const sheet = await textureCacheManager.getSheetBitmap('seed.rttex')
  const colBase = ((baseSprite % 16) + 16) % 16
  const colOverlay = ((overlaySprite % 16) + 16) % 16
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  drawSeedSpriteSlice(ctx, sheet, colBase * 16, 0, baseColor)
  drawSeedSpriteSlice(ctx, sheet, colOverlay * 16, 16, overlayColor)
  return canvas
}

/** Composite a crisp 16x16 Growtopia seed PNG data URL from `seed.rttex`. */
export async function getGtSeedDataUrl(
  baseSprite: number,
  overlaySprite: number,
  baseColor?: number,
  overlayColor?: number,
): Promise<string | null> {
  const key = `${baseSprite}:${overlaySprite}:${baseColor ?? 0}:${overlayColor ?? 0}`
  const existing = seedUrlCache.get(key)
  if (existing) return existing

  try {
    const canvas = await buildSeedCanvas(baseSprite, overlaySprite, baseColor, overlayColor)
    if (!canvas) return null
    const dataUrl = canvas.toDataURL('image/png')
    seedUrlCache.set(key, dataUrl)
    return dataUrl
  } catch {
    return null
  }
}

/** Cached Pixi Texture for a composited Growtopia seed sprite. */
export async function getGtSeedTexture(
  baseSprite: number,
  overlaySprite: number,
  baseColor?: number,
  overlayColor?: number,
): Promise<Texture | null> {
  const key = `${baseSprite}:${overlaySprite}:${baseColor ?? 0}:${overlayColor ?? 0}`
  const cached = seedTextureCache.get(key)
  if (cached && !cached.destroyed) return cached
  try {
    const canvas = await buildSeedCanvas(baseSprite, overlaySprite, baseColor, overlayColor)
    if (!canvas) return null
    const tex = new Texture({
      source: new ImageSource({ resource: canvas, scaleMode: 'nearest' }),
    })
    seedTextureCache.set(key, tex)
    return tex
  } catch {
    return null
  }
}

export interface GtCharacterRig {
  root: Container
  setClothes: (clothes: number[] | undefined, itemsMap: Map<number, ItemRecord>) => void
  setPose: (opts: {
    facingLeft: boolean
    airborne: boolean
    walking: boolean
    punching: boolean
    slowFalling?: boolean
    hasWings?: boolean
    hasJetpack?: boolean
    hasChickenFeet?: boolean
    walkPhase?: number
    time: number
  }) => void
}

/** Draw one articulated Growtopia leg (hip-pivoted at local (0, 0), sole grounded flush on floor y = 8.35). */
function createArticulatedLeg(shortsColor: number, isBack: boolean, isChickenFeet: boolean): Container {
  const leg = new Container()
  const pantsShade = isBack ? darkenHex(shortsColor, 0.72) : shortsColor
  const shoeColor = isChickenFeet ? 0xf59e0b : isBack ? 0x452b18 : 0x5c3a21
  const soleColor = isChickenFeet ? 0xb45309 : isBack ? 0x2c1a0e : 0x3b2314

  // Extended pants cuff & thigh (y = -2.0..5.0) ensures no waist gap during walk stride drops
  const g = new Graphics()
  g.roundRect(-2.6, -2.0, 5.2, 7.2, 1).fill(pantsShade)
  // Flush boot upper reaching y=8.1 (local +0.1 on top of pivot -8) + sole extending
  // to y=9.1 (+1.1 body texels) so boots seat firmly into tile surface rows.
  if (isChickenFeet) {
    g.roundRect(-2, 4.9, 4.2, 3.2, 0.7).fill(shoeColor)
    g.rect(-2.5, 7.6, 6.2, 1.5).fill(soleColor)
  } else {
    g.roundRect(-2.6, 4.7, 5.8, 3.4, 0.7).fill(shoeColor)
    g.rect(-2.6, 7.6, 6.0, 1.5).fill(soleColor)
  }
  leg.addChild(g)
  return leg
}

function darkenHex(hex: number, factor: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((hex >> 16) & 0xff) * factor)))
  const g = Math.max(0, Math.min(255, Math.round(((hex >> 8) & 0xff) * factor)))
  const b = Math.max(0, Math.min(255, Math.round((hex & 0xff) * factor)))
  return (r << 16) | (g << 8) | b
}

/** Create wing/jetpack/parasol visual attachments for active Growtopia gear. */
function createGearOverlays() {
  const wings = new Container()
  const wg = new Graphics()
  wg.moveTo(-4, -17)
    .lineTo(-14, -24)
    .lineTo(-16, -15)
    .lineTo(-11, -12)
    .lineTo(-4, -13)
    .closePath()
    .fill({ color: 0xf8fafc, alpha: 0.92 })
    .stroke({ color: 0xfacc15, width: 1 })
  wings.addChild(wg)
  wings.visible = false

  const jetpack = new Container()
  const jg = new Graphics()
  jg.roundRect(-9, -18, 6, 9, 1.5).fill(0x94a3b8).stroke({ color: 0x334155, width: 1 })
  jg.rect(-8, -16, 4, 2).fill(0xef4444)
  jetpack.addChild(jg)
  const flame = new Graphics()
  flame.moveTo(-8, -9).lineTo(-6, -3).lineTo(-4, -9).closePath().fill(0xf97316)
  flame.moveTo(-7.2, -9).lineTo(-6, -5).lineTo(-4.8, -9).closePath().fill(0xfef08a)
  flame.visible = false
  jetpack.addChild(flame)
  jetpack.visible = false

  const parasol = new Container()
  const pg = new Graphics()
  // Umbrella pole + dome above head
  pg.rect(-0.6, -36, 1.4, 20).fill(0x78350f)
  pg.moveTo(-13, -34)
    .quadraticCurveTo(0, -45, 13, -34)
    .closePath()
    .fill(0xf472b6)
    .stroke({ color: 0xfce7f3, width: 1 })
  parasol.addChild(pg)
  parasol.visible = false

  return { wings, jetpack, flame, parasol }
}

/**
 * Build a Growtopia-proportioned Pixi character rig.
 * Origin `(0, 0)` rests directly at bottom-center (feet soles flush on floor `y = 0`).
 * Height matches ~1.12x `TILE_PX` (native Growtopia 32x32 char vs 32px block).
 */
export function createGtCharacterRig(
  textures: GtCharacterTextures | null,
  opts?: { skinTint?: number; shortsColor?: number; fallbackShirt?: number },
): GtCharacterRig {
  const root = new Container()
  const body = new Container()
  root.addChild(body)

  const skinTint = opts?.skinTint ?? 0xf3c89a
  const shortsColor = opts?.shortsColor ?? 0x3b4d6b
  const fallbackShirt = opts?.fallbackShirt ?? 0x475569

  // Native GT char 32px cell scaled so character sits at ~1.12x tile height
  const rigScale = (TILE_PX * 1.12) / 32
  body.scale.set(rigScale)

  const backLegContainer = new Container()
  backLegContainer.position.set(-2.2, -8)
  const frontLegContainer = new Container()
  frontLegContainer.position.set(2.2, -8)

  let curChickenFeet = false
  const rebuildLegs = (chicken: boolean) => {
    curChickenFeet = chicken
    backLegContainer.removeChildren()
    frontLegContainer.removeChildren()
    backLegContainer.addChild(createArticulatedLeg(shortsColor, true, chicken))
    frontLegContainer.addChild(createArticulatedLeg(shortsColor, false, chicken))
  }
  rebuildLegs(false)

  const upperBody = new Container()
  const gear = createGearOverlays()
  upperBody.addChild(gear.wings)
  upperBody.addChild(gear.jetpack)

  const armContainer = new Container()
  let armSprite: Sprite | Graphics

  let headSprite: Sprite | null = null
  let eyesSprite: Sprite | null = null

  if (!textures) {
    const torsoG = new Graphics()
    torsoG.roundRect(-8.5, -30, 17, 13.5, 3.5).fill(skinTint)
    torsoG.rect(-5, -25, 2.8, 3.5).fill(0x1e293b)
    torsoG.rect(2.2, -25, 2.8, 3.5).fill(0x1e293b)
    torsoG.roundRect(-6.5, -16.5, 13, 8.8, 2).fill(fallbackShirt)
    torsoG.rect(-6.8, -9.2, 13.6, 2.2).fill(shortsColor)
    upperBody.addChild(torsoG)

    const armG = new Graphics()
    armG.roundRect(-2, -1, 4.2, 9.5, 1.5).fill(skinTint)
    armContainer.addChild(armG)
    armSprite = armG
  } else {
    // Upper silhouette (head + chest + shirt waist) anchored cleanly at y = -8 hip line
    headSprite = new Sprite(textures.head)
    headSprite.anchor.set(0.5, 1)
    headSprite.position.set(0, -8)
    headSprite.tint = skinTint

    // Belt/waist seam covering the hip joint cleanly
    const belt = new Graphics()
    belt.rect(-7, -9.5, 14, 2.5).fill(shortsColor)

    eyesSprite = new Sprite(textures.eyes)
    eyesSprite.anchor.set(0.5, 1)
    eyesSprite.position.set(0, 0)

    const armS = new Sprite(textures.arm)
    armS.anchor.set(0.5, 0.15)
    armS.position.set(0, 0)
    armS.tint = skinTint
    armContainer.addChild(armS)
    armSprite = armS

    upperBody.addChild(headSprite)
    upperBody.addChild(belt)
    upperBody.addChild(eyesSprite)
  }

  armContainer.position.set(-1, -16)

  // Clothing overlay containers arranged in native 32x32 Growtopia z-order
  const backClothContainer = new Container()
  const ancestralClothContainer = new Container()
  ancestralClothContainer.position.set(-12, -24)
  const legsClothContainer = new Container()
  const upperClothContainer = new Container()
  const handClothContainer = new Container()
  armContainer.addChildAt(handClothContainer, 0)

  upperBody.addChild(upperClothContainer)
  upperBody.addChild(armContainer)
  upperBody.addChild(gear.parasol)

  let lastClothSig = ''
  let clothLoadGen = 0
  let hasCustomBackSprite = false

  const clearClothContainers = () => {
    backClothContainer.removeChildren()
    ancestralClothContainer.removeChildren()
    legsClothContainer.removeChildren()
    upperClothContainer.removeChildren()
    handClothContainer.removeChildren()
    hasCustomBackSprite = false
  }

  // Draw order: ground shadow -> back/wings/ancestral -> bare legs -> pants/shoes -> torso/upper clothes/arm
  const groundShadow = new Graphics()
  groundShadow.ellipse(0, 0.25, 5.6, 1.35).fill({ color: 0x000000, alpha: 0.34 })
  body.addChild(groundShadow)
  body.addChild(backClothContainer)
  body.addChild(ancestralClothContainer)
  body.addChild(backLegContainer)
  body.addChild(frontLegContainer)
  body.addChild(legsClothContainer)
  body.addChild(upperBody)
  void armSprite

  return {
    root,
    setClothes: (clothes, itemsMap) => {
      const normalized = clothes && clothes.length > 0 ? clothes : []
      let allItemsKnown = true
      const resolvedKey = normalized
        .map((id, idx) => {
          if (id <= 0) return `${idx}:0`
          if (!itemsMap.has(id)) {
            allItemsKnown = false
            return `${idx}:pending:${id}`
          }
          return `${idx}:${id}`
        })
        .join('|')
      if (resolvedKey === lastClothSig && allItemsKnown) return
      lastClothSig = allItemsKnown ? resolvedKey : ''
      const gen = ++clothLoadGen
      clearClothContainers()

      if (normalized.length === 0) return

      const baseOrder = [6, 2, 3, 1, 8, 7, 4, 0, 5]
      const extraSlots: number[] = []
      for (let i = 0; i < normalized.length; i++) {
        if (!baseOrder.includes(i)) extraSlots.push(i)
      }
      const drawOrder = [...baseOrder, ...extraSlots]

      Promise.all(
        drawOrder.map(async (slotIdx) => {
          const itemId = normalized[slotIdx] ?? 0
          if (!itemId) return null
          const item = itemsMap.get(itemId)
          if (!item) return { slotIdx, item: null, tex: null, failed: true }
          const tex = await getClothingSpriteTexture(item)
          if (!tex || tex.destroyed) return { slotIdx, item, tex: null, failed: true }
          return { slotIdx, item, tex, failed: false }
        }),
      ).then((loaded) => {
        if (gen !== clothLoadGen || root.destroyed) return
        clearClothContainers()
        let anyFailed = false
        for (const entry of loaded) {
          if (!entry) continue
          if (entry.failed || !entry.item || !entry.tex || entry.tex.destroyed) {
            anyFailed = true
            continue
          }
          const { item, tex, slotIdx } = entry
          const isAncestral = item.action_type === 107
          const ct = item.clothing_type <= 8 ? item.clothing_type : slotIdx
          const sp = new Sprite(tex)

          if (isAncestral) {
            sp.anchor.set(0.5, 0.5)
            sp.position.set(0, 0)
            sp.width = 32
            sp.height = 32
            ancestralClothContainer.addChild(sp)
            continue
          }

          if (ct === 6) {
            sp.anchor.set(0.5, 1)
            sp.position.set(0, 0)
            sp.width = 32
            sp.height = 32
            backClothContainer.addChild(sp)
            hasCustomBackSprite = true
          } else if (ct === 2 || ct === 3) {
            sp.anchor.set(0.5, 1)
            sp.position.set(0, 0)
            sp.width = 32
            sp.height = 32
            legsClothContainer.addChild(sp)
          } else if (ct === 5) {
            const normalizedSheet = item.texture_file_name.replace(/^game\//i, '').trim()
            const isLongHand = (tex.frame?.width ?? 32) > 32
              || /^player_longhanditem\d*\.rttex$/i.test(normalizedSheet)
            if (isLongHand) {
              sp.anchor.set(0.5, 0.5)
              sp.width = 64
              sp.height = 32
            } else {
              sp.anchor.set(0.5, 0.22)
              sp.width = 32
              sp.height = 32
            }
            sp.position.set(0, 6)
            handClothContainer.addChild(sp)
          } else if (ct === 0) {
            sp.anchor.set(0.5, 1)
            sp.position.set(0, -15)
            sp.width = 32
            sp.height = 32
            upperClothContainer.addChild(sp)
          } else if (ct === 7) {
            const isFaceItemSheet = /faceitem/i.test(item.texture_file_name || '')
            sp.anchor.set(0.5, 1)
            sp.position.set(0, isFaceItemSheet ? 0 : -15)
            sp.width = 32
            sp.height = 32
            upperClothContainer.addChild(sp)
          } else {
            // ct === 1 (shirt), 4 (face), 8 (neck), or fallback 32x32 frame
            sp.anchor.set(0.5, 1)
            sp.position.set(0, 0)
            sp.width = 32
            sp.height = 32
            upperClothContainer.addChild(sp)
          }
        }
        if (anyFailed) {
          lastClothSig = ''
        }
      })
    },
    setPose: ({
      facingLeft,
      airborne,
      walking,
      punching,
      slowFalling = false,
      hasWings = false,
      hasJetpack = false,
      hasChickenFeet = false,
      walkPhase,
      time,
    }) => {
      body.scale.x = facingLeft ? -rigScale : rigScale
      groundShadow.visible = !airborne
      if (hasChickenFeet !== curChickenFeet) {
        rebuildLegs(hasChickenFeet)
      }
      if (headSprite && textures) {
        headSprite.texture = airborne ? textures.headAir : textures.head
      }

      gear.wings.visible = hasWings && !hasJetpack && !hasCustomBackSprite
      gear.jetpack.visible = hasJetpack
      gear.flame.visible = hasJetpack && airborne
      gear.parasol.visible = slowFalling && !hasCustomBackSprite

      const phase = walkPhase ?? time * 0.26
      const swing = Math.sin(phase)
      const liftFront = Math.max(0, Math.cos(phase))
      const liftBack = Math.max(0, -Math.cos(phase))

      if (gear.wings.visible) {
        gear.wings.rotation = airborne ? Math.sin(time * 0.45) * 0.28 : Math.sin(time * 0.08) * 0.05
      }

      if (airborne) {
        frontLegContainer.position.set(2.2, -9.2)
        frontLegContainer.rotation = -0.35
        backLegContainer.position.set(-2.2, -8.5)
        backLegContainer.rotation = 0.28
        upperBody.y = 0
        upperBody.rotation = 0
      } else if (walking) {
        // Keep planted foot at hip y = -8 while lifting only the active swing foot slightly
        const swingRad = swing * 0.56
        const hipDrop = 8.8 * (1 - Math.cos(swingRad))
        frontLegContainer.position.set(2.2, -8 + hipDrop - liftFront * 1.6)
        frontLegContainer.rotation = -swingRad
        backLegContainer.position.set(-2.2, -8 + hipDrop - liftBack * 1.6)
        backLegContainer.rotation = swingRad
        upperBody.y = -Math.abs(swing) * 0.65
        upperBody.rotation = swing * 0.04
      } else {
        frontLegContainer.position.set(2.2, -8)
        frontLegContainer.rotation = 0
        backLegContainer.position.set(-2.2, -8)
        backLegContainer.rotation = 0
        upperBody.y = Math.sin(time * 0.08) * 0.25
        upperBody.rotation = 0
      }

      if (punching) {
        armContainer.rotation = -Math.PI * 0.48 + Math.sin(time * 0.85) * 0.35
      } else if (slowFalling) {
        armContainer.rotation = -Math.PI * 0.72
      } else if (airborne) {
        armContainer.rotation = -0.45
      } else if (walking) {
        armContainer.rotation = swing * 0.52
      } else {
        armContainer.rotation = 0.06
      }

      backClothContainer.y = upperBody.y
      if (ancestralClothContainer.children.length > 0) {
        ancestralClothContainer.y = -24 + Math.sin(time * 0.1) * 1.5
      }
    },
  }
}
