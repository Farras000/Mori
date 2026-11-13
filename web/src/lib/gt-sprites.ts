import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { Color } from '@/lib/color'
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

/** Load and slice official Growtopia character layers from `/growtopia-cdn/`. */
export function loadGtCharacterTextures(): Promise<GtCharacterTextures | null> {
  if (!charTexturesPromise) {
    charTexturesPromise = (async () => {
      // Slice head/torso (top 24px) separately from lower legs (y=24..32) so hip-pivoted legs swing cleanly
      const [headUrl, headAirUrl, eyesUrl, armUrl, feetBackUrl, feetFrontUrl] = await Promise.all([
        textureCacheManager.getCroppedRegion('player_head.rttex', 0, 0, 32, 24),
        textureCacheManager.getCroppedRegion('player_head.rttex', 0, 32, 32, 24),
        textureCacheManager.getCroppedRegion('player_eyes.rttex', 0, 0, 32, 32),
        textureCacheManager.getCroppedRegion('player_arm.rttex', 0, 0, 8, 12),
        textureCacheManager.getCroppedRegion('player_feet.rttex', 0, 0, 32, 32),
        textureCacheManager.getCroppedRegion('player_feet.rttex', 0, 32, 32, 32),
      ])
      const [head, headAir, eyes, arm, feetBack, feetFront] = await Promise.all([
        loadCrispTextureFromUrl(headUrl),
        loadCrispTextureFromUrl(headAirUrl),
        loadCrispTextureFromUrl(eyesUrl),
        loadCrispTextureFromUrl(armUrl),
        loadCrispTextureFromUrl(feetBackUrl),
        loadCrispTextureFromUrl(feetFrontUrl),
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
      const [sunUrl, cloudUrl, boxUrl] = await Promise.all([
        textureCacheManager.getCroppedRegion('sun.rttex', 0, 0, 161, 160),
        textureCacheManager.getCroppedRegion('cloud.rttex', 0, 0, 197, 111),
        textureCacheManager.getCroppedRegion('pickup_box.rttex', 0, 0, 32, 20),
      ])
      const [sun, cloud, pickupBox] = await Promise.all([
        loadCrispTextureFromUrl(sunUrl),
        loadCrispTextureFromUrl(cloudUrl),
        loadCrispTextureFromUrl(boxUrl),
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

function applyTintToCanvas(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
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
  tctx.drawImage(img, 0, 0, w, h)
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

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Image load failed'))
    img.src = url
  })
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
    const colBase = ((baseSprite % 16) + 16) % 16
    const colOverlay = ((overlaySprite % 16) + 16) % 16
    const [baseUrl, overlayUrl] = await Promise.all([
      textureCacheManager.getCroppedRegion('seed.rttex', colBase * 16, 0, 16, 16),
      textureCacheManager.getCroppedRegion('seed.rttex', colOverlay * 16, 16, 16, 16),
    ])
    if (!baseUrl) return null

    const [baseImg, overlayImg] = await Promise.all([
      loadHtmlImage(baseUrl),
      overlayUrl ? loadHtmlImage(overlayUrl) : Promise.resolve(null),
    ])

    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 16
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = false
    applyTintToCanvas(ctx, baseImg, baseColor)
    if (overlayImg) {
      applyTintToCanvas(ctx, overlayImg, overlayColor)
    }
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
  const url = await getGtSeedDataUrl(baseSprite, overlaySprite, baseColor, overlayColor)
  const tex = await loadCrispTextureFromUrl(url)
  if (tex) seedTextureCache.set(key, tex)
  return tex
}

export interface GtCharacterRig {
  root: Container
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
    armS.anchor.set(0.45, 0.2)
    armS.position.set(0, 0)
    armS.tint = skinTint
    armContainer.addChild(armS)
    armSprite = armS

    upperBody.addChild(headSprite)
    upperBody.addChild(belt)
    upperBody.addChild(eyesSprite)
  }

  armContainer.position.set(-1.5, -13.5)
  upperBody.addChild(armContainer)
  upperBody.addChild(gear.parasol)

  // Draw order: subtle ground contact shadow behind back leg, torso, front leg
  const groundShadow = new Graphics()
  groundShadow.ellipse(0, 0.25, 5.6, 1.35).fill({ color: 0x000000, alpha: 0.34 })
  body.addChild(groundShadow)
  body.addChild(backLegContainer)
  body.addChild(upperBody)
  body.addChild(frontLegContainer)
  void armSprite

  return {
    root,
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

      gear.wings.visible = hasWings && !hasJetpack
      gear.jetpack.visible = hasJetpack
      gear.flame.visible = hasJetpack && airborne
      gear.parasol.visible = slowFalling

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
    },
  }
}
