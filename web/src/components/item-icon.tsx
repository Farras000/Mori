import { memo, useEffect, useState } from 'react'
import { useItemRecord } from '@/lib/item-cache'
import { textureCacheManager } from '@/lib/texture-cache'
import { getGtSeedDataUrl } from '@/lib/gt-sprites'
import { getIsolatedSpriteCoords } from './texture-image'
import { cn } from '@/lib/utils'

interface ItemIconProps {
  itemId: number
  size?: number
  className?: string
  alt?: string
}

export const ItemIcon = memo(function ItemIcon({
  itemId,
  size = 32,
  className,
  alt,
}: ItemIconProps) {
  const item = useItemRecord(itemId)
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!item) {
      setImgUrl(null)
      return
    }

    async function loadIcon() {
      if (!item) return
      try {
        if (item.id % 2 === 1 || item.action_type === 19) {
          const seedUrl = await getGtSeedDataUrl(
            item.seed_base_sprite,
            item.seed_overlay_sprite,
            item.base_color,
            item.overlay_color,
          )
          if (!cancelled && seedUrl) {
            setImgUrl(seedUrl)
            return
          }
        }
        const coords = getIsolatedSpriteCoords(item, 0)
        const url = await textureCacheManager.getCroppedItemIcon(
          item.texture_file_name,
          coords.x,
          coords.y
        )
        if (!cancelled && url) {
          setImgUrl(url)
        }
      } catch {
        if (!cancelled) setImgUrl(null)
      }
    }

    loadIcon()
    return () => {
      cancelled = true
    }
  }, [item])

  if (itemId === 18) {
    return (
      <div
        className={cn('flex items-center justify-center font-bold text-base select-none', className)}
        style={{ width: size, height: size }}
        title="Punch / Fist (18)"
      >
        👊
      </div>
    )
  }

  if (itemId === 32) {
    return (
      <div
        className={cn('flex items-center justify-center font-bold text-base select-none', className)}
        style={{ width: size, height: size }}
        title="Wrench (32)"
      >
        🔧
      </div>
    )
  }

  if (imgUrl) {
    return (
      <img
        src={imgUrl}
        alt={alt || item?.name || `Item ${itemId}`}
        className={cn('object-contain select-none', className)}
        style={{
          width: size,
          height: size,
          imageRendering: 'pixelated',
        }}
        loading="lazy"
        draggable={false}
      />
    )
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center font-mono font-bold text-[11px] text-muted-foreground bg-muted/40 rounded select-none',
        className
      )}
      style={{ width: size, height: size }}
    >
      {itemId}
    </div>
  )
})
