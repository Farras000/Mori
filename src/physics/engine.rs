use super::{
    collision::{CollisionProvider, TileCollisionKind, AABB},
    config::{CharacterModifiers, PhysicsConfig},
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

    /// Simulate a single delta time step using default item/malady modifiers.
    pub fn step(
        &self,
        state: &mut PhysicsState,
        input: MovementInput,
        world: &impl CollisionProvider,
        dt: f32,
    ) {
        self.step_with_modifiers(state, input, &CharacterModifiers::default(), world, dt);
    }

    /// Simulate a single delta time step with active gear and malady modifiers (subdivided for stability).
    pub fn step_with_modifiers(
        &self,
        state: &mut PhysicsState,
        input: MovementInput,
        mods: &CharacterModifiers,
        world: &impl CollisionProvider,
        dt: f32,
    ) {
        // Clear the one-shot jump event pulse once per step call so a jump fired
        // in any sub-step stays visible to network serialization at the end of the step.
        state.jump_pulse = false;

        // Sub-step large deltas to prevent tunneling through tiles.
        const MAX_SUB_STEP: f32 = 1.0 / 60.0;
        let mut remaining = dt.clamp(0.0, 0.5);

        while remaining > 0.0 {
            let step_dt = remaining.min(MAX_SUB_STEP);
            self.tick_internal(state, input, mods, world, step_dt);
            remaining -= step_dt;
        }
    }

    fn tick_internal(
        &self,
        state: &mut PhysicsState,
        input: MovementInput,
        mods: &CharacterModifiers,
        world: &impl CollisionProvider,
        dt: f32,
    ) {
        const TILE_SIZE: f32 = 32.0;

        // 1. Check current environmental overlap (water, ice).
        let current_aabb = AABB::from_pos(state.pos.0, state.pos.1, &self.config);
        let in_water = self.check_water_overlap(&current_aabb, world);
        state.in_water = in_water;

        // 2. Horizontal Acceleration, Strict Speed Cap & Friction
        let speed_mul = mods.speed_multiplier.clamp(0.35, 2.0);
        let air_boost = if !state.on_ground && !in_water && input.jump && mods.long_jump_speed_boost > 1.0 {
            mods.long_jump_speed_boost
        } else {
            1.0
        };
        let effective_walk_speed =
            (self.config.walk_speed * speed_mul * air_boost).clamp(60.0, self.config.max_walk_speed_cap);

        let friction = if in_water {
            self.config.water_drag
        } else if state.on_ground {
            self.config.ground_friction
        } else {
            self.config.air_friction
        };

        if input.move_left && !input.move_right {
            state.facing_left = true;
            let accel = if in_water {
                self.config.acceleration * 0.6
            } else if !state.on_ground {
                self.config.acceleration * 0.85
            } else {
                self.config.acceleration
            };
            if state.vel.0 >= -effective_walk_speed {
                state.vel.0 = (state.vel.0 - accel * dt).max(-effective_walk_speed);
            } else {
                state.vel.0 = (state.vel.0 + accel * dt).min(-effective_walk_speed);
            }
        } else if input.move_right && !input.move_left {
            state.facing_left = false;
            let accel = if in_water {
                self.config.acceleration * 0.6
            } else if !state.on_ground {
                self.config.acceleration * 0.85
            } else {
                self.config.acceleration
            };
            if state.vel.0 <= effective_walk_speed {
                state.vel.0 = (state.vel.0 + accel * dt).min(effective_walk_speed);
            } else {
                state.vel.0 = (state.vel.0 - accel * dt).max(effective_walk_speed);
            }
        } else {
            state.vel.0 *= friction.powf(dt * 60.0);
            if state.vel.0.abs() < 1.5 {
                state.vel.0 = 0.0;
            }
        }

        // 3. Vertical Dynamics (Gravity, Ground Jump, Double Jump, Jetpack Thrust & Slow Fall)
        let jump_mul = mods.jump_multiplier.clamp(0.45, 1.8);
        let effective_jump_impulse = self.config.jump_impulse * jump_mul;
        let jump_just_pressed = input.jump && !state.prev_jump_held;

        if in_water {
            // Water physics
            state.slow_falling = false;
            state.air_jumps_used = 0;
            state.jetpack_thrust_timer = 0.0;
            let eff_gravity = self.config.gravity * self.config.water_drag * 0.4;
            state.vel.1 = (state.vel.1 + eff_gravity * dt).min(self.config.terminal_velocity * 0.4);

            if input.jump {
                state.vel.1 = self.config.water_swim_impulse * jump_mul.clamp(0.75, 1.2);
                state.is_jumping = true;
                state.on_ground = false;
            }
        } else if state.on_ground && jump_just_pressed {
            // Ground jump is edge-triggered (matching native Growtopia: holding Jump must not auto-hop on land)
            state.vel.1 = effective_jump_impulse;
            state.on_ground = false;
            state.is_jumping = true;
            state.jump_pulse = true;
            state.trampoline = false;
            state.slow_falling = false;
            state.air_jumps_used = 0;
            state.jetpack_thrust_timer = 0.0;
        } else if !state.on_ground && jump_just_pressed && state.air_jumps_used < mods.max_air_jumps {
            // Wings / Double Jump (edge-triggered so holding W doesn't auto-burn)
            state.vel.1 = effective_jump_impulse * 0.96;
            state.air_jumps_used += 1;
            state.is_jumping = true;
            state.jump_pulse = true;
            state.trampoline = false;
            state.slow_falling = false;
        } else if !state.on_ground {
            let mut eff_gravity = self.config.gravity;
            if input.jump && mods.air_thrust_accel > 0.0 && state.jetpack_thrust_timer < 0.30 {
                eff_gravity = (eff_gravity - mods.air_thrust_accel).max(120.0);
                state.jetpack_thrust_timer += dt;
            }
            let mut max_fall = self.config.terminal_velocity;
            if mods.slow_fall && input.jump && state.vel.1 >= 0.0 {
                state.slow_falling = true;
                max_fall = mods.slow_fall_max_vy.max(40.0);
                eff_gravity = eff_gravity.min(self.config.gravity * 0.35);
            } else {
                state.slow_falling = false;
            }
            if !input.jump && state.vel.1 < 0.0 && !state.trampoline {
                eff_gravity += self.config.jump_cut_decel;
            }
            state.vel.1 = (state.vel.1 + eff_gravity * dt).min(max_fall);
            if state.vel.1 >= 0.0 {
                state.is_jumping = false;
            }
        } else {
            state.slow_falling = false;
            state.air_jumps_used = 0;
            state.jetpack_thrust_timer = 0.0;
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
                                state.air_jumps_used = 0;
                                state.slow_falling = false;
                                state.jetpack_thrust_timer = 0.0;
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
                                    state.air_jumps_used = 0;
                                    state.slow_falling = false;
                                    state.jetpack_thrust_timer = 0.0;
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
                                state.jump_pulse = true;
                                state.air_jumps_used = 0;
                                state.slow_falling = false;
                                state.jetpack_thrust_timer = 0.0;
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
        state.prev_jump_held = input.jump;
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

    /// Probes within +/- 2.5px of the entity's feet so spawns and teleports over loaded
    /// world geometry start cleanly grounded at the exact tile surface instead of briefly
    /// reporting airborne or overlapping into the floor.
    pub fn settle_on_ground(&self, state: &mut PhysicsState, world: &impl CollisionProvider) -> bool {
        const TILE_SIZE: f32 = 32.0;
        let aabb = AABB::from_pos(state.pos.0, state.pos.1, &self.config);
        let min_tx = (aabb.left / TILE_SIZE).floor() as i32;
        let max_tx = ((aabb.right - 0.1) / TILE_SIZE).floor() as i32;
        let min_ty = ((aabb.bottom - 2.5) / TILE_SIZE).floor() as i32;
        let max_ty = ((aabb.bottom + 2.5) / TILE_SIZE).floor() as i32;

        let mut best_y: Option<f32> = None;
        for ty in min_ty..=max_ty {
            let tile_top = ty as f32 * TILE_SIZE;
            if (aabb.bottom - tile_top).abs() > 2.5 {
                continue;
            }
            for tx in min_tx..=max_tx {
                let col = world.get_tile_collision(tx, ty);
                let is_floor = match col {
                    TileCollisionKind::Solid | TileCollisionKind::Ice => true,
                    TileCollisionKind::Platform => aabb.bottom <= tile_top + 4.0,
                    _ => false,
                };
                if is_floor {
                    let max_allowed_y =
                        tile_top - self.config.hitbox_offset_y - self.config.hitbox_height;
                    best_y = Some(match best_y {
                        Some(prev) => prev.min(max_allowed_y),
                        None => max_allowed_y,
                    });
                }
            }
        }

        if let Some(y) = best_y {
            state.pos.1 = y;
            state.vel.1 = 0.0;
            state.on_ground = true;
            state.is_jumping = false;
            state.trampoline = false;
            state.air_jumps_used = 0;
            state.slow_falling = false;
            state.jetpack_thrust_timer = 0.0;
            true
        } else {
            state.on_ground = false;
            false
        }
    }
}
