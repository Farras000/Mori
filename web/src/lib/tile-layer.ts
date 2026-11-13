import { Container, Sprite, Texture, Graphics } from 'pixi.js'
import { Color } from '@/lib/color'
import { TILE_FLAGS } from '@/lib/constants'
import { textureCacheManager } from '@/lib/texture-cache'
import { TileManager, type TileData as TileManagerData } from '@/lib/tile-manager'
import type { ItemRecord } from '@/lib/api'
import type { LiveBot } from '@/lib/store'
import type { TileData } from '@/lib/ws'

export interface TileLayerTile extends TileManagerData {
  tileType?: TileData['tile_type']
}

export const TILE_PX = 12
export const CHAR_PX = 4
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 20

export interface SpriteTileLayer {
  bgContainer: Container
  fgContainer: Container
  bgSprites: (Sprite | null)[]
  fgSprites: (Sprite | null)[]
  width: number
  height: number
}

export interface ColorTileLayer {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: Texture
  sprite: Sprite
  width: number
  height: number
}

export interface TileTextureRequest {
  textureFileName: string
  textureX: number
  textureY: number
  x: number
  y: number
  isBg: boolean
  isTree: boolean
  flippedX?: boolean
  flags?: number
  treeScale?: number
  treeItemOnTree?: number
  treeOverlayX?: number
  treeOverlayY?: number
  baseColor?: number
  overlayColor?: number
}

/** Deterministic Pixi texture cache key for a resolved tile or composited tree sprite. */
export function getTileTextureCacheKey(req: {
  textureFileName: string
  textureX: number
  textureY: number
  isTree?: boolean
  treeScale?: number
  treeItemOnTree?: number
  treeOverlayX?: number
  treeOverlayY?: number
  baseColor?: number
  overlayColor?: number
}): string {
  if (req.isTree) {
    const scaleKey = req.treeScale ?? 1
    const fruitKey = req.treeItemOnTree && req.treeItemOnTree > 0 ? Math.min(4, req.treeItemOnTree) : 0
    return `tree_${req.textureFileName}_${req.textureX}_${req.textureY}_${req.treeOverlayX}_${req.treeOverlayY}_${req.baseColor}_${req.overlayColor}_${scaleKey}_${fruitKey}`
  }
  return `${req.textureFileName}_${req.textureX}_${req.textureY}`
}

