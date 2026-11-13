import { useEffect, useRef, useState, useCallback } from 'react'
import { Application, Container, Graphics, Sprite, Texture, Text } from 'pixi.js'
import { useAtom, useAtomValue } from 'jotai'
import { itemsMapAtom, itemColorsAtom, talkBubblesAtom, type LiveBot, type TalkBubbleEntry } from '@/lib/store'
import { api } from '@/lib/api'
import { moriWs } from '@/lib/ws'
import { TILE_FLAGS } from '@/lib/constants'
import { TileManager, type WorldData } from '@/lib/tile-manager'
import { textureCacheManager } from '@/lib/texture-cache'
import { stripGTColors } from '@/lib/gt-colors'
import {
  TILE_PX,
  MIN_ZOOM,
  MAX_ZOOM,
  type SpriteTileLayer,
  type TileLayerTile,
  clampOffset,
  collectUniqueAtlasRequests,
  getTileTextureCacheKey,
  getTileTextureRequest,
  getOrCreateTileTexture,
  renderTilesInitial,
} from '@/lib/tile-layer'
import {
  loadGtCharacterTextures,
  loadGtWorldUiTextures,
  createGtCharacterRig,
  getGtSeedTexture,
  loadCrispTextureFromUrl,
  type GtCharacterTextures,
  type GtWorldUiTextures,
  type GtCharacterRig,
} from '@/lib/gt-sprites'
import { getIsolatedSpriteCoords } from '@/components/texture-image'
import { cn } from '@/lib/utils'

interface WeatherTheme {
  top: number
  mid: number
  low: number
  showSun: boolean
  showMoon: boolean
  stars: boolean
  cloudTint: number
  cloudAlpha: number
}

const WEATHER_THEMES: Record<number, WeatherTheme> = {
  0: { top: 0x5eb2e9, mid: 0x8ad0f6, low: 0xbfe6fb, showSun: true, showMoon: false, stars: false, cloudTint: 0xffffff, cloudAlpha: 0.85 },
  2: { top: 0x581c87, mid: 0xea580c, low: 0xfde047, showSun: true, showMoon: false, stars: false, cloudTint: 0xfdba74, cloudAlpha: 0.72 }, // Sunset
  4: { top: 0x0b1120, mid: 0x1e293b, low: 0x334155, showSun: false, showMoon: true, stars: true, cloudTint: 0x64748b, cloudAlpha: 0.45 }, // Night
  5: { top: 0xc2410c, mid: 0xea580c, low: 0xfed7aa, showSun: true, showMoon: false, stars: false, cloudTint: 0xfef3c7, cloudAlpha: 0.55 }, // Desert
  11: { top: 0x334155, mid: 0x475569, low: 0x64748b, showSun: false, showMoon: false, stars: false, cloudTint: 0x475569, cloudAlpha: 0.88 }, // Rainy / Storm
  15: { top: 0x2e1065, mid: 0x4c1d95, low: 0x5b21b6, showSun: false, showMoon: true, stars: true, cloudTint: 0xa78bfa, cloudAlpha: 0.5 }, // Spooky
  29: { top: 0x60a5fa, mid: 0x93c5fd, low: 0xe0f2fe, showSun: true, showMoon: false, stars: false, cloudTint: 0xf8fafc, cloudAlpha: 0.9 }, // Snowy
  34: { top: 0x020617, mid: 0x0f172a, low: 0x1e1b4b, showSun: false, showMoon: false, stars: true, cloudTint: 0x312e81, cloudAlpha: 0.25 }, // Space
  36: { top: 0x020617, mid: 0x0f172a, low: 0x1e1b4b, showSun: false, showMoon: false, stars: true, cloudTint: 0x312e81, cloudAlpha: 0.25 },
  48: { top: 0x020617, mid: 0x0f172a, low: 0x1e1b4b, showSun: false, showMoon: false, stars: true, cloudTint: 0x312e81, cloudAlpha: 0.25 },
}

function getWeatherTheme(weatherId: number): WeatherTheme {
  return WEATHER_THEMES[weatherId] ?? WEATHER_THEMES[0]
}

const INTERACTIVE_TILE_TYPES = new Set([
  'Door',
  'Sign',
  'Lock',
  'VendingMachine',
  'DisplayBlock',
  'Shelf',
  'DonationBox',
  'Mailbox',
  'Bulletin',
  'WeatherMachine',
  'Mannequin',
  'Dice',
  'Forge',
  'CookingOven',
  'StorageBlock',
  'AudioRack',
  'HearthMonitor',
  'CountryFlag',
  'SilkWorm',
  'TesseractManipulator',
  'AchievementBlock',
  'Seed',
])

// Growtopia item action_type codes for interactive tiles (door/lock/sign/vending/shelf/etc.)
const INTERACTIVE_ACTION_TYPES = new Set([
  2, 3, 10, 13, 26, 27, 34, 37, 40, 41, 47, 49, 62, 63, 66, 81, 83, 91, 107, 122,
])

function computeTileTint(flags: number): number {
  const red = (flags & TILE_FLAGS.PAINTED_RED) !== 0
  const green = (flags & TILE_FLAGS.PAINTED_GREEN) !== 0
  const blue = (flags & TILE_FLAGS.PAINTED_BLUE) !== 0
  if (red || green || blue) {
    const r = red ? 0xff : 0x7a
    const g = green ? 0xff : 0x7a
    const b = blue ? 0xff : 0x7a
    return (r << 16) | (g << 8) | b
  }
  if ((flags & TILE_FLAGS.WET) !== 0) return 0x7dd3fc
  if ((flags & TILE_FLAGS.ON_FIRE) !== 0) return 0xfdba74
  return 0xffffff
}

interface GameCanvasProps {
  bot: LiveBot
  activeItemId: number // 18 = punch, 32 = wrench, other = place item
  actionReach?: number // default 2
  onTileHover?: (tile: { x: number; y: number; inReach: boolean } | null) => void
  onPlayerWrench?: (netId: number) => void
  className?: string
}

