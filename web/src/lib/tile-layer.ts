import { Container, Sprite, Texture, Graphics } from 'pixi.js'
import { Color } from '@/lib/color'
import { textureCacheManager } from '@/lib/texture-cache'
import { TileManager, type TileData as TileManagerData } from '@/lib/tile-manager'
import type { ItemRecord } from '@/lib/api'
import type { LiveBot } from '@/lib/store'
import type { TileData } from '@/lib/ws'

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
  treeOverlayX?: number
  treeOverlayY?: number
  baseColor?: number
  overlayColor?: number
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
  overlayColor?: Color
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

    const tryRender = () => {
      if (!baseLoaded || !overlayLoaded) return

      ctx.clearRect(0, 0, 32, 32)

      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = 32
      tempCanvas.height = 32
      const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })

      if (!tempCtx) {
        reject(new Error('Could not get temp canvas context'))
        return
      }

      tempCtx.drawImage(baseImg, 0, 0, 32, 32)
      if (baseColor) {
        const imageData = tempCtx.getImageData(0, 0, 32, 32)
        const data = imageData.data
        const r = baseColor.getRed() / 255
        const g = baseColor.getGreen() / 255
        const b = baseColor.getBlue() / 255

        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) {
            data[i] = Math.floor(data[i] * r)
            data[i + 1] = Math.floor(data[i + 1] * g)
            data[i + 2] = Math.floor(data[i + 2] * b)
          }
        }
        tempCtx.putImageData(imageData, 0, 0)
      }
      ctx.drawImage(tempCanvas, 0, 0)

      tempCtx.clearRect(0, 0, 32, 32)
      tempCtx.drawImage(overlayImg, 0, 0, 32, 32)

      if (overlayColor && overlayColor.getUint() !== 0xFFFFFFFF) {
        const overlayData = tempCtx.getImageData(0, 0, 32, 32)
        const data = overlayData.data
        const r = overlayColor.getRed() / 255
        const g = overlayColor.getGreen() / 255
        const b = overlayColor.getBlue() / 255

        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) {
            data[i] = Math.floor(data[i] * r)
            data[i + 1] = Math.floor(data[i + 1] * g)
            data[i + 2] = Math.floor(data[i + 2] * b)
          }
        }
        tempCtx.putImageData(overlayData, 0, 0)
      }

      ctx.drawImage(tempCanvas, 0, 0)
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
  tile: TileManagerData,
  isBg: boolean
): TileTextureRequest | null {
  const itemId = isBg ? tile.bgItemId : tile.fgItemId
  if (itemId === 0) return null
  const item = itemMap.get(itemId)
  if (!item) return null

  if (!isBg && tile.fgItemId % 2 === 1) {
    const treeItemId = tile.fgItemId + 1
    const treeItem = itemMap.get(treeItemId)
    if (treeItem) {
      const baseColor = item.base_color ? new Color(item.base_color) : new Color(0xFFFFFFFF)
      const overlayColor = item.overlay_color ? new Color(item.overlay_color) : new Color(0xFFFFFFFF)
      return {
        textureFileName: "tiles_page1.rttex",
        textureX: item.tree_base_sprite,
        textureY: 19,
        x: tile.x,
        y: tile.y,
        isBg: false,
        isTree: true,
        treeOverlayY: 18,
        treeOverlayX: item.tree_overlay_sprite,
        baseColor: baseColor.getUint(),
        overlayColor: overlayColor.getUint(),
      }
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
  }
}

export async function getOrCreateTileTexture(
  req: {
    textureFileName: string
    textureX: number
    textureY: number
    isTree?: boolean
    treeOverlayX?: number
    treeOverlayY?: number
    baseColor?: number
    overlayColor?: number
  },
  textureCache: Map<string, Texture>
): Promise<Texture | null> {
  const key = req.isTree
    ? `tree_${req.textureFileName}_${req.treeOverlayX}_${req.treeOverlayY}_${req.baseColor}_${req.overlayColor}`
    : `${req.textureFileName}_${req.textureX}_${req.textureY}`

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
      const baseColor = req.baseColor && req.baseColor !== 0 ? new Color(req.baseColor) : undefined
      const overlayColor = req.overlayColor && req.overlayColor !== 0 ? new Color(req.overlayColor) : undefined
      const compositeCanvas = await createCompositeTreeTexture(trunkUrl, overlayUrl, baseColor, overlayColor)
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