/** Collect deduplicated atlas tile coordinates required to render a list of TileTextureRequests. */
export function collectUniqueAtlasRequests(
  requests: TileTextureRequest[],
): Array<{ textureFileName: string; textureX: number; textureY: number }> {
  const seen = new Set<string>()
  const out: Array<{ textureFileName: string; textureX: number; textureY: number }> = []
  const add = (textureFileName: string, textureX: number, textureY: number) => {
    const k = `${textureFileName}:${textureX}:${textureY}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ textureFileName, textureX, textureY })
  }
  for (const req of requests) {
    add(req.textureFileName, req.textureX, req.textureY)
    if (req.isTree && req.treeOverlayX !== undefined && req.treeOverlayY !== undefined) {
      add('tiles_page1.rttex', req.treeOverlayX, req.treeOverlayY)
    }
  }
  return out
}

export function clampOffset(
  ox: number,
  oy: number,
  worldW: number,
  worldH: number,
  screenW: number,
  screenH: number,
): { x: number; y: number } {
  const x = worldW <= screenW
    ? (screenW - worldW) / 2
    : Math.min(0, Math.max(screenW - worldW, ox))
  const y = worldH <= screenH
    ? (screenH - worldH) / 2
    : Math.min(0, Math.max(screenH - worldH, oy))
  return { x, y }
}

export function colorForTile(tile: TileData, colors: Record<number, number>) {
  if (tile.fg === 0) return null
  return colors[tile.fg] ?? 0x4a4a5a
}

export function colorToCss(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`
}

export async function createCompositeTreeTexture(
  baseUrl: string,
  overlayUrl: string,
  baseColor?: Color,
  overlayColor?: Color,
  scale: number = 1,
  fruitCount: number = 0,
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    if (!ctx) {
      reject(new Error('Could not get canvas context'))
      return
    }

    const baseImg = new Image()
    const overlayImg = new Image()

    let baseLoaded = false
    let overlayLoaded = false

    const applyTint = (img: HTMLImageElement, tint?: Color) => {
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = 32
      tempCanvas.height = 32
      const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })
      if (!tempCtx) return null
      tempCtx.drawImage(img, 0, 0, 32, 32)
      if (tint && tint.getUint() !== 0xFFFFFFFF) {
        const imageData = tempCtx.getImageData(0, 0, 32, 32)
        const data = imageData.data
        const r = tint.getRed() / 255
        const g = tint.getGreen() / 255
        const b = tint.getBlue() / 255
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) {
            data[i] = Math.floor(data[i] * r)
            data[i + 1] = Math.floor(data[i + 1] * g)
            data[i + 2] = Math.floor(data[i + 2] * b)
          }
        }
        tempCtx.putImageData(imageData, 0, 0)
      }
      return tempCanvas
    }

    const tryRender = () => {
      if (!baseLoaded || !overlayLoaded) return

      ctx.clearRect(0, 0, 32, 32)
      const clampedScale = Math.max(0.4, Math.min(1, scale))
      const drawW = 32 * clampedScale
      const drawH = 32 * clampedScale
      const drawX = (32 - drawW) / 2
      const drawY = 32 - drawH

      const baseCanvas = applyTint(baseImg, baseColor)
      const overlayCanvas = applyTint(overlayImg, overlayColor)
      if (!baseCanvas || !overlayCanvas) {
        reject(new Error('Could not get temp canvas context'))
        return
      }
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(baseCanvas, drawX, drawY, drawW, drawH)
      ctx.drawImage(overlayCanvas, drawX, drawY, drawW, drawH)

      if (fruitCount > 0 && clampedScale >= 0.99) {
        const fruitHex = overlayColor && overlayColor.getUint() !== 0xFFFFFFFF
          ? `#${(overlayColor.getRed() & 0xff).toString(16).padStart(2, '0')}${(overlayColor.getGreen() & 0xff).toString(16).padStart(2, '0')}${(overlayColor.getBlue() & 0xff).toString(16).padStart(2, '0')}`
          : '#fbbf24'
        const pips = [
          [11, 10],
          [19, 12],
          [14, 15],
          [17, 7],
        ].slice(0, Math.min(4, fruitCount))
        for (const [fx, fy] of pips) {
          ctx.fillStyle = '#0f172a'
          ctx.fillRect(fx - 1, fy - 1, 5, 5)
          ctx.fillStyle = fruitHex
          ctx.fillRect(fx, fy, 3, 3)
        }
      }

      resolve(canvas)
    }

    baseImg.crossOrigin = 'anonymous'
    overlayImg.crossOrigin = 'anonymous'

    baseImg.onload = () => {
      baseLoaded = true
      tryRender()
    }
    baseImg.onerror = () => reject(new Error(`Failed to load base image: ${baseUrl}`))

    overlayImg.onload = () => {
      overlayLoaded = true
      tryRender()
    }
    overlayImg.onerror = () => reject(new Error(`Failed to load overlay image: ${overlayUrl}`))

    baseImg.src = baseUrl
    overlayImg.src = overlayUrl
  })
}

