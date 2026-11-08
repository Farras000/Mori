import { useEffect, useRef, useState, useCallback } from 'react'
import { Application, Container, Graphics, Sprite, Texture, Text } from 'pixi.js'
import { useAtomValue } from 'jotai'
import { itemsMapAtom, itemColorsAtom, type LiveBot } from '@/lib/store'
import { api } from '@/lib/api'
import { moriWs } from '@/lib/ws'
import { TileManager, type TileData as TileManagerData, type WorldData } from '@/lib/tile-manager'
import { textureCacheManager } from '@/lib/texture-cache'
import { stripGTColors } from '@/lib/gt-colors'
import {
  TILE_PX,
  MIN_ZOOM,
  MAX_ZOOM,
  type SpriteTileLayer,
  clampOffset,
  getTileTextureRequest,
  getOrCreateTileTexture,
  renderTilesInitial,
} from '@/lib/tile-layer'
import { cn } from '@/lib/utils'

interface GameCanvasProps {
  bot: LiveBot
  activeItemId: number // 18 = punch, 32 = wrench, other = place item
  actionReach?: number // default 4
  onTileHover?: (tile: { x: number; y: number; inReach: boolean } | null) => void
  onPlayerWrench?: (netId: number) => void
  className?: string
}

export function GameCanvas({
  bot,
  activeItemId,
  actionReach = 4,
  onTileHover,
  onPlayerWrench,
  className,
}: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const botRef = useRef(bot)
  botRef.current = bot

  const itemsMap = useAtomValue(itemsMapAtom)
  const items = Array.from(itemsMap.values())
  const itemColors = useAtomValue(itemColorsAtom)
  const itemColorsRef = useRef(itemColors)
  itemColorsRef.current = itemColors

  const tileManagerRef = useRef<TileManager | null>(null)
  const spriteTileLayerRef = useRef<SpriteTileLayer | null>(null)
  const pixiTextureCacheRef = useRef<Map<string, Texture>>(new Map())
  const previousTilesRef = useRef(bot.tiles)

  const [loadingProgress, setLoadingProgress] = useState<{ current: number; total: number; stage: string } | null>(null)

  // Camera and sub-pixel position state
  const zoom = useRef(2.5) // Default comfortable game zoom
  const offset = useRef({ x: 0, y: 0 })
  const botPosRef = useRef({ x: bot.pos_x, y: bot.pos_y })
  const isMouseDownRef = useRef(false)
  const lastHoldTileRef = useRef<{ x: number; y: number } | null>(null)
  const facingLeftRef = useRef(false)

  // Display layers inside Pixi world container
  const layersRef = useRef<{
    world: Container
    tiles: Container
    objects: Graphics
    players: Container
    botGfx: Container
    labels: Container
    hoverGfx: Graphics
  } | null>(null)

  // Listen to 50Hz subpixel BotMove directly via WS
  useEffect(() => {
    const unsub = moriWs.subscribePos(bot.id, (x, y) => {
      const prevX = botPosRef.current.x
      if (x < prevX - 0.01) {
        facingLeftRef.current = true
      } else if (x > prevX + 0.01) {
        facingLeftRef.current = false
      }
      botPosRef.current = { x, y }
    })
    return () => unsub()
  }, [bot.id])

  // Center camera on bot position
  const centerCamera = useCallback(() => {
    const app = appRef.current
    if (!app) return
    const b = botRef.current
    const bw = b.world_width * TILE_PX * zoom.current
    const bh = b.world_height * TILE_PX * zoom.current

    const targetX = app.screen.width / 2 - botPosRef.current.x * TILE_PX * zoom.current
    const targetY = app.screen.height / 2 - botPosRef.current.y * TILE_PX * zoom.current

    offset.current = clampOffset(targetX, targetY, bw, bh, app.screen.width, app.screen.height)

    const world = layersRef.current?.world
    if (world) {
      world.scale.set(zoom.current)
      world.x = offset.current.x
      world.y = offset.current.y
    }
  }, [])

  // Initialize Pixi application
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let mounted = true

    const app = new Application()
    appRef.current = app

    app.init({
      resizeTo: el,
      backgroundColor: 0x070b0e,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(() => {
      if (!mounted) {
        app.destroy(true, { children: true })
        return
      }

      el.appendChild(app.canvas)

      const world = new Container()
      const tileContainer = new Container()
      const objectGfx = new Graphics()
      const playerContainer = new Container()
      const botContainer = new Container()
      const labelContainer = new Container()
      const hoverGfx = new Graphics()

      world.addChild(tileContainer)
      world.addChild(objectGfx)
      world.addChild(playerContainer)
      world.addChild(botContainer)
      world.addChild(hoverGfx)
      world.addChild(labelContainer)

      app.stage.addChild(world)

      layersRef.current = {
        world,
        tiles: tileContainer,
        objects: objectGfx,
        players: playerContainer,
        botGfx: botContainer,
        labels: labelContainer,
        hoverGfx,
      }

      // Initial fast render of current tiles
      const b = botRef.current
      if (b.tiles.length > 0) {
        renderTilesInitial(tileContainer, b, itemColorsRef.current)
      }

      // ── Main Game Render Loop (60 FPS Ticker) ─────────────────────────
      let animTick = 0
      app.ticker.add(() => {
        animTick++
        const curBot = botRef.current
        const layers = layersRef.current
        if (!layers) return

        // 1. Smooth Camera Follow
        const targetCamX = app.screen.width / 2 - botPosRef.current.x * TILE_PX * zoom.current
        const targetCamY = app.screen.height / 2 - botPosRef.current.y * TILE_PX * zoom.current
        const bw = curBot.world_width * TILE_PX * zoom.current
        const bh = curBot.world_height * TILE_PX * zoom.current
        const clamped = clampOffset(targetCamX, targetCamY, bw, bh, app.screen.width, app.screen.height)

        // Exponential smoothing (lerp)
        offset.current.x += (clamped.x - offset.current.x) * 0.18
        offset.current.y += (clamped.y - offset.current.y) * 0.18

        layers.world.scale.set(zoom.current)
        layers.world.x = Math.round(offset.current.x)
        layers.world.y = Math.round(offset.current.y)

        // Inverse scale labels for crisp text
        const invScale = 1 / Math.max(0.2, zoom.current)
        layers.labels.scale.set(invScale)

        // 2. Draw Bot Character Sprite
        const botG = layers.botGfx
        botG.removeChildren()

        const charContainer = new Container()
        const px = botPosRef.current.x * TILE_PX + TILE_PX / 2
        const py = (botPosRef.current.y + 1) * TILE_PX
        charContainer.position.set(px, py)

        // Horizontal flip according to facing direction
        charContainer.scale.x = facingLeftRef.current ? -1 : 1

        const charGraphics = new Graphics()
        // Walking bob
        const isWalking = curBot.delays.walk_ms > 0
        const bob = isWalking ? Math.sin(animTick * 0.25) * 1.5 : 0

        // Legs / Pants
        charGraphics.rect(-6, -10 + bob, 5, 10 - bob).fill(0x1e3a8a) // Left leg (blue jeans)
        charGraphics.rect(1, -10 - bob, 5, 10 + bob).fill(0x1e3a8a)  // Right leg
        // Torso / Shirt
        charGraphics.rect(-8, -20, 16, 12).fill(0xef4444) // Red shirt
        // Arms
        charGraphics.rect(-10, -19, 3, 9).fill(0xfca5a5) // Left arm
        charGraphics.rect(7, -19, 3, 9).fill(0xfca5a5)  // Right arm
        // Head / Face
        charGraphics.rect(-7, -30, 14, 11).fill(0xfde047) // Skin tone
        // Eyes
        charGraphics.rect(2, -26, 2, 4).fill(0x000000)  // Eye
        // Hair
        charGraphics.rect(-7, -33, 14, 4).fill(0x78350f)  // Brown hair

        charContainer.addChild(charGraphics)
        botG.addChild(charContainer)

        // Bot Overhead Nametag
        const nameX = px * zoom.current
        const nameY = (py - 36) * zoom.current
        const botLabel = new Text({
          text: curBot.username || 'You',
          style: {
            fontSize: 10,
            fontFamily: 'Inter, system-ui, sans-serif',
            fontWeight: 'bold',
            fill: 0x4ade80,
            stroke: { color: 0x000000, width: 3 },
          },
          resolution: 2,
        })
        botLabel.anchor.set(0.5, 1)
        botLabel.position.set(nameX, nameY)

        // 3. Render Other Players
        const playersG = layers.players
        playersG.removeChildren()
        for (const p of curBot.players.values()) {
          const pg = new Graphics()
          const pPx = p.pos_x * TILE_PX + TILE_PX / 2
          const pPy = (p.pos_y + 1) * TILE_PX

          // Other player body (cyan shirt)
          pg.rect(pPx - 6, pPy - 10, 12, 10).fill(0x1e3a8a)
          pg.rect(pPx - 8, pPy - 20, 16, 11).fill(0x0284c7)
          pg.rect(pPx - 7, pPy - 30, 14, 11).fill(0xfde047)
          pg.rect(pPx + 2, pPy - 26, 2, 4).fill(0x000000)
          playersG.addChild(pg)

          // Other player nametag
          const pCleanName = stripGTColors(p.name) || `Player #${p.net_id}`
          const pText = new Text({
            text: pCleanName,
            style: {
              fontSize: 10,
              fontFamily: 'Inter, system-ui, sans-serif',
              fontWeight: '600',
              fill: 0xffffff,
              stroke: { color: 0x000000, width: 3 },
            },
            resolution: 2,
          })
          pText.anchor.set(0.5, 1)
          pText.position.set(pPx * zoom.current, (pPy - 36) * zoom.current)
          layers.labels.addChild(pText)
        }

        layers.labels.removeChildren()
        layers.labels.addChild(botLabel)
      })

      centerCamera()
    })

    return () => {
      mounted = false
      if (appRef.current) {
        appRef.current.destroy(true, { children: true })
        appRef.current = null
      }
      layersRef.current = null
      pixiTextureCacheRef.current.clear()
    }
  }, [centerCamera])

  // Update world tiles with TileManager textures
  useEffect(() => {
    const layers = layersRef.current
    if (!layers || bot.tiles.length === 0 || items.length === 0) return

    const tileManagerData: TileManagerData[] = bot.tiles.map((t, idx) => ({
      fgItemId: t.fg,
      bgItemId: t.bg,
      flags: t.flags,
      x: idx % bot.world_width,
      y: Math.floor(idx / bot.world_width),
    }))

    const worldData: WorldData = {
      width: bot.world_width,
      height: bot.world_height,
      tiles: tileManagerData,
    }

    if (!tileManagerRef.current) {
      tileManagerRef.current = new TileManager(worldData, items)
    } else {
      tileManagerRef.current.updateWorldData(worldData)
      tileManagerRef.current.updateItems(items)
    }

    const tileManager = tileManagerRef.current
    const itemMap = itemsMap
    const textureCache = pixiTextureCacheRef.current

    let layer = spriteTileLayerRef.current
    const needsFullRender =
      !layer ||
      layer.width !== bot.world_width ||
      layer.height !== bot.world_height ||
      !previousTilesRef.current ||
      previousTilesRef.current.length !== bot.tiles.length

    if (!needsFullRender && layer) {
      // Incremental render
      previousTilesRef.current = bot.tiles
      return
    }

    // Full render
    layers.tiles.removeChildren()
    const bgContainer = new Container()
    const fgContainer = new Container()
    layers.tiles.addChild(bgContainer)
    layers.tiles.addChild(fgContainer)

    layer = {
      bgContainer,
      fgContainer,
      bgSprites: new Array(bot.world_width * bot.world_height).fill(null),
      fgSprites: new Array(bot.world_width * bot.world_height).fill(null),
      width: bot.world_width,
      height: bot.world_height,
    }
    spriteTileLayerRef.current = layer

    const requests: Array<{
      req: NonNullable<ReturnType<typeof getTileTextureRequest>>
      idx: number
    }> = []

    for (let y = 0; y < bot.world_height; y++) {
      for (let x = 0; x < bot.world_width; x++) {
        const tile = tileManager.getTile(x, y)
        if (!tile) continue
        const idx = y * bot.world_width + x
        const bgReq = getTileTextureRequest(tileManager, itemMap, tile, true)
        if (bgReq) requests.push({ req: bgReq, idx })
        const fgReq = getTileTextureRequest(tileManager, itemMap, tile, false)
        if (fgReq) requests.push({ req: fgReq, idx })
      }
    }

    // Load textures
    const CHUNK_SIZE = 200
    ;(async () => {
      for (let chunkStart = 0; chunkStart < requests.length; chunkStart += CHUNK_SIZE) {
        const chunk = requests.slice(chunkStart, chunkStart + CHUNK_SIZE)
        setLoadingProgress({
          current: chunkStart,
          total: requests.length,
          stage: 'loading',
        })

        const chunkTextureReqs = chunk.map((c) => ({
          textureFileName: c.req.textureFileName,
          textureX: c.req.textureX,
          textureY: c.req.textureY,
        }))

        await textureCacheManager.batchLoadTiles(chunkTextureReqs)

        for (const item of chunk) {
          const texture = await getOrCreateTileTexture(item.req, textureCache)
          if (texture) {
            const sprite = new Sprite(texture)
            sprite.x = item.req.x * TILE_PX
            sprite.y = item.req.y * TILE_PX
            sprite.width = TILE_PX
            sprite.height = TILE_PX

            if (item.req.isBg) {
              bgContainer.addChild(sprite)
              layer!.bgSprites[item.idx] = sprite
            } else {
              fgContainer.addChild(sprite)
              layer!.fgSprites[item.idx] = sprite
            }
          }
        }
      }
      setLoadingProgress(null)
      previousTilesRef.current = bot.tiles
    })().catch(() => setLoadingProgress(null))
  }, [bot.tiles, bot.world_width, bot.world_height, items])

  // Update floating objects
  useEffect(() => {
    const layers = layersRef.current
    if (!layers) return
    const g = layers.objects
    g.clear()
    for (const obj of bot.objects) {
      const px = obj.x * TILE_PX
      const py = obj.y * TILE_PX
      g.circle(px + TILE_PX / 2, py + TILE_PX / 2, 2.5).fill(0xf5c518)
    }
  }, [bot.objects])

  // Mouse wheel zoom
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY < 0 ? 1.15 : 0.87
      zoom.current = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom.current * delta))
      centerCamera()
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [centerCamera])

  // Mouse Interaction: Hold-to-Punch & Player Wrench Hit-test
  const getTileUnderCursor = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const tileX = Math.floor((mx - offset.current.x) / (zoom.current * TILE_PX))
    const tileY = Math.floor((my - offset.current.y) / (zoom.current * TILE_PX))
    return { tileX, tileY }
  }

  const checkHitPlayer = (tileX: number, tileY: number): number | null => {
    // Check self first
    const selfTileX = Math.floor(botPosRef.current.x)
    const selfTileY = Math.floor(botPosRef.current.y)
    if (tileX >= selfTileX && tileX <= selfTileX + 1 && tileY >= selfTileY && tileY <= selfTileY + 1) {
      return bot.net_id || 1
    }
    // Check other players
    for (const p of bot.players.values()) {
      const ptx = Math.floor(p.pos_x)
      const pty = Math.floor(p.pos_y)
      if (tileX >= ptx && tileX <= ptx + 1 && tileY >= pty && tileY <= pty + 1) {
        return p.net_id
      }
    }
    return null
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 2) {
      // Right-click = context wrench tile
      e.preventDefault()
      const { tileX, tileY } = getTileUnderCursor(e)
      const hitNetId = checkHitPlayer(tileX, tileY)
      if (hitNetId) {
        api.sendCmd(bot.id, { type: 'wrench_player', net_id: hitNetId }).catch(() => {})
        onPlayerWrench?.(hitNetId)
        return
      }
      const ox = tileX - Math.floor(botPosRef.current.x)
      const oy = tileY - Math.floor(botPosRef.current.y)
      api.sendCmd(bot.id, { type: 'wrench', x: ox, y: oy }).catch(() => {})
      return
    }

    if (e.button !== 0) return
    isMouseDownRef.current = true

    const { tileX, tileY } = getTileUnderCursor(e)
    if (tileX < 0 || tileY < 0 || tileX >= bot.world_width || tileY >= bot.world_height) return

    // If using Wrench tool, test player hit first!
    if (activeItemId === 32) {
      const hitNetId = checkHitPlayer(tileX, tileY)
      if (hitNetId) {
        api.sendCmd(bot.id, { type: 'wrench_player', net_id: hitNetId }).catch(() => {})
        onPlayerWrench?.(hitNetId)
        return
      }
    }

    lastHoldTileRef.current = { x: tileX, y: tileY }
    api.sendCmd(bot.id, {
      type: 'hold_action',
      active: true,
      x: tileX,
      y: tileY,
      item: activeItemId,
    }).catch(() => {})
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { tileX, tileY } = getTileUnderCursor(e)
    const inBounds = tileX >= 0 && tileY >= 0 && tileX < bot.world_width && tileY < bot.world_height

    if (!inBounds) {
      onTileHover?.(null)
      layersRef.current?.hoverGfx.clear()
      return
    }

    const curBotTileX = Math.floor(botPosRef.current.x)
    const curBotTileY = Math.floor(botPosRef.current.y)
    const inReach =
      Math.abs(tileX - curBotTileX) <= actionReach &&
      Math.abs(tileY - curBotTileY) <= actionReach

    onTileHover?.({ x: tileX, y: tileY, inReach })

    // Draw hover rectangle
    const hg = layersRef.current?.hoverGfx
    if (hg) {
      hg.clear()
      const color = inReach ? 0x22c55e : 0xef4444
      hg.rect(tileX * TILE_PX, tileY * TILE_PX, TILE_PX, TILE_PX)
        .stroke({ color, width: 1.5, alpha: 0.85 })
    }

    // If mouse is held down and dragged to another tile, transition hold action
    if (isMouseDownRef.current) {
      const last = lastHoldTileRef.current
      if (!last || last.x !== tileX || last.y !== tileY) {
        lastHoldTileRef.current = { x: tileX, y: tileY }
        api.sendCmd(bot.id, {
          type: 'hold_action',
          active: true,
          x: tileX,
          y: tileY,
          item: activeItemId,
        }).catch(() => {})
      }
    }
  }

  const handleMouseUp = () => {
    if (isMouseDownRef.current) {
      isMouseDownRef.current = false
      lastHoldTileRef.current = null
      api.sendCmd(bot.id, {
        type: 'hold_action',
        active: false,
        x: 0,
        y: 0,
        item: 0,
      }).catch(() => {})
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full h-full cursor-crosshair overflow-hidden select-none', className)}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        handleMouseUp()
        onTileHover?.(null)
        layersRef.current?.hoverGfx.clear()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {loadingProgress && (
        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none">
          <div className="text-xs text-white font-medium">
            {loadingProgress.stage === 'loading' ? 'Loading game textures...' : 'Decoding sprites...'}
          </div>
          <div className="w-40 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-150"
              style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
