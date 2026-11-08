import { useState, useEffect } from 'react'
import { api, type ItemRecord } from './api'

// Module-level cache for ItemRecords
const itemRecordCache = new Map<number, ItemRecord>()
const pendingFetches = new Map<number, Promise<ItemRecord | null>>()

export async function fetchItemRecord(itemId: number): Promise<ItemRecord | null> {
  if (itemId === 0) return null
  const cached = itemRecordCache.get(itemId)
  if (cached) return cached

  const pending = pendingFetches.get(itemId)
  if (pending) return pending

  const fetchPromise = (async () => {
    try {
      const records = await api.getItemsByIds([itemId])
      if (records && records.length > 0) {
        itemRecordCache.set(itemId, records[0])
        return records[0]
      }
      return null
    } catch {
      return null
    } finally {
      pendingFetches.delete(itemId)
    }
  })()

  pendingFetches.set(itemId, fetchPromise)
  return fetchPromise
}

export function useItemRecord(itemId: number | null | undefined): ItemRecord | null {
  const [record, setRecord] = useState<ItemRecord | null>(() => {
    if (!itemId) return null
    return itemRecordCache.get(itemId) || null
  })

  useEffect(() => {
    if (!itemId) {
      setRecord(null)
      return
    }

    const cached = itemRecordCache.get(itemId)
    if (cached) {
      setRecord(cached)
      return
    }

    let active = true
    fetchItemRecord(itemId).then((res) => {
      if (active && res) {
        setRecord(res)
      }
    })

    return () => {
      active = false
    }
  }, [itemId])

  return record
}
