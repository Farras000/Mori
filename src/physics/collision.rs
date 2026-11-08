use super::config::PhysicsConfig;

/// Simplified collision classification for physics interaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileCollisionKind {
    /// Non-solid air, background, or passable item.
    Air,
    /// Solid from all 4 directions.
    Solid,
    /// One-way jump-through platform (solid only when falling from above).
    Platform,
    /// Water or viscous fluid tile.
    Water,
    /// Bouncy trampoline or pinball bumper.
    Trampoline,
    /// Slippery ice surface.
    Ice,
    /// One-way directional wall (solid when moving Right, passable moving Left).
    OneWayLeft,
    /// One-way directional wall (solid when moving Left, passable moving Right).
    OneWayRight,
}

/// Axis-Aligned Bounding Box in sub-pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AABB {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl AABB {
    pub fn new(left: f32, top: f32, right: f32, bottom: f32) -> Self {
        Self { left, top, right, bottom }
    }

    /// Construct player hitbox from current top-left position and configuration.
    pub fn from_pos(x: f32, y: f32, cfg: &PhysicsConfig) -> Self {
        let left = x + cfg.hitbox_offset_x;
        let top = y + cfg.hitbox_offset_y;
        Self {
            left,
            top,
            right: left + cfg.hitbox_width,
            bottom: top + cfg.hitbox_height,
        }
    }

    pub fn intersects(&self, other: &AABB) -> bool {
        self.left < other.right
            && self.right > other.left
            && self.top < other.bottom
            && self.bottom > other.top
    }
}

/// Abstract provider for world tile collision queries.
pub trait CollisionProvider {
    fn get_tile_collision(&self, tx: i32, ty: i32) -> TileCollisionKind;
    fn is_in_bounds(&self, tx: i32, ty: i32) -> bool;
}

/// In-memory collision provider useful for testing and isolated simulations.
#[derive(Debug, Default, Clone)]
pub struct SimpleCollisionMap {
    pub width: u32,
    pub height: u32,
    pub tiles: std::collections::HashMap<(i32, i32), TileCollisionKind>,
}

impl SimpleCollisionMap {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            tiles: std::collections::HashMap::new(),
        }
    }

    pub fn set(&mut self, x: i32, y: i32, kind: TileCollisionKind) {
        self.tiles.insert((x, y), kind);
    }
}

impl CollisionProvider for SimpleCollisionMap {
    fn get_tile_collision(&self, tx: i32, ty: i32) -> TileCollisionKind {
        if !self.is_in_bounds(tx, ty) {
            return TileCollisionKind::Solid;
        }
        self.tiles.get(&(tx, ty)).copied().unwrap_or(TileCollisionKind::Air)
    }

    fn is_in_bounds(&self, tx: i32, ty: i32) -> bool {
        tx >= 0 && tx < self.width as i32 && ty >= 0 && ty < self.height as i32
    }
}