export function GameCanvas({
  bot,
  activeItemId,
  actionReach = 2,
  onTileHover,
  onPlayerWrench,
  className,
}: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const botRef = useRef(bot)
  botRef.current = bot

  const [itemsMap, setItemsMap] = useAtom(itemsMapAtom)
  const items = Array.from(itemsMap.values())
  const itemsMapRef = useRef(itemsMap)
  itemsMapRef.current = itemsMap
  const itemColors = useAtomValue(itemColorsAtom)
  const itemColorsRef = useRef(itemColors)
  itemColorsRef.current = itemColors
  const talkBubblesMap = useAtomValue(talkBubblesAtom)
  const botBubbles = talkBubblesMap.get(bot.id) ?? []
  const botBubblesRef = useRef<TalkBubbleEntry[]>(botBubbles)
  botBubblesRef.current = botBubbles

  const fetchedItemIdsRef = useRef<Set<number>>(new Set())
  const renderedKnownItemsRef = useRef<Set<number>>(new Set())
  const worldLayerKeyRef = useRef('')
  const fullRenderVersionRef = useRef(0)
  const fullRenderDoneRef = useRef(false)
  const queuedIncrementalRef = useRef<Set<number>>(new Set())

  const tileManagerRef = useRef<TileManager | null>(null)
  const spriteTileLayerRef = useRef<SpriteTileLayer | null>(null)
  const pixiTextureCacheRef = useRef<Map<string, Texture>>(new Map())
  const previousTilesRef = useRef(bot.tiles)

  const charTexRef = useRef<GtCharacterTextures | null>(null)
  const worldUiTexRef = useRef<GtWorldUiTextures | null>(null)
  const botRigStateRef = useRef<{ rig: GtCharacterRig; hasTextures: boolean } | null>(null)
  const botLabelRef = useRef<Text | null>(null)
  const playerRigsRef = useRef<
    Map<
      number,
      {
        rig: GtCharacterRig
        label: Text
        hasTextures: boolean
        lastX: number
        lastY: number
        facingLeft: boolean
        lastMovedAt: number
      }
    >
  >(new Map())
  const prevRenderPosRef = useRef({
    x: bot.pos_x,
    y: bot.pos_y,
    lastMovedAt: 0,
    lastVertAt: 0,
  })
  const lastActionAtRef = useRef(0)
  const lastWrenchAtRef = useRef(0)
  const cloudsRef = useRef<Array<{ sprite: Sprite; speed: number }>>([])
  const skyKeyRef = useRef('')
  const renderedBubblesSigRef = useRef('')
  const bubbleNodeRefs = useRef<Array<{ netId: number; expiresAt: number; container: Container; yOffset: number }>>([])

  const [loadingProgress, setLoadingProgress] = useState<{ current: number; total: number; stage: string } | null>(null)
  const [pixiReady, setPixiReady] = useState(false)
  const [worldUiReady, setWorldUiReady] = useState(false)

  // Camera and sub-pixel position state
  const zoom = useRef(2.8) // Native Growtopia 1-tile ~ 33.6px view scale
  const offset = useRef({ x: 0, y: 0 })
  const botPosRef = useRef<{ x: number; y: number; onGround?: boolean }>({ x: bot.pos_x, y: bot.pos_y })
  const isMouseDownRef = useRef(false)
  const lastHoldTileRef = useRef<{ x: number; y: number } | null>(null)
  const facingLeftRef = useRef(false)
  const tileDamageRef = useRef<
    Map<number, { x: number; y: number; damage: number; max_health: number; updatedAt: number }>
  >(new Map())

  // Display layers inside Pixi world container
  const layersRef = useRef<{
    world: Container
    sky: Container
    tiles: Container
    tileOverlays: Container
    crackGfx: Graphics
    objects: Container
    players: Container
    botGfx: Container
    labels: Container
    bubbles: Container
    hoverGfx: Graphics
  } | null>(null)

  const redrawCracks = useCallback(() => {
    const cg = layersRef.current?.crackGfx
    if (!cg) return
    cg.clear()
    for (const entry of tileDamageRef.current.values()) {
      if (entry.damage <= 0 || entry.max_health <= 0) continue
      const ratio = Math.min(1, entry.damage / entry.max_health)
      const stage = Math.max(1, Math.min(4, Math.ceil(ratio * 4)))
      const px = entry.x * TILE_PX
      const py = entry.y * TILE_PX
      // Subtle impact darkening + progressive Growtopia-style fracture lines
      cg.rect(px, py, TILE_PX, TILE_PX).fill({ color: 0x000000, alpha: 0.08 + stage * 0.05 })
      cg.moveTo(px + 14, py + 4).lineTo(px + 16, py + 13).lineTo(px + 12, py + 20)
      if (stage >= 2) {
        cg.moveTo(px + 16, py + 13).lineTo(px + 24, py + 17)
        cg.moveTo(px + 5, py + 12).lineTo(px + 13, py + 16)
      }
      if (stage >= 3) {
        cg.moveTo(px + 12, py + 20).lineTo(px + 7, py + 28)
        cg.moveTo(px + 18, py + 7).lineTo(px + 26, py + 9)
      }
      if (stage >= 4) {
        cg.moveTo(px + 16, py + 15).lineTo(px + 25, py + 27)
        cg.moveTo(px + 4, py + 22).lineTo(px + 15, py + 22)
      }
      cg.stroke({ color: 0x111111, width: 1.6, alpha: 0.9 })
    }
  }, [])

  // Keep position ref synchronized across bot switches and initial REST state hydration
  useEffect(() => {
    if (bot.pos_x !== 0 || bot.pos_y !== 0) {
      botPosRef.current = { x: bot.pos_x, y: bot.pos_y }
      prevRenderPosRef.current = { x: bot.pos_x, y: bot.pos_y, lastMovedAt: 0, lastVertAt: 0 }
    }
  }, [bot.id, bot.world_name])

  useEffect(() => {
    if (botPosRef.current.x === 0 && botPosRef.current.y === 0 && (bot.pos_x !== 0 || bot.pos_y !== 0)) {
      botPosRef.current = { x: bot.pos_x, y: bot.pos_y }
      prevRenderPosRef.current = { x: bot.pos_x, y: bot.pos_y, lastMovedAt: 0, lastVertAt: 0 }
    }
  }, [bot.pos_x, bot.pos_y])

  // Listen to 50Hz subpixel BotMove + progressive TileDamage events directly via WS
  useEffect(() => {
    const unsub = moriWs.subscribePos(bot.id, (x, y, onGround) => {
      const prevX = botPosRef.current.x
      if (x < prevX - 0.005) {
        facingLeftRef.current = true
      } else if (x > prevX + 0.005) {
        facingLeftRef.current = false
      }
      botPosRef.current = {
        x,
        y,
        onGround: onGround !== undefined ? onGround : botPosRef.current.onGround,
      }
    })

    const onTileDamage = (d: { bot_id: number; x: number; y: number; damage: number; max_health: number }) => {
      if (d.bot_id !== bot.id) return
      const key = d.y * 1024 + d.x
      if (d.damage <= 0 || d.max_health <= 0) {
        tileDamageRef.current.delete(key)
      } else {
        tileDamageRef.current.set(key, {
          x: d.x,
          y: d.y,
          damage: d.damage,
          max_health: d.max_health,
          updatedAt: performance.now(),
        })
      }
      redrawCracks()
    }
    const onTileUpdate = (d: { bot_id: number; x: number; y: number }) => {
      if (d.bot_id !== bot.id) return
      if (tileDamageRef.current.delete(d.y * 1024 + d.x)) {
        redrawCracks()
      }
    }
    const onWorldLoaded = (d: { bot_id: number }) => {
      if (d.bot_id !== bot.id) return
      tileDamageRef.current.clear()
      redrawCracks()
    }

    moriWs.bus.on('TileDamage', onTileDamage)
    moriWs.bus.on('TileUpdate', onTileUpdate)
    moriWs.bus.on('WorldLoaded', onWorldLoaded)

    return () => {
      unsub()
      moriWs.bus.off('TileDamage', onTileDamage)
      moriWs.bus.off('TileUpdate', onTileUpdate)
      moriWs.bus.off('WorldLoaded', onWorldLoaded)
      tileDamageRef.current.clear()
      redrawCracks()
    }
  }, [bot.id, redrawCracks])

  // Center camera on bot hitbox center
  const centerCamera = useCallback(() => {
    const app = appRef.current
    if (!app) return
    const b = botRef.current
    const bw = b.world_width * TILE_PX * zoom.current
    const bh = b.world_height * TILE_PX * zoom.current

    const targetX = app.screen.width / 2 - (botPosRef.current.x + 16 / 32) * TILE_PX * zoom.current
    const targetY = app.screen.height / 2 - (botPosRef.current.y + 17 / 32) * TILE_PX * zoom.current

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
      backgroundColor: 0x5eb2e9,
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
      const skyContainer = new Container()
      const tileContainer = new Container()
      const tileOverlayContainer = new Container()
      const crackGfx = new Graphics()
      const objectContainer = new Container()
      const playerContainer = new Container()
      const botContainer = new Container()
      const labelContainer = new Container()
      const bubbleContainer = new Container()
      const hoverGfx = new Graphics()

      world.addChild(skyContainer)
      world.addChild(tileContainer)
      world.addChild(tileOverlayContainer)
      world.addChild(crackGfx)
      world.addChild(objectContainer)
      world.addChild(playerContainer)
      world.addChild(botContainer)
      world.addChild(hoverGfx)
      world.addChild(labelContainer)
      world.addChild(bubbleContainer)

      app.stage.addChild(world)

      layersRef.current = {
        world,
        sky: skyContainer,
        tiles: tileContainer,
        tileOverlays: tileOverlayContainer,
        crackGfx,
        objects: objectContainer,
        players: playerContainer,
        botGfx: botContainer,
        labels: labelContainer,
        bubbles: bubbleContainer,
        hoverGfx,
      }

      // Initial fast render of current tiles
      const b = botRef.current
      if (b.tiles.length > 0) {
        renderTilesInitial(tileContainer, b, itemColorsRef.current)
      }

      loadGtCharacterTextures().then((tex) => {
        if (mounted && tex) charTexRef.current = tex
      })
      loadGtWorldUiTextures().then((tex) => {
        if (mounted && tex) {
          worldUiTexRef.current = tex
          setWorldUiReady(true)
        }
      })

      setPixiReady(true)

      // ── Main Game Render Loop (60 FPS Ticker) ─────────────────────────
      let animTick = 0
      app.ticker.add((ticker) => {
        animTick++
        const dtSec = Math.min(0.05, Math.max(0.001, (ticker.deltaMS || 16.667) / 1000))
        const curBot = botRef.current
        const layers = layersRef.current
        if (!layers) return

        // Prune healed tile cracks (>4.8s without hits) twice per second
        if (animTick % 30 === 0 && tileDamageRef.current.size > 0) {
          const pruneNow = performance.now()
          let expired = false
          for (const [k, v] of tileDamageRef.current.entries()) {
            if (pruneNow - v.updatedAt > 4800) {
              tileDamageRef.current.delete(k)
              expired = true
            }
          }
          if (expired) redrawCracks()
        }

        // 0. Build / refresh weather-themed sky backdrop + sun/moon/stars + drifting clouds
        const uiTex = worldUiTexRef.current
        const weatherId = curBot.current_weather ?? curBot.base_weather ?? 0
        const theme = getWeatherTheme(weatherId)
        const desiredSkyKey = `${curBot.world_width}x${curBot.world_height}:${weatherId}:${uiTex?.sun ? 1 : 0}:${uiTex?.cloud ? 1 : 0}`
        if (skyKeyRef.current !== desiredSkyKey) {
          skyKeyRef.current = desiredSkyKey
          app.renderer.background.color = theme.top
          layers.sky.removeChildren()
          cloudsRef.current = []

          const ww = Math.max(1, curBot.world_width) * TILE_PX
          const hh = Math.max(1, curBot.world_height) * TILE_PX
          const skyGfx = new Graphics()
          skyGfx.rect(0, 0, ww, hh).fill(theme.top)
          skyGfx.rect(0, TILE_PX * 10, ww, TILE_PX * 16).fill({ color: theme.mid, alpha: 0.45 })
          skyGfx.rect(0, TILE_PX * 18, ww, TILE_PX * 10).fill({ color: theme.low, alpha: 0.5 })
          if (theme.stars) {
            for (let s = 0; s < 55; s++) {
              const sx = ((s * 197 + 43) % Math.max(1, Math.floor(ww)))
              const sy = ((s * 83 + 17) % Math.max(1, Math.floor(TILE_PX * 22)))
              const radius = s % 5 === 0 ? 1.1 : 0.65
              skyGfx.circle(sx, sy, radius).fill({ color: s % 7 === 0 ? 0xfef08a : 0xffffff, alpha: 0.85 })
            }
          }
          if (theme.showMoon) {
            const mx = Math.min(ww - TILE_PX * 6, ww * 0.78)
            const my = TILE_PX * 6.5
            skyGfx.circle(mx, my, TILE_PX * 2.1).fill({ color: 0xfef9c3, alpha: 0.95 })
            skyGfx.circle(mx + TILE_PX * 0.75, my - TILE_PX * 0.45, TILE_PX * 1.75).fill({ color: theme.top, alpha: 0.92 })
          }
          layers.sky.addChild(skyGfx)

          if (theme.showSun && uiTex?.sun) {
            const sun = new Sprite(uiTex.sun)
            sun.anchor.set(0.5)
            sun.position.set(Math.min(ww - TILE_PX * 6, ww * 0.78), TILE_PX * 6.5)
            const sunSize = TILE_PX * 4.5
            sun.width = sunSize
            sun.height = sunSize
            layers.sky.addChild(sun)
          }

          if (uiTex?.cloud) {
            for (let i = 0; i < 8; i++) {
              const cloud = new Sprite(uiTex.cloud)
              cloud.anchor.set(0.5)
              const cScale = 0.085 + (i % 3) * 0.025
              cloud.scale.set(cScale)
              cloud.tint = theme.cloudTint
              cloud.alpha = Math.min(1, theme.cloudAlpha * (0.82 + (i % 2) * 0.15))
              cloud.position.set(
                ((i * 17 + 7) % Math.max(20, curBot.world_width)) * TILE_PX,
                (3.5 + (i % 4) * 3.2) * TILE_PX,
              )
              layers.sky.addChild(cloud)
              cloudsRef.current.push({
                sprite: cloud,
                speed: 0.012 + (i % 3) * 0.006,
              })
            }
          }
        }

        const ww = Math.max(1, curBot.world_width) * TILE_PX
        for (const c of cloudsRef.current) {
          c.sprite.x += c.speed
          if (c.sprite.x - c.sprite.width > ww) {
            c.sprite.x = -c.sprite.width
          }
        }

        // 1. Smooth Camera Follow around hitbox center (pos + 10/32, pos + 15/32)
        const targetCamX =
          app.screen.width / 2 - (botPosRef.current.x + 10 / 32) * TILE_PX * zoom.current
        const targetCamY =
          app.screen.height / 2 - (botPosRef.current.y + 15 / 32) * TILE_PX * zoom.current
        const bw = curBot.world_width * TILE_PX * zoom.current
        const bh = curBot.world_height * TILE_PX * zoom.current
        const clamped = clampOffset(targetCamX, targetCamY, bw, bh, app.screen.width, app.screen.height)

        const camAlpha = 1 - Math.exp(-16 * dtSec)
        offset.current.x += (clamped.x - offset.current.x) * camAlpha
        offset.current.y += (clamped.y - offset.current.y) * camAlpha

        layers.world.scale.set(zoom.current)
        layers.world.x = Math.round(offset.current.x)
        layers.world.y = Math.round(offset.current.y)

        // Inverse scale labels & speech bubbles for crisp text
        const invScale = 1 / Math.max(0.2, zoom.current)
        layers.labels.scale.set(invScale)
        layers.bubbles.scale.set(invScale)

        // 2. Proportional Growtopia Bot Character Rig (feet anchored at pos + (10/32, 30/32))
        const hasCharTex = !!charTexRef.current
        if (!botRigStateRef.current || botRigStateRef.current.hasTextures !== hasCharTex) {
          layers.botGfx.removeChildren()
          const rig = createGtCharacterRig(charTexRef.current)
          layers.botGfx.addChild(rig.root)
          botRigStateRef.current = { rig, hasTextures: hasCharTex }
        }

        const nowMs = performance.now()
        const prevPos = prevRenderPosRef.current as typeof prevRenderPosRef.current & {
          renderX?: number
          renderY?: number
          walkPhase?: number
        }
        const rawX = botPosRef.current.x
        const rawY = botPosRef.current.y
        const onGroundFlag = botPosRef.current.onGround
        if (
          prevPos.renderX === undefined ||
          prevPos.renderY === undefined ||
          Math.hypot(rawX - prevPos.renderX, rawY - prevPos.renderY) > 1.8
        ) {
          prevPos.renderX = rawX
          prevPos.renderY = rawY
        } else {
          // Frame-rate-independent interpolation smooths minor WS/RAF timing jitter cleanly
          const posAlpha = 1 - Math.exp(-42 * dtSec)
          prevPos.renderX += (rawX - prevPos.renderX) * posAlpha
          // Snap final subpixel settle cleanly when resting on solid ground to prevent post-land hover
          if (onGroundFlag === true && Math.abs(rawY - prevPos.renderY) < 0.14) {
            prevPos.renderY = rawY
          } else {
            prevPos.renderY += (rawY - prevPos.renderY) * posAlpha
          }
        }

        const dpx = rawX - prevPos.x
        const dpy = rawY - prevPos.y
        if (Math.abs(dpx) > 0.002) {
          prevPos.lastMovedAt = nowMs
          prevPos.walkPhase = (prevPos.walkPhase ?? 0) + Math.max(0.24, Math.abs(dpx) * 1.9)
        }
        if (onGroundFlag === true) {
          prevPos.lastVertAt = 0
        } else if (Math.abs(dpy) > 0.006 || onGroundFlag === false) {
          prevPos.lastVertAt = nowMs
        }
        prevPos.x = rawX
        prevPos.y = rawY

        const px = ((prevPos.renderX ?? rawX) + 10 / 32) * TILE_PX
        const py = ((prevPos.renderY ?? rawY) + 30 / 32) * TILE_PX
        const vertErr = Math.abs(rawY - (prevPos.renderY ?? rawY))
        const airborneNow =
          onGroundFlag === false ||
          (onGroundFlag === true && vertErr > 0.08) ||
          (onGroundFlag === undefined && nowMs - prevPos.lastVertAt < 110)
        const walkingNow = nowMs - prevPos.lastMovedAt < 130 && !airborneNow
        const mods = curBot.physics_mods
        botRigStateRef.current.rig.root.position.set(px, py)
        botRigStateRef.current.rig.setClothes(curBot.local_clothes, itemsMapRef.current)
        botRigStateRef.current.rig.setPose({
          facingLeft: facingLeftRef.current,
          airborne: airborneNow,
          walking: walkingNow,
          punching: isMouseDownRef.current || nowMs - lastActionAtRef.current < 180,
          slowFalling: Boolean(mods?.slow_fall && airborneNow && dpy > 0.01),
          hasWings: (mods?.max_air_jumps ?? 0) > 0,
          hasJetpack: (mods?.air_thrust_accel ?? 0) > 0,
          hasChickenFeet: mods?.malady === 'chicken_feet',
          walkPhase: prevPos.walkPhase ?? animTick * 0.26,
          time: animTick,
        })

        const playerAnchors = new Map<number, { x: number; y: number }>()
        playerAnchors.set(curBot.net_id || 0, { x: px, y: py })

        // 3. Render Other Players & Keep All Nametags
        const activeIds = new Set<number>()
        for (const p of curBot.players.values()) {
          activeIds.add(p.net_id)
          let entry = playerRigsRef.current.get(p.net_id)
          if (!entry || entry.hasTextures !== hasCharTex) {
            if (entry) {
              layers.players.removeChild(entry.rig.root)
              layers.labels.removeChild(entry.label)
              entry.label.destroy()
            }
            const rig = createGtCharacterRig(charTexRef.current, {
              skinTint: 0xe6be94,
              shortsColor: 0x0284c7,
              fallbackShirt: 0x0284c7,
            })
            const label = new Text({
              text: stripGTColors(p.name) || `Player #${p.net_id}`,
              style: {
                fontSize: 10,
                fontFamily: 'Inter, system-ui, sans-serif',
                fontWeight: '600',
                fill: 0xffffff,
                stroke: { color: 0x000000, width: 3 },
              },
              resolution: 2,
            })
            label.anchor.set(0.5, 1)
            layers.players.addChild(rig.root)
            layers.labels.addChild(label)
            entry = {
              rig,
              label,
              hasTextures: hasCharTex,
              lastX: p.pos_x,
              lastY: p.pos_y,
              facingLeft: false,
              lastMovedAt: 0,
            }
            playerRigsRef.current.set(p.net_id, entry)
          }

          if (p.pos_x < entry.lastX - 0.005) entry.facingLeft = true
          else if (p.pos_x > entry.lastX + 0.005) entry.facingLeft = false
          if (Math.hypot(p.pos_x - entry.lastX, p.pos_y - entry.lastY) > 0.004) {
            entry.lastMovedAt = nowMs
          }
          entry.lastX = p.pos_x
          entry.lastY = p.pos_y

          const pPx = (p.pos_x + 10 / 32) * TILE_PX
          const pPy = (p.pos_y + 30 / 32) * TILE_PX
          playerAnchors.set(p.net_id, { x: pPx, y: pPy })
          entry.rig.root.position.set(pPx, pPy)
          entry.rig.setClothes(p.clothes, itemsMapRef.current)
          entry.rig.setPose({
            facingLeft: entry.facingLeft,
            airborne: false,
            walking: nowMs - entry.lastMovedAt < 160,
            punching: false,
            time: animTick,
          })
          const cleanName = stripGTColors(p.name) || `Player #${p.net_id}`
          if (entry.label.text !== cleanName) entry.label.text = cleanName
          entry.label.position.set(pPx * zoom.current, (pPy - TILE_PX * 1.25) * zoom.current - 3)
        }

        for (const [id, entry] of playerRigsRef.current.entries()) {
          if (!activeIds.has(id)) {
            layers.players.removeChild(entry.rig.root)
            layers.labels.removeChild(entry.label)
            entry.label.destroy()
            playerRigsRef.current.delete(id)
          }
        }

        if (!botLabelRef.current) {
          botLabelRef.current = new Text({
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
          botLabelRef.current.anchor.set(0.5, 1)
          layers.labels.addChild(botLabelRef.current)
        }
        const selfName = curBot.username || 'You'
        if (botLabelRef.current.text !== selfName) botLabelRef.current.text = selfName
        botLabelRef.current.position.set(px * zoom.current, (py - TILE_PX * 1.25) * zoom.current - 3)

        // 4. Overhead Speech Bubbles (OnTalkBubble)
        const wallNow = Date.now()
        const activeBubbles = botBubblesRef.current.filter((b) => b.expiresAt > wallNow)
        const bubbleSig = activeBubbles.map((b) => b.id).join(',')
        if (renderedBubblesSigRef.current !== bubbleSig) {
          renderedBubblesSigRef.current = bubbleSig
          for (const child of layers.bubbles.removeChildren()) {
            child.destroy({ children: true })
          }
          bubbleNodeRefs.current = []

          const byPlayer = new Map<number, TalkBubbleEntry[]>()
          for (const b of activeBubbles) {
            const list = byPlayer.get(b.net_id) ?? []
            list.push(b)
            byPlayer.set(b.net_id, list)
          }

          for (const [netId, list] of byPlayer.entries()) {
            // Stack newest at bottom (stackIdx 0 closest to head) upward, max 3 visible
            const visible = list.slice(-3)
            let stackYOffset = 0
            for (let idx = visible.length - 1; idx >= 0; idx--) {
              const b = visible[idx]
              const cleanText = stripGTColors(b.text).trim()
              if (!cleanText) continue

              const isSystemStyle = b.bubble_type === 1 || b.bubble_type === 2
              const node = new Container()
              const label = new Text({
                text: cleanText,
                style: {
                  fontSize: 11,
                  fontFamily: 'Inter, system-ui, sans-serif',
                  fontWeight: '600',
                  fill: isSystemStyle ? 0xfef08a : 0x0f172a,
                  wordWrap: true,
                  wordWrapWidth: 210,
                  align: 'center',
                },
                resolution: 2,
              })
              label.anchor.set(0.5, 0.5)

              const padX = 8
              const padY = 4
              const bw = Math.max(28, Math.ceil(label.width + padX * 2))
              const bh = Math.max(20, Math.ceil(label.height + padY * 2))

              const bg = new Graphics()
              bg.roundRect(-bw / 2, -bh, bw, bh, 6)
                .fill({ color: isSystemStyle ? 0x1e293b : 0xffffff, alpha: 0.94 })
                .stroke({ color: isSystemStyle ? 0xf59e0b : 0x334155, width: 1.5, alpha: 0.9 })

              if (idx === visible.length - 1) {
                bg.moveTo(-4, 0)
                  .lineTo(0, 5)
                  .lineTo(4, 0)
                  .closePath()
                  .fill({ color: isSystemStyle ? 0x1e293b : 0xffffff, alpha: 0.94 })
              }

              label.position.set(0, -bh / 2)
              node.addChild(bg)
              node.addChild(label)
              layers.bubbles.addChild(node)

              bubbleNodeRefs.current.push({
                netId,
                expiresAt: b.expiresAt,
                container: node,
                yOffset: stackYOffset,
              })
              stackYOffset += bh + 5
            }
          }
        }

        for (const bNode of bubbleNodeRefs.current) {
          const anchor =
            playerAnchors.get(bNode.netId) ??
            (bNode.netId === curBot.net_id ? { x: px, y: py } : undefined)
          if (!anchor) {
            bNode.container.visible = false
            continue
          }
          bNode.container.visible = true
          const remaining = bNode.expiresAt - wallNow
          bNode.container.alpha = remaining < 450 ? Math.max(0, remaining / 450) : 1
          bNode.container.position.set(
            anchor.x * zoom.current,
            (anchor.y - TILE_PX * 1.45) * zoom.current - 20 - bNode.yOffset,
          )
        }
      })

      centerCamera()
    })

    return () => {
      mounted = false
      setPixiReady(false)
      setWorldUiReady(false)
      botRigStateRef.current = null
      botLabelRef.current = null
      playerRigsRef.current.clear()
      cloudsRef.current = []
      skyKeyRef.current = ''
      worldLayerKeyRef.current = ''
      renderedBubblesSigRef.current = ''
      bubbleNodeRefs.current = []
      if (appRef.current) {
        appRef.current.destroy(true, { children: true })
        appRef.current = null
      }
      layersRef.current = null
      pixiTextureCacheRef.current.clear()
    }
  }, [centerCamera])

  // Ensure all item definitions used by world tiles, overlays, clothes & drops are hydrated into itemsMapAtom
  useEffect(() => {
    const missing = new Set<number>()
    const addIfMissing = (id: unknown) => {
      if (typeof id === 'number' && id > 0 && !itemsMap.has(id) && !fetchedItemIdsRef.current.has(id)) {
        missing.add(id)
      }
    }
    for (const t of bot.tiles) {
      addIfMissing(t.fg)
      addIfMissing(t.bg)
      const tt = t.tile_type as Record<string, unknown> | undefined
      if (tt) {
        addIfMissing(tt.item_id)
        addIfMissing(tt.top_left_item_id)
        addIfMissing(tt.top_right_item_id)
        addIfMissing(tt.bottom_left_item_id)
        addIfMissing(tt.bottom_right_item_id)
      }
    }
    for (const o of bot.objects) {
      addIfMissing(o.item_id)
    }
    for (const cid of bot.local_clothes) {
      addIfMissing(cid)
    }
    for (const p of bot.players.values()) {
      for (const cid of p.clothes ?? []) {
        addIfMissing(cid)
      }
    }
    if (missing.size === 0) return

    const ids = Array.from(missing)
    ids.forEach((id) => fetchedItemIdsRef.current.add(id))
    api
      .getItemsByIds(ids)
      .then((records) => {
        if (!records || records.length === 0) return
        setItemsMap((prev) => {
          const next = new Map(prev)
          for (const rec of records) next.set(rec.id, rec)
          return next
        })
      })
      .catch(() => {
        ids.forEach((id) => fetchedItemIdsRef.current.delete(id))
      })
  }, [bot.tiles, bot.objects, bot.local_clothes, bot.players, itemsMap, setItemsMap])

  // Update world tiles with TileManager textures
  useEffect(() => {
    const layers = layersRef.current
    if (!layers || bot.tiles.length === 0 || items.length === 0) return

    const tileManagerData: TileLayerTile[] = bot.tiles.map((t, idx) => ({
      fgItemId: t.fg,
      bgItemId: t.bg,
      flags: t.flags,
      x: idx % bot.world_width,
      y: Math.floor(idx / bot.world_width),
      tileType: t.tile_type,
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
    const worldKey = `${bot.id}:${bot.world_name}:${bot.world_width}x${bot.world_height}`

    let layer = spriteTileLayerRef.current
    const needsNewLayer =
      !layer ||
      worldLayerKeyRef.current !== worldKey ||
      layer.width !== bot.world_width ||
      layer.height !== bot.world_height ||
      !previousTilesRef.current ||
      previousTilesRef.current.length !== bot.tiles.length

    const collectAffectedIndices = (out: Set<number>) => {
      const prev = previousTilesRef.current
      for (let i = 0; i < bot.tiles.length; i++) {
        const curTile = bot.tiles[i]
        const oldTile = prev[i]
        const newlyResolved =
          (curTile.fg > 0 && itemsMap.has(curTile.fg) && !renderedKnownItemsRef.current.has(curTile.fg)) ||
          (curTile.bg > 0 && itemsMap.has(curTile.bg) && !renderedKnownItemsRef.current.has(curTile.bg))
        if (
          newlyResolved ||
          !oldTile ||
          oldTile.fg !== curTile.fg ||
          oldTile.bg !== curTile.bg ||
          oldTile.flags !== curTile.flags ||
          oldTile.tile_type !== curTile.tile_type
        ) {
          const cx = i % bot.world_width
          const cy = Math.floor(i / bot.world_width)
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx
              const ny = cy + dy
              if (nx >= 0 && ny >= 0 && nx < bot.world_width && ny < bot.world_height) {
                out.add(ny * bot.world_width + nx)
              }
            }
          }
        }
      }
      previousTilesRef.current = bot.tiles
      for (const id of itemsMap.keys()) renderedKnownItemsRef.current.add(id)
    }

    const renderTileCoords = async (
      targetLayer: SpriteTileLayer,
      coords: Array<{ x: number; y: number }>,
      showProgress: boolean,
      worldVersion: number
    ) => {
      const requests: Array<{
        req: NonNullable<ReturnType<typeof getTileTextureRequest>>
        idx: number
      }> = []

      for (const { x, y } of coords) {
        const tile = tileManager.getTile(x, y)
        if (!tile) continue
        const idx = y * bot.world_width + x
        const bgReq = getTileTextureRequest(tileManager, itemMap, tile, true)
        if (bgReq) requests.push({ req: bgReq, idx })
        const fgReq = getTileTextureRequest(tileManager, itemMap, tile, false)
        if (fgReq) requests.push({ req: fgReq, idx })
      }

      if (requests.length === 0) {
        if (fullRenderVersionRef.current === worldVersion && showProgress) {
          setLoadingProgress(null)
        }
        return
      }

      if (showProgress) {
        setLoadingProgress({
          current: 0,
          total: requests.length,
          stage: 'loading',
        })
      }

      // Deduplicate atlas sprite coordinates so each distinct block/tree tile is decoded once
      const uniqueAtlasReqs = collectUniqueAtlasRequests(requests.map((r) => r.req))
      const uniqueSamples = new Map<string, NonNullable<ReturnType<typeof getTileTextureRequest>>>()
      for (const { req } of requests) {
        const rk = getTileTextureCacheKey(req)
        if (!uniqueSamples.has(rk)) uniqueSamples.set(rk, req)
      }

      await textureCacheManager.batchLoadTiles(uniqueAtlasReqs)
      if (fullRenderVersionRef.current !== worldVersion) return

      const resolvedTextures = new Map<string, Texture | null>()
      await Promise.all(
        Array.from(uniqueSamples.entries()).map(async ([rk, sample]) => {
          const tex = await getOrCreateTileTexture(sample, textureCache)
          resolvedTextures.set(rk, tex)
        })
      )
      if (fullRenderVersionRef.current !== worldVersion) return

      const CHUNK_SIZE = 800
      for (let chunkStart = 0; chunkStart < requests.length; chunkStart += CHUNK_SIZE) {
        if (fullRenderVersionRef.current !== worldVersion) return
        const chunk = requests.slice(chunkStart, chunkStart + CHUNK_SIZE)
        if (showProgress) {
          setLoadingProgress({
            current: chunkStart,
            total: requests.length,
            stage: 'loading',
          })
        }

        for (const item of chunk) {
          const texture = resolvedTextures.get(getTileTextureCacheKey(item.req))
          if (!texture || texture.destroyed) continue

          const prevSprite = item.req.isBg
            ? targetLayer.bgSprites[item.idx]
            : targetLayer.fgSprites[item.idx]
          if (prevSprite) {
            const container = item.req.isBg ? targetLayer.bgContainer : targetLayer.fgContainer
            container.removeChild(prevSprite)
            prevSprite.destroy()
          }

          const sprite = new Sprite(texture)
          const baseScaleX = TILE_PX / Math.max(1, texture.width)
          const baseScaleY = TILE_PX / Math.max(1, texture.height)
          sprite.anchor.set(0.5)
          sprite.position.set(item.req.x * TILE_PX + TILE_PX / 2, item.req.y * TILE_PX + TILE_PX / 2)
          sprite.scale.set(item.req.flippedX ? -baseScaleX : baseScaleX, baseScaleY)
          const tint = computeTileTint(item.req.flags ?? 0)
          if (tint !== 0xffffff) {
            sprite.tint = tint
          }

          if (item.req.isBg) {
            targetLayer.bgContainer.addChild(sprite)
            targetLayer.bgSprites[item.idx] = sprite
          } else {
            targetLayer.fgContainer.addChild(sprite)
            targetLayer.fgSprites[item.idx] = sprite
          }
        }

        if (chunkStart + CHUNK_SIZE < requests.length) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()))
        }
      }

      if (fullRenderVersionRef.current === worldVersion && showProgress) {
        setLoadingProgress(null)
      }
    }

    const flushIncrementalCoords = (
      targetLayer: SpriteTileLayer,
      affected: Set<number>,
      worldVersion: number
    ) => {
      if (affected.size === 0) return
      const coords: Array<{ x: number; y: number }> = []
      for (const idx of affected) {
        if (targetLayer.bgSprites[idx]) {
          targetLayer.bgContainer.removeChild(targetLayer.bgSprites[idx]!)
          targetLayer.bgSprites[idx]!.destroy()
          targetLayer.bgSprites[idx] = null
        }
        if (targetLayer.fgSprites[idx]) {
          targetLayer.fgContainer.removeChild(targetLayer.fgSprites[idx]!)
          targetLayer.fgSprites[idx]!.destroy()
          targetLayer.fgSprites[idx] = null
        }
        coords.push({
          x: idx % bot.world_width,
          y: Math.floor(idx / bot.world_width),
        })
      }
      renderTileCoords(targetLayer, coords, false, worldVersion).catch(() => {})
    }

    if (!needsNewLayer && layer) {
      if (!fullRenderDoneRef.current) {
        // Preserve in-flight initial world render; queue diffs to apply right after it finishes
        collectAffectedIndices(queuedIncrementalRef.current)
        return
      }
      const affected = new Set<number>()
      collectAffectedIndices(affected)
      flushIncrementalCoords(layer, affected, fullRenderVersionRef.current)
      return
    }

    // Full render
    worldLayerKeyRef.current = worldKey
    const version = ++fullRenderVersionRef.current
    fullRenderDoneRef.current = false
    queuedIncrementalRef.current.clear()

    for (const child of layers.tiles.removeChildren()) {
      child.destroy({ children: true })
    }
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
    previousTilesRef.current = bot.tiles
    for (const id of itemsMap.keys()) renderedKnownItemsRef.current.add(id)

    const allCoords: Array<{ x: number; y: number }> = []
    for (let y = 0; y < bot.world_height; y++) {
      for (let x = 0; x < bot.world_width; x++) {
        allCoords.push({ x, y })
      }
    }

    renderTileCoords(layer, allCoords, true, version)
      .then(() => {
        if (fullRenderVersionRef.current !== version) return
        fullRenderDoneRef.current = true
        if (queuedIncrementalRef.current.size > 0) {
          const pending = new Set(queuedIncrementalRef.current)
          queuedIncrementalRef.current.clear()
          flushIncrementalCoords(layer!, pending, version)
        }
      })
      .catch(() => {
        if (fullRenderVersionRef.current === version) {
          setLoadingProgress(null)
        }
      })
  }, [bot.tiles, bot.world_width, bot.world_height, items, pixiReady])

  /** Resolve and cache a crisp mini Pixi texture for an item or seed (shared by drops and tile overlays). */
  const resolveItemIconTexture = useCallback(async (itemId: number): Promise<Texture | null> => {
    const cacheKey = `drop_${itemId}`
    const cached = pixiTextureCacheRef.current.get(cacheKey)
    if (cached && !cached.destroyed) return cached

    const item = itemsMapRef.current.get(itemId)
    if (!item) return null

    let tex: Texture | null = null
    if (item.id % 2 === 1 || item.action_type === 19) {
      tex = await getGtSeedTexture(
        item.seed_base_sprite,
        item.seed_overlay_sprite,
        item.base_color,
        item.overlay_color,
      )
    } else {
      const coords = getIsolatedSpriteCoords(item)
      const url = await textureCacheManager.getCroppedTile(
        item.texture_file_name,
        coords.x,
        coords.y,
      )
      tex = await loadCrispTextureFromUrl(url)
    }

    if (tex) {
      pixiTextureCacheRef.current.set(cacheKey, tex)
    }
    return tex
  }, [])

  // Render Vending Machine items/prices, Display Blocks, Shelves, Public doors & Fire badges
  useEffect(() => {
    const layers = layersRef.current
    if (!layers) return
    let cancelled = false

    for (const child of layers.tileOverlays.removeChildren()) {
      child.destroy({ children: true })
    }
    if (bot.tiles.length === 0 || bot.world_width === 0) return

    const iconItemIds = new Set<number>()
    const overlayTiles: Array<{ x: number; y: number; fg: number; flags: number; tt: Record<string, unknown> }> = []

    for (let i = 0; i < bot.tiles.length; i++) {
      const t = bot.tiles[i]
      const tt = t.tile_type as Record<string, unknown> | undefined
      const tType = tt?.type
      const isSpecialOverlay =
        tType === 'VendingMachine' ||
        tType === 'DisplayBlock' ||
        tType === 'Shelf' ||
        (tType === 'Door' && (t.flags & TILE_FLAGS.PUBLIC) !== 0) ||
        (t.flags & TILE_FLAGS.ON_FIRE) !== 0

      if (!isSpecialOverlay) continue
      const x = i % bot.world_width
      const y = Math.floor(i / bot.world_width)
      overlayTiles.push({ x, y, fg: t.fg, flags: t.flags, tt: tt ?? {} })

      for (const k of ['item_id', 'top_left_item_id', 'top_right_item_id', 'bottom_left_item_id', 'bottom_right_item_id']) {
        const val = tt?.[k]
        if (typeof val === 'number' && val > 0) iconItemIds.add(val)
      }
    }

    if (overlayTiles.length === 0) return

    ;(async () => {
      const loaded = new Map<number, Texture | null>()
      await Promise.all(
        Array.from(iconItemIds).map(async (id) => {
          const tex = await resolveItemIconTexture(id).catch(() => null)
          loaded.set(id, tex)
        }),
      )
      if (cancelled) return

      for (const child of layers.tileOverlays.removeChildren()) {
        child.destroy({ children: true })
      }

      for (const ot of overlayTiles) {
        const tileX = ot.x * TILE_PX
        const tileY = ot.y * TILE_PX
        const tType = ot.tt.type

        if (tType === 'VendingMachine') {
          const itemId = typeof ot.tt.item_id === 'number' ? ot.tt.item_id : 0
          const price = typeof ot.tt.price === 'number' ? ot.tt.price : 0
          const itemTex = itemId > 0 ? loaded.get(itemId) : null
          if (itemTex && !itemTex.destroyed) {
            const icon = new Sprite(itemTex)
            icon.width = TILE_PX * 0.48
            icon.height = TILE_PX * 0.48
            icon.position.set(tileX + TILE_PX * 0.26, tileY + TILE_PX * 0.16)
            layers.tileOverlays.addChild(icon)

            const priceStr = price === 0 ? 'FREE' : price < 0 ? `${Math.abs(price)}/1` : `${price} WL`
            const badge = new Text({
              text: priceStr,
              style: {
                fontFamily: 'Inter, system-ui, sans-serif',
                fontSize: 9,
                fontWeight: 'bold',
                fill: price === 0 ? 0x4ade80 : 0xfef08a,
                stroke: { color: 0x000000, width: 3 },
              },
            })
            badge.anchor.set(0.5, 1)
            badge.scale.set(0.28)
            badge.position.set(tileX + TILE_PX / 2, tileY + TILE_PX - 0.5)
            layers.tileOverlays.addChild(badge)
          } else {
            const dot = new Graphics()
            dot.circle(tileX + TILE_PX / 2, tileY + TILE_PX * 0.42, 1.3).fill({ color: 0xf87171, alpha: 0.7 })
            layers.tileOverlays.addChild(dot)
          }
        } else if (tType === 'DisplayBlock') {
          const itemId = typeof ot.tt.item_id === 'number' ? ot.tt.item_id : 0
          const itemTex = itemId > 0 ? loaded.get(itemId) : null
          if (itemTex && !itemTex.destroyed) {
            const icon = new Sprite(itemTex)
            icon.width = TILE_PX * 0.56
            icon.height = TILE_PX * 0.56
            icon.position.set(tileX + TILE_PX * 0.22, tileY + TILE_PX * 0.22)
            layers.tileOverlays.addChild(icon)
          }
        } else if (tType === 'Shelf') {
          const slots: Array<[unknown, number, number]> = [
            [ot.tt.top_left_item_id, 0.14, 0.14],
            [ot.tt.top_right_item_id, 0.54, 0.14],
            [ot.tt.bottom_left_item_id, 0.14, 0.54],
            [ot.tt.bottom_right_item_id, 0.54, 0.54],
          ]
          for (const [rawId, ox, oy] of slots) {
            const tex = typeof rawId === 'number' && rawId > 0 ? loaded.get(rawId) : null
            if (tex && !tex.destroyed) {
              const icon = new Sprite(tex)
              icon.width = TILE_PX * 0.34
              icon.height = TILE_PX * 0.34
              icon.position.set(tileX + TILE_PX * ox, tileY + TILE_PX * oy)
              layers.tileOverlays.addChild(icon)
            }
          }
        }

        if (tType === 'Door' && (ot.flags & TILE_FLAGS.PUBLIC) !== 0 && ot.fg > 0) {
          const badge = new Graphics()
          badge.circle(tileX + TILE_PX - 2, tileY + 2, 1.3).fill({ color: 0x22d3ee, alpha: 0.95 })
          layers.tileOverlays.addChild(badge)
        }
        if ((ot.flags & TILE_FLAGS.ON_FIRE) !== 0) {
          const ember = new Graphics()
          ember.rect(tileX, tileY, TILE_PX, TILE_PX).stroke({ color: 0xf97316, width: 0.9, alpha: 0.8 })
          layers.tileOverlays.addChild(ember)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [bot.tiles, bot.world_width, itemsMap, pixiReady, resolveItemIconTexture])

  // Update floating objects (obj.x / obj.y arrive from backend in GT pixel units = tile * 32)
  useEffect(() => {
    const layers = layersRef.current
    if (!layers) return
    let cancelled = false

    for (const child of layers.objects.removeChildren()) {
      child.destroy({ children: true })
    }

    if (bot.objects.length === 0) return

    ;(async () => {
      const uniqueIds = Array.from(new Set(bot.objects.map((o) => o.item_id)))
      const loaded = new Map<number, Texture | null>()
      await Promise.all(
        uniqueIds.map(async (id) => {
          const tex = await resolveItemIconTexture(id).catch(() => null)
          loaded.set(id, tex)
        })
      )
      if (cancelled) return

      for (const child of layers.objects.removeChildren()) {
        child.destroy({ children: true })
      }

      const dropBoxSize = TILE_PX * 0.88
      const iconSize = TILE_PX * 0.62
      const pickupTex = worldUiTexRef.current?.pickupBox

      for (const obj of bot.objects) {
        const itemNode = new Container()
        itemNode.x = (obj.x / 32) * TILE_PX + (TILE_PX - dropBoxSize) / 2
        itemNode.y = (obj.y / 32) * TILE_PX + (TILE_PX - dropBoxSize) / 2

        if (pickupTex && !pickupTex.destroyed) {
          const boxSprite = new Sprite(pickupTex)
          boxSprite.width = dropBoxSize
          boxSprite.height = dropBoxSize * 0.72
          boxSprite.y = dropBoxSize * 0.28
          itemNode.addChild(boxSprite)
        } else {
          const boxBg = new Graphics()
          boxBg
            .roundRect(0, 0, dropBoxSize, dropBoxSize, 1.5)
            .fill({ color: 0x0f172a, alpha: 0.75 })
            .stroke({ color: 0xfacc15, width: 0.7, alpha: 0.85 })
          itemNode.addChild(boxBg)
        }

        const itemTex = loaded.get(obj.item_id)
        if (itemTex && !itemTex.destroyed) {
          const icon = new Sprite(itemTex)
          icon.width = iconSize
          icon.height = iconSize
          icon.x = (dropBoxSize - iconSize) / 2
          icon.y = (dropBoxSize - iconSize) / 2 - 0.5
          itemNode.addChild(icon)
        } else {
          const dot = new Graphics()
          dot.circle(dropBoxSize / 2, dropBoxSize / 2, 2.2).fill(0xf5c518)
          itemNode.addChild(dot)
        }

        if (obj.count > 1) {
          const countText = new Text({
            text: String(obj.count),
            style: {
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: 12,
              fontWeight: 'bold',
              fill: 0xffffff,
              stroke: { color: 0x000000, width: 3 },
            },
          })
          countText.anchor.set(1, 1)
          countText.scale.set(0.32)
          countText.x = dropBoxSize + 0.5
          countText.y = dropBoxSize + 0.5
          itemNode.addChild(countText)
        }

        layers.objects.addChild(itemNode)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [bot.objects, itemsMap, pixiReady, worldUiReady, resolveItemIconTexture])

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

  const getBotCenterTile = () => ({
    x: Math.floor(botPosRef.current.x + 10 / 32),
    y: Math.floor(botPosRef.current.y + 15 / 32),
  })

  const isTileInReach = (tileX: number, tileY: number) => {
    const center = getBotCenterTile()
    return (
      Math.abs(tileX - center.x) <= actionReach &&
      Math.abs(tileY - center.y) <= actionReach
    )
  }

  const faceTileAndMarkAction = (tileX: number) => {
    const center = getBotCenterTile()
    if (tileX < center.x) facingLeftRef.current = true
    else if (tileX > center.x) facingLeftRef.current = false
    lastActionAtRef.current = performance.now()
  }

  const hitsCharacterBox = (tileX: number, tileY: number, px: number, py: number) =>
    tileX >= Math.floor(px) &&
    tileX <= Math.floor(px + 19 / 32) &&
    tileY >= Math.floor(py) &&
    tileY <= Math.floor(py + 29 / 32)

  const checkHitsSelf = (tileX: number, tileY: number) =>
    hitsCharacterBox(tileX, tileY, botPosRef.current.x, botPosRef.current.y)

  const checkHitRemotePlayer = (tileX: number, tileY: number): number | null => {
    for (const p of bot.players.values()) {
      if (hitsCharacterBox(tileX, tileY, p.pos_x, p.pos_y)) {
        return p.net_id
      }
    }
    return null
  }

  const getTileAt = (tileX: number, tileY: number) => {
    if (tileX < 0 || tileY < 0 || tileX >= bot.world_width || tileY >= bot.world_height) return null
    return bot.tiles[tileY * bot.world_width + tileX] ?? null
  }

  const hasInteractiveTileAt = (tileX: number, tileY: number) => {
    const tile = getTileAt(tileX, tileY)
    if (!tile) return false
    if (tile.tile_type?.type && INTERACTIVE_TILE_TYPES.has(tile.tile_type.type)) return true
    const fgItem = tile.fg > 0 ? itemsMap.get(tile.fg) : undefined
    if (fgItem && INTERACTIVE_ACTION_TYPES.has(fgItem.action_type)) return true
    const bgItem = tile.bg > 0 ? itemsMap.get(tile.bg) : undefined
    if (bgItem && INTERACTIVE_ACTION_TYPES.has(bgItem.action_type)) return true
    return false
  }

  const isDoorTileAt = (tileX: number, tileY: number) => {
    const tile = getTileAt(tileX, tileY)
    if (!tile) return false
    if (tile.tile_type?.type === 'Door') return true
    const fgItem = tile.fg > 0 ? itemsMap.get(tile.fg) : undefined
    return fgItem ? fgItem.action_type === 2 || fgItem.action_type === 3 || fgItem.action_type === 27 : false
  }

  const sendWrenchTile = (tileX: number, tileY: number) => {
    faceTileAndMarkAction(tileX)
    api.sendCmd(bot.id, { type: 'wrench', x: tileX, y: tileY }).catch(() => {})
  }

  // Prioritize interactive/foreground tiles under the player's feet (e.g. Vending Machine, Door)
  // over self-wrench unless Shift+Click is held or clicking empty foreground space.
  const tryHandleWrenchClick = (e: React.MouseEvent<HTMLDivElement>, tileX: number, tileY: number): boolean => {
    const now = performance.now()
    if (now - lastWrenchAtRef.current < 300) {
      return true
    }

    if (e.shiftKey && checkHitsSelf(tileX, tileY)) {
      lastWrenchAtRef.current = now
      api.sendCmd(bot.id, { type: 'wrench_self' }).catch(() => {})
      onPlayerWrench?.(bot.net_id || 1)
      return true
    }

    if (!e.altKey) {
      const hitRemoteNetId = checkHitRemotePlayer(tileX, tileY)
      if (hitRemoteNetId) {
        lastWrenchAtRef.current = now
        api.sendCmd(bot.id, { type: 'wrench_player', net_id: hitRemoteNetId }).catch(() => {})
        onPlayerWrench?.(hitRemoteNetId)
        return true
      }
    }

    const tile = getTileAt(tileX, tileY)
    const inReach = isTileInReach(tileX, tileY)
    if (tile && inReach && (hasInteractiveTileAt(tileX, tileY) || tile.fg > 0)) {
      lastWrenchAtRef.current = now
      sendWrenchTile(tileX, tileY)
      return true
    }

    if (checkHitsSelf(tileX, tileY)) {
      lastWrenchAtRef.current = now
      api.sendCmd(bot.id, { type: 'wrench_self' }).catch(() => {})
      onPlayerWrench?.(bot.net_id || 1)
      return true
    }

    if (tile && inReach) {
      lastWrenchAtRef.current = now
      sendWrenchTile(tileX, tileY)
      return true
    }

    return false
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const { tileX, tileY } = getTileUnderCursor(e)

    if (e.button === 2) {
      // Right-click = context wrench (player or tile within reach)
      e.preventDefault()
      tryHandleWrenchClick(e, tileX, tileY)
      return
    }

    if (e.button !== 0) return
    if (tileX < 0 || tileY < 0 || tileX >= bot.world_width || tileY >= bot.world_height) return

    if (activeItemId === 32) {
      if (tryHandleWrenchClick(e, tileX, tileY)) return
    }

    isMouseDownRef.current = true
    faceTileAndMarkAction(tileX)
    lastHoldTileRef.current = { x: tileX, y: tileY }
    api.sendCmd(bot.id, {
      type: 'hold_action',
      active: true,
      x: tileX,
      y: tileY,
      item: activeItemId,
    }).catch(() => {})
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { tileX, tileY } = getTileUnderCursor(e)
    if (!isTileInReach(tileX, tileY)) return
    if (!isDoorTileAt(tileX, tileY)) return
    faceTileAndMarkAction(tileX)
    api.sendCmd(bot.id, { type: 'active', x: tileX, y: tileY }).catch(() => {})
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { tileX, tileY } = getTileUnderCursor(e)
    const inBounds = tileX >= 0 && tileY >= 0 && tileX < bot.world_width && tileY < bot.world_height

    if (!inBounds) {
      onTileHover?.(null)
      layersRef.current?.hoverGfx.clear()
      return
    }

    const inReach = isTileInReach(tileX, tileY)

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
      faceTileAndMarkAction(tileX)
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
      onDoubleClick={handleDoubleClick}
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
        <div className="absolute top-3 right-3 px-3 py-1.5 rounded-lg bg-black/80 backdrop-blur-md border border-white/15 flex items-center gap-2.5 z-10 pointer-events-none shadow-lg">
          <div className="text-[11px] text-white/90 font-medium">
            {loadingProgress.stage === 'loading' ? 'Loading tiles...' : 'Decoding sprites...'}
          </div>
          <div className="w-24 h-1.5 bg-white/15 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-150"
              style={{ width: `${Math.min(100, (loadingProgress.current / Math.max(1, loadingProgress.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
