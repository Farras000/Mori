pub mod collision;
pub mod config;
pub mod engine;
pub mod state;

#[cfg(test)]
mod tests;

pub use collision::{CollisionProvider, SimpleCollisionMap, TileCollisionKind, AABB};
pub use config::PhysicsConfig;
pub use engine::{MovementInput, PhysicsEngine};
pub use state::PhysicsState;

use crate::items::ItemsDat;
use crate::world::{TileFlags, TileType, WorldTileMap, WorldTilePermission};


/// Adapter to query collisions directly from Mori's WorldTileMap and ItemsDat.
pub struct BotWorldCollision<'a> {
    pub world: &'a WorldTileMap,
    pub items_dat: &'a ItemsDat,
    pub user_id: u32,
}

impl<'a> BotWorldCollision<'a> {
    pub fn new(world: &'a WorldTileMap, items_dat: &'a ItemsDat, user_id: u32) -> Self {
        Self {
            world,
            items_dat,
            user_id,
        }
    }
}

impl<'a> CollisionProvider for BotWorldCollision<'a> {
    fn is_in_bounds(&self, tx: i32, ty: i32) -> bool {
        tx >= 0 && tx < self.world.width as i32 && ty >= 0 && ty < self.world.height as i32
    }

    fn get_tile_collision(&self, tx: i32, ty: i32) -> TileCollisionKind {
        if !self.is_in_bounds(tx, ty) {
            return TileCollisionKind::Solid;
        }

        let idx = (ty as u32 * self.world.width + tx as u32) as usize;
        let Some(tile) = self.world.tiles.get(idx) else {
            return TileCollisionKind::Solid;
        };

        if tile.fg_item_id == 0 {
            return TileCollisionKind::Air;
        }

        let Some(item_info) = self.items_dat.find_by_id(tile.fg_item_id as u32) else {
            return TileCollisionKind::Air;
        };

        // Specific item behavior checks
        if tile.fg_item_id == 822 {
            return TileCollisionKind::Water;
        }
        if tile.fg_item_id == 240 || tile.fg_item_id == 314 {
            return TileCollisionKind::Trampoline;
        }

        // Check TileType specializations
        match tile.tile_type {
            TileType::VipEntrance { owner_uid, ref access_uids, .. } => {
                if self.user_id == owner_uid || access_uids.contains(&self.user_id) {
                    TileCollisionKind::Air
                } else {
                    TileCollisionKind::Solid
                }
            }
            TileType::StormyCloud { is_solid, .. } => {
                if is_solid == 0 { TileCollisionKind::Air } else { TileCollisionKind::Solid }
            }
            TileType::FriendsEntrance { owner_user_id, ref allowed_friends_userid } => {
                if self.user_id == owner_user_id || allowed_friends_userid.contains(&self.user_id) {
                    TileCollisionKind::Air
                } else {
                    TileCollisionKind::Solid
                }
            }
            TileType::Basic | _ => {
                match item_info.collision_type {
                    0 => TileCollisionKind::Air,
                    1 => TileCollisionKind::Solid,
                    2 => TileCollisionKind::Platform,
                    3 | 10 | 11 => {
                        if self.world.get_tile_permission(tx as u32, ty as u32, self.user_id) != WorldTilePermission::NONE
                            || tile.flags.contains(TileFlags::IS_OPEN_TO_PUBLIC)
                        {
                            TileCollisionKind::Air
                        } else {
                            TileCollisionKind::Solid
                        }
                    }
                    4 => {
                        if tile.flags.contains(TileFlags::IS_ON) {
                            TileCollisionKind::Solid
                        } else {
                            TileCollisionKind::Air
                        }
                    }
                    5 => {
                        if tile.flags.contains(TileFlags::FLIPPED_X) {
                            TileCollisionKind::OneWayRight
                        } else {
                            TileCollisionKind::OneWayLeft
                        }
                    }
                    7 => TileCollisionKind::Air,
                    9 => {
                        if !tile.flags.contains(TileFlags::IS_ON) {
                            TileCollisionKind::Solid
                        } else {
                            TileCollisionKind::Air
                        }
                    }
                    _ => TileCollisionKind::Solid,
                }
            }
        }
    }
}