export function getTileTextureRequest(
  tileManager: TileManager,
  itemMap: Map<number, ItemRecord>,
  tile: TileLayerTile,
  isBg: boolean
): TileTextureRequest | null {
  const itemId = isBg ? tile.bgItemId : tile.fgItemId
  if (itemId === 0) return null
  const item = itemMap.get(itemId)
  if (!item) return null

  const flippedX = !isBg && (tile.flags & TILE_FLAGS.FLIPPED) !== 0
  const isSeed = !isBg && (tile.fgItemId % 2 === 1 || tile.tileType?.type === 'Seed')

  if (isSeed) {
    const baseColor = item.base_color ? new Color(item.base_color) : new Color(0xFFFFFFFF)
    const overlayColor = item.overlay_color ? new Color(item.overlay_color) : new Color(0xFFFFFFFF)
    const age =
      tile.tileType?.type === 'Seed' && typeof tile.tileType.age === 'number'
        ? tile.tileType.age
        : item.grow_time
    const itemOnTree =
      tile.tileType?.type === 'Seed' && typeof tile.tileType.item_on_tree === 'number'
        ? tile.tileType.item_on_tree
        : 0
    const rawProgress = item.grow_time > 0 ? Math.max(0, Math.min(1, age / item.grow_time)) : 1
    // Quantize growth into 4 visual stages so texture cache stays bounded
    const treeScale = rawProgress >= 1 ? 1 : rawProgress < 0.25 ? 0.45 : rawProgress < 0.6 ? 0.68 : 0.85

    return {
      textureFileName: "tiles_page1.rttex",
      textureX: item.tree_base_sprite,
      textureY: 19,
      x: tile.x,
      y: tile.y,
      isBg: false,
      isTree: true,
      flippedX,
      flags: tile.flags,
      treeScale,
      treeItemOnTree: rawProgress >= 1 ? itemOnTree : 0,
      treeOverlayY: 18,
      treeOverlayX: item.tree_overlay_sprite,
      baseColor: baseColor.getUint(),
      overlayColor: overlayColor.getUint(),
    }
  }

  const coords = tileManager.getSpriteCoords(tile, isBg)
  return {
    textureFileName: item.texture_file_name,
    textureX: coords.x,
    textureY: coords.y,
    x: tile.x,
    y: tile.y,
    isBg,
    isTree: false,
    flippedX,
    flags: tile.flags,
  }
}

export async function getOrCreateTileTexture(
  req: {
    textureFileName: string
    textureX: number
    textureY: number
    isTree?: boolean
    treeScale?: number
    treeItemOnTree?: number
    treeOverlayX?: number
    treeOverlayY?: number
    baseColor?: number
    overlayColor?: number
  },
  textureCache: Map<string, Texture>
): Promise<Texture | null> {
  const key = getTileTextureCacheKey(req)

  const cached = textureCache.get(key)
  if (cached && !cached.destroyed) {
    return cached
  }

  if (req.isTree && req.treeOverlayY !== undefined && req.treeOverlayX !== undefined) {
    try {
      const trunkUrl = await textureCacheManager.getCroppedTile(req.textureFileName, req.textureX, req.textureY)
      const overlayUrl = await textureCacheManager.getCroppedTile(
        "tiles_page1.rttex",
        req.treeOverlayX,
        req.treeOverlayY
      )
      if (!trunkUrl || !overlayUrl) return null
      const baseColor = req.baseColor && req.baseColor !== 0 ? new Color(req.baseColor) : undefined
      const overlayColor = req.overlayColor && req.overlayColor !== 0 ? new Color(req.overlayColor) : undefined
      const compositeCanvas = await createCompositeTreeTexture(
        trunkUrl,
        overlayUrl,
        baseColor,
        overlayColor,
        req.treeScale ?? 1,
        req.treeItemOnTree ?? 0,
      )
      const texture = Texture.from(compositeCanvas)
      textureCache.set(key, texture)
      return texture
    } catch {
      return null
    }
  }

  try {
    const url = await textureCacheManager.getCroppedTile(req.textureFileName, req.textureX, req.textureY)
    if (!url) return null
    const img = new Image()
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = reject
      setTimeout(() => reject(new Error('Image load timeout')), 5000)
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    const texture = Texture.from(canvas)
    textureCache.set(key, texture)
    return texture
  } catch {
    return null
  }
}

export function renderTilesInitial(
  container: Container,
  b: LiveBot,
  colors: Record<number, number>
) {
  container.removeChildren()
  const g = new Graphics()
  for (let i = 0; i < b.tiles.length; i++) {
    const tile = b.tiles[i]
    if (tile.fg === 0) continue
    const color = colors[tile.fg] ?? 0x4a4a5a
    const tx = (i % b.world_width) * TILE_PX
    const ty = Math.floor(i / b.world_width) * TILE_PX
    g.rect(tx, ty, TILE_PX, TILE_PX).fill(color)
  }
  container.addChild(g)
}
