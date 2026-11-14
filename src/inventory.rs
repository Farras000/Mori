use std::collections::HashMap;

use anyhow::Result;
use crate::cursor::Cursor;

const TEMPORARY_ITEM_IDS: &[u16] = &[
    1424, // World Key
    5640, // Magplant 5000 Remote
];

#[derive(Debug, Clone)]
pub struct InventoryItem {
    pub id:     u16,
    pub amount: u8,
    pub flag:   u8,
}

#[derive(Debug, Default, Clone)]
pub struct Inventory {
    pub size:       u32,
    pub item_count: u16,
    pub items:      HashMap<u16, InventoryItem>,
    pub gems:       i32,
}

impl Inventory {
    pub fn parse(data: &[u8]) -> Result<Self> {
        let mut cur = Cursor::new(data, "inventory");

        cur.skip(1)?;                        // unknown leading byte
        let size       = cur.u32()?;
        let item_count = cur.u16()?;

        let mut items = HashMap::with_capacity(item_count as usize);
        for _ in 0..item_count {
            let id     = cur.u16()?;
            let amount = cur.u8()?;
            let flag   = cur.u8()?;
            // Gems (112) are tracked separately in `gems` via OnSetBux, never as an inventory item.
            if id != 112 {
                items.insert(id, InventoryItem { id, amount, flag });
            }
        }
        let actual_count = items.len() as u16;

        Ok(Self { size, item_count: actual_count, items, gems: 0 })
    }

    pub fn clear(&mut self) {
        self.size       = 0;
        self.item_count = 0;
        self.items.clear();
    }

    pub fn add_item(&mut self, id: u16, amount: u8) {
        // Gems (112) are currency and must never be placed into inventory slots.
        if id == 112 || amount == 0 {
            return;
        }
        if let Some(item) = self.items.get_mut(&id) {
            item.amount = item.amount.saturating_add(amount);
        } else {
            self.items.insert(id, InventoryItem { id, amount, flag: 0 });
            self.item_count += 1;
        }
    }

    pub fn add_gems(&mut self, amount: i32) {
        self.gems = amount;
    }

    pub fn has_item(&self, id: u16, min_amount: u8) -> bool {
        self.items.get(&id).map(|i| i.amount >= min_amount).unwrap_or(false)
    }

    pub fn can_collect(&self, item_id: u16) -> bool {
        if item_id == 112 {
            return true; // gems always fit
        }
        if let Some(existing) = self.items.get(&item_id) {
            existing.amount < 200
        } else {
            (self.item_count as u32) < self.size
        }
    }

    pub fn sub_item(&mut self, id: u16, amount: u8) {
        if let Some(item) = self.items.get_mut(&id) {
            if item.amount <= amount {
                self.items.remove(&id);
                self.item_count = self.item_count.saturating_sub(1);
            } else {
                item.amount -= amount;
            }
        }
    }

    pub fn remove_item(&mut self, id: u16) {
        if self.items.remove(&id).is_some() {
            self.item_count = self.item_count.saturating_sub(1);
        }
    }

    pub fn remove_temp_items(&mut self) -> bool {
        let to_remove: Vec<u16> = self.items.keys()
            .copied()
            .filter(|id| TEMPORARY_ITEM_IDS.contains(id))
            .collect();

        let changed = !to_remove.is_empty();
        for id in to_remove {
            self.remove_item(id);
        }

        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gems_112_never_stored_in_inventory() {
        let mut inv = Inventory::default();
        inv.add_item(112, 50);
        inv.add_item(2, 10);
        assert!(!inv.items.contains_key(&112));
        assert_eq!(inv.items.get(&2).map(|i| i.amount), Some(10));
        assert_eq!(inv.item_count, 1);
    }
}
