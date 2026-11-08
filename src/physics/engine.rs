use super::{
    collision::{CollisionProvider, TileCollisionKind, AABB},
    config::PhysicsConfig,
    state::PhysicsState,
};

/// High-level movement intent for an individual tick.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MovementInput {
    pub move_left: bool,
    pub move_right: bool,
    pub jump: bool,
    pub drop_down: bool,
}

/// The core physics simulation engine replicating Growtopia platformer mechanics.
#[derive(Debug, Clone)]
pub struct PhysicsEngine {
    pub config: PhysicsConfig,
}

impl Default for PhysicsEngine {
    fn default() -> Self {
        Self {
            config: PhysicsConfig::default(),
        }
    }
}

impl PhysicsEngine {
    pub fn new(config: PhysicsConfig) -> Self {
        Self { config }
    }

    /// Simulate a single delta time step (subdivided for stability).
    pub fn step(
        &self,
        state: &mut PhysicsState,
        input: MovementInput,
        world: &impl CollisionProvider,
        dt: f32,
    ) {
        // Sub-step large deltas to prevent tunneling through tiles.
        const MAX_SUB_STEP: f32 = 1.0 / 60.0;
        let mut remaining = dt.clamp(0.0, 0.5);

        while remaining > 0.0 {
            let step_dt = remaining.min(MAX_SUB_STEP);
            self.tick_internal(state, input, world, step_dt);
            remaining -= step_dt;
        }
    }

