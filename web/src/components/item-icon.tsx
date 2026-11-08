import { memo, useEffect, useState } from 'react'
import { useItemRecord } from '@/lib/item-cache'
import { textureCacheManager } from '@/lib/texture-cache'
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
        const coords = getIsolatedSpriteCoords(item, 0)
        const url = await textureCacheManager.getCroppedTile(
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