    fn tick_internal(
        &self,
        state: &mut PhysicsState,
        input: MovementInput,
        world: &impl CollisionProvider,
        dt: f32,
    ) {
        const TILE_SIZE: f32 = 32.0;

        // 1. Check current environmental overlap (water, ice).
        let current_aabb = AABB::from_pos(state.pos.0, state.pos.1, &self.config);
        let in_water = self.check_water_overlap(&current_aabb, world);
        state.in_water = in_water;

        // 2. Horizontal Acceleration & Friction
        let friction = if in_water {
            self.config.water_drag
        } else if state.on_ground {
            self.config.ground_friction
        } else {
            self.config.air_friction
        };

        if input.move_left {
            state.facing_left = true;
            let accel = if in_water { self.config.acceleration * 0.6 } else { self.config.acceleration };
            state.vel.0 = (state.vel.0 - accel * dt).max(-self.config.walk_speed);
        } else if input.move_right {
            state.facing_left = false;
            let accel = if in_water { self.config.acceleration * 0.6 } else { self.config.acceleration };
            state.vel.0 = (state.vel.0 + accel * dt).min(self.config.walk_speed);
        } else {
            state.vel.0 *= friction.powf(dt * 60.0);
            if state.vel.0.abs() < 1.5 {
                state.vel.0 = 0.0;
            }
        }

        // 3. Vertical Dynamics (Gravity & Jump)
        if in_water {
            // Water physics
            let eff_gravity = self.config.gravity * self.config.water_drag * 0.4;
            state.vel.1 = (state.vel.1 + eff_gravity * dt).min(self.config.terminal_velocity * 0.4);

            if input.jump {
                state.vel.1 = self.config.water_swim_impulse;
                state.is_jumping = true;
                state.on_ground = false;
            }
        } else {
            // Normal air / ground physics
            if state.on_ground && input.jump {
                state.vel.1 = self.config.jump_impulse;
                state.on_ground = false;
                state.is_jumping = true;
                state.trampoline = false;
            } else if !state.on_ground {
                state.vel.1 = (state.vel.1 + self.config.gravity * dt).min(self.config.terminal_velocity);
                if state.vel.1 >= 0.0 {
                    state.is_jumping = false;
                }
            }
        }

        // 4. Resolve Horizontal (X) Motion and Collision
        let prev_x = state.pos.0;
        let mut target_x = prev_x + state.vel.0 * dt;
        let prev_aabb = AABB::from_pos(prev_x, state.pos.1, &self.config);

        if state.vel.0 > 0.0 {
            // Moving Right
            let test_aabb = AABB::new(prev_aabb.right, prev_aabb.top, target_x + self.config.hitbox_offset_x + self.config.hitbox_width, prev_aabb.bottom);
            let min_tx = (test_aabb.left / TILE_SIZE).floor() as i32;
            let max_tx = (test_aabb.right / TILE_SIZE).floor() as i32;
            let min_ty = (test_aabb.top / TILE_SIZE).floor() as i32;
            let max_ty = ((test_aabb.bottom - 0.1) / TILE_SIZE).floor() as i32;

            for tx in min_tx..=max_tx {
                for ty in min_ty..=max_ty {
                    let col = world.get_tile_collision(tx, ty);
                    if matches!(col, TileCollisionKind::Solid | TileCollisionKind::OneWayLeft) {
                        let tile_left = tx as f32 * TILE_SIZE;
                        let max_allowed_x = tile_left - self.config.hitbox_offset_x - self.config.hitbox_width;
                        if target_x > max_allowed_x {
                            target_x = max_allowed_x;
                            state.vel.0 = 0.0;
                        }
                    }
                }
            }
        } else if state.vel.0 < 0.0 {
            // Moving Left
            let test_aabb = AABB::new(target_x + self.config.hitbox_offset_x, prev_aabb.top, prev_aabb.left, prev_aabb.bottom);
            let min_tx = (test_aabb.left / TILE_SIZE).floor() as i32;
            let max_tx = (test_aabb.right / TILE_SIZE).floor() as i32;
            let min_ty = (test_aabb.top / TILE_SIZE).floor() as i32;
            let max_ty = ((test_aabb.bottom - 0.1) / TILE_SIZE).floor() as i32;

            for tx in (min_tx..=max_tx).rev() {
                for ty in min_ty..=max_ty {
                    let col = world.get_tile_collision(tx, ty);
                    if matches!(col, TileCollisionKind::Solid | TileCollisionKind::OneWayRight) {
                        let tile_right = (tx + 1) as f32 * TILE_SIZE;
                        let min_allowed_x = tile_right - self.config.hitbox_offset_x;
                        if target_x < min_allowed_x {
                            target_x = min_allowed_x;
                            state.vel.0 = 0.0;
                        }
                    }
                }
            }
        }
        state.pos.0 = target_x;

        // 5. Resolve Vertical (Y) Motion and Collision
        let prev_y = state.pos.1;
        let mut target_y = prev_y + state.vel.1 * dt;
        let curr_x_aabb = AABB::from_pos(state.pos.0, prev_y, &self.config);

        if state.vel.1 >= 0.0 {
            // Moving Down (Falling or resting)
            let test_bottom = target_y + self.config.hitbox_offset_y + self.config.hitbox_height;
            let min_tx = (curr_x_aabb.left / TILE_SIZE).floor() as i32;
            let max_tx = ((curr_x_aabb.right - 0.1) / TILE_SIZE).floor() as i32;
            let min_ty = (curr_x_aabb.bottom / TILE_SIZE).floor() as i32;
            let max_ty = (test_bottom / TILE_SIZE).floor() as i32;

            let mut landed = false;

            for ty in min_ty..=max_ty {
                for tx in min_tx..=max_tx {
                    let col = world.get_tile_collision(tx, ty);
                    let tile_top = ty as f32 * TILE_SIZE;

                    match col {
                        TileCollisionKind::Solid => {
                            let max_allowed_y = tile_top - self.config.hitbox_offset_y - self.config.hitbox_height;
                            if target_y >= max_allowed_y {
                                target_y = max_allowed_y;
                                state.vel.1 = 0.0;
                                state.on_ground = true;
                                state.is_jumping = false;
                                state.trampoline = false;
                                landed = true;
                            }
                        }
                        TileCollisionKind::Platform if !input.drop_down => {
                            // Only collide if feet were at or above the platform before the step
                            let feet_before = curr_x_aabb.bottom;
                            if feet_before <= tile_top + 4.0 {
                                let max_allowed_y = tile_top - self.config.hitbox_offset_y - self.config.hitbox_height;
                                if target_y >= max_allowed_y {
                                    target_y = max_allowed_y;
                                    state.vel.1 = 0.0;
                                    state.on_ground = true;
                                    state.is_jumping = false;
                                    state.trampoline = false;
                                    landed = true;
                                }
                            }
                        }
                        TileCollisionKind::Trampoline => {
                            let max_allowed_y = tile_top - self.config.hitbox_offset_y - self.config.hitbox_height;
                            if target_y >= max_allowed_y {
                                target_y = max_allowed_y;
                                state.vel.1 = -self.config.jump_impulse.abs() * self.config.trampoline_bounce;
                                state.trampoline = true;
                                state.on_ground = false;
                                state.is_jumping = true;
                                landed = true;
                            }
                        }
                        _ => {}
                    }
                }
            }

            if !landed {
                state.on_ground = false;
            }
        } else {
            // Moving Up (Jumping)
            let test_top = target_y + self.config.hitbox_offset_y;
            let min_tx = (curr_x_aabb.left / TILE_SIZE).floor() as i32;
            let max_tx = ((curr_x_aabb.right - 0.1) / TILE_SIZE).floor() as i32;
            let min_ty = (test_top / TILE_SIZE).floor() as i32;
            let max_ty = (curr_x_aabb.top / TILE_SIZE).floor() as i32;

            for ty in (min_ty..=max_ty).rev() {
                for tx in min_tx..=max_tx {
                    let col = world.get_tile_collision(tx, ty);
                    if matches!(col, TileCollisionKind::Solid) {
                        let tile_bottom = (ty + 1) as f32 * TILE_SIZE;
                        let min_allowed_y = tile_bottom - self.config.hitbox_offset_y;
                        if target_y < min_allowed_y {
                            target_y = min_allowed_y;
                            state.vel.1 = 0.0;
                        }
                    }
                    // Platforms are ignored on upward motion (jump-through!)
                }
            }
            state.on_ground = false;
        }

        state.pos.1 = target_y;
    }

    fn check_water_overlap(&self, aabb: &AABB, world: &impl CollisionProvider) -> bool {
        const TILE_SIZE: f32 = 32.0;
        let min_tx = (aabb.left / TILE_SIZE).floor() as i32;
        let max_tx = ((aabb.right - 0.1) / TILE_SIZE).floor() as i32;
        let min_ty = (aabb.top / TILE_SIZE).floor() as i32;
        let max_ty = ((aabb.bottom - 0.1) / TILE_SIZE).floor() as i32;

        for ty in min_ty..=max_ty {
            for tx in min_tx..=max_tx {
                if world.get_tile_collision(tx, ty) == TileCollisionKind::Water {
                    return true;
                }
            }
        }
        false
    }
}
