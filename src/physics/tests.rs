use super::*;
use crate::protocol::packet::PacketFlags;

#[test]
fn test_gravity_fall_to_ground() {
    let mut map = SimpleCollisionMap::new(10, 10);
    // Ground at y = 5 (pixels: 5 * 32 = 160.0)
    for x in 0..10 {
        map.set(x, 5, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    let mut state = PhysicsState::new(32.0, 32.0); // start at tile (1, 1), in the air
    state.on_ground = false;

    // Simulate 1 second of falling
    for _ in 0..60 {
        engine.step(&mut state, MovementInput::default(), &map, 1.0 / 60.0);
    }

    // Hitbox bottom should be at 160.0 (native colrect|0|0|20|30 -> offset_y=0, height=30)
    // so state.pos.1 = 160.0 - 30.0 = 130.0
    assert!(state.on_ground, "Should have landed on the solid ground");
    assert_eq!(state.vel.1, 0.0, "Vertical velocity should be zero after landing");
    assert!((state.pos.1 - 130.0).abs() < 0.1, "Position Y should be snapped to ground, got {}", state.pos.1);
}

#[test]
fn test_jump_and_apex() {
    let mut map = SimpleCollisionMap::new(10, 10);
    for x in 0..10 {
        map.set(x, 5, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    let mut state = PhysicsState::new(32.0, 130.0);
    state.on_ground = true;

    // Trigger jump
    engine.step(&mut state, MovementInput { jump: true, ..Default::default() }, &map, 1.0 / 60.0);
    assert!(!state.on_ground, "State should be airborne after jump");
    assert!(state.vel.1 < 0.0, "Velocity should be negative (upward) on jump");
    assert!(state.to_packet_flags().contains(PacketFlags::JUMP));

    // Simulate flight until apex
    let mut reached_apex = false;
    for _ in 0..60 {
        engine.step(&mut state, MovementInput::default(), &map, 1.0 / 60.0);
        if state.vel.1 >= 0.0 {
            reached_apex = true;
            break;
        }
    }
    assert!(reached_apex, "Entity should reach trajectory apex");
}

#[test]
fn test_wall_collision_stops_horizontal_motion() {
    let mut map = SimpleCollisionMap::new(10, 10);
    for x in 0..10 {
        map.set(x, 5, TileCollisionKind::Solid);
    }
    // Solid wall at (3, 4)
    map.set(3, 4, TileCollisionKind::Solid);

    let engine = PhysicsEngine::default();
    let mut state = PhysicsState::new(32.0, 128.0); // at (1, 4)
    state.on_ground = true;

    // Move right towards the wall at x=3 (pixel 96.0)
    for _ in 0..60 {
        engine.step(&mut state, MovementInput { move_right: true, ..Default::default() }, &map, 1.0 / 60.0);
    }

    // Right edge of hitbox (pos.0 + 0 + 20) cannot exceed 96.0 -> pos.0 <= 76.0
    assert!(state.pos.0 <= 76.01, "Should be stopped by the wall, pos.0={}", state.pos.0);
    assert_eq!(state.vel.0, 0.0, "Velocity should be zeroed upon wall impact");
}

#[test]
fn test_platform_jump_through_and_land() {
    let mut map = SimpleCollisionMap::new(10, 10);
    // Platform at y = 4 (128.0 px)
    for x in 0..10 {
        map.set(x, 4, TileCollisionKind::Platform);
    }
    // Solid floor at y = 7 (224.0 px)
    for x in 0..10 {
        map.set(x, 7, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    // Start standing below the platform on floor
    let mut state = PhysicsState::new(32.0, 224.0 - 32.0);
    state.on_ground = true;

    // Jump up with extra strength and hold jump to ascend cleanly through platform y=4
    let mut custom_engine = engine.clone();
    custom_engine.config.jump_impulse = -550.0;
    let mut passed_above_platform = false;
    for _ in 0..50 {
        custom_engine.step(&mut state, MovementInput { jump: true, ..Default::default() }, &map, 1.0 / 60.0);
        let feet = state.pos.1 + 32.0;
        if feet < 128.0 {
            passed_above_platform = true;
            break;
        }
    }
    assert!(passed_above_platform, "Should jump cleanly through platform from underneath");

    // Continue falling down onto platform
    for _ in 0..60 {
        custom_engine.step(&mut state, MovementInput::default(), &map, 1.0 / 60.0);
        if state.on_ground {
            break;
        }
    }
    assert!(state.on_ground, "Should land on top of the platform");
    assert!((state.pos.1 - (128.0 - 30.0)).abs() < 1.0, "Should land on platform top, pos.1={}", state.pos.1);
}

#[test]
fn test_real_items_and_world_dat_collision_and_movement() {
    if !std::path::Path::new("items.dat").exists() {
        return;
    }
    let items_data = std::fs::read("items.dat").expect("read items.dat");
    let items = crate::items::ItemsDat::parse(&items_data).expect("parse items.dat");

    let mut by_col: std::collections::BTreeMap<u8, Vec<(u32, String)>> = std::collections::BTreeMap::new();
    for item in items.items.iter() {
        let entry = by_col.entry(item.collision_type).or_default();
        if entry.len() < 4 {
            entry.push((item.id, item.name.clone()));
        }
    }
    println!("items.dat collision_types: {by_col:?}");

    if std::path::Path::new("world.dat").exists() {
        let world_bytes = std::fs::read("world.dat").expect("read world.dat");
        let world = crate::world::World::parse(&world_bytes).expect("parse world.dat");
        let door_tile = world
            .tile_map
            .tiles
            .iter()
            .find(|t| t.fg_item_id == 6)
            .expect("Main Door (id 6) in world.dat");
        let (dx, dy) = (door_tile.x, door_tile.y);
        println!(
            "world.dat '{}' {}x{} door=({},{})",
            world.tile_map.world_name, world.tile_map.width, world.tile_map.height, dx, dy
        );

        let collision = crate::physics::BotWorldCollision::new(&world.tile_map, &items, 0);
        assert_eq!(
            collision.get_tile_collision(dx as i32, dy as i32),
            TileCollisionKind::Air,
            "Main Door at ({dx},{dy}) should be walkable"
        );
        for row in (dy as i32 - 2)..=(dy as i32 + 2) {
            let mut line = Vec::new();
            for col in (dx as i32 - 3)..=(dx as i32 + 3) {
                let fg = world.get_tile(col as u32, row as u32).map(|t| t.fg_item_id).unwrap_or(9999);
                let ck = collision.get_tile_collision(col, row);
                line.push(format!("({col},{row}):fg={fg}/{ck:?}"));
            }
            println!("  {}", line.join(" "));
        }

        // Choose a contiguous flat 3-tile solid runway near the door (prefer right, else left, else anywhere)
        let is_flat_step = |tx: i32, ty: i32| -> bool {
            collision.get_tile_collision(tx, ty + 1) == TileCollisionKind::Solid
                && collision.get_tile_collision(tx, ty) == TileCollisionKind::Air
                && collision.get_tile_collision(tx, ty - 1) == TileCollisionKind::Air
                && collision.get_tile_collision(tx, ty - 2) == TileCollisionKind::Air
        };
        let (dx_i, dy_i) = (dx as i32, dy as i32);
        let (spawn_tx, spawn_ty, walk_right_first) = if is_flat_step(dx_i + 1, dy_i) && is_flat_step(dx_i + 2, dy_i) {
            (dx_i, dy_i, true)
        } else if dx_i >= 2 && is_flat_step(dx_i - 1, dy_i) && is_flat_step(dx_i - 2, dy_i) {
            (dx_i, dy_i, false)
        } else {
            let mut found = None;
            'scan: for ty in 3..(world.tile_map.height as i32 - 1) {
                for tx in 1..(world.tile_map.width as i32 - 3) {
                    if is_flat_step(tx, ty) && is_flat_step(tx + 1, ty) && is_flat_step(tx + 2, ty) {
                        found = Some((tx, ty, true));
                        break 'scan;
                    }
                }
            }
            found.expect("world.dat should contain at least one 3-tile flat floor")
        };

        let engine = PhysicsEngine::default();
        let mut phys = PhysicsState::new(
            (spawn_tx as f32) * 32.0 + 6.0,
            (spawn_ty as f32) * 32.0 + 2.0,
        );
        assert!(
            engine.settle_on_ground(&mut phys, &collision),
            "spawn tile ({spawn_tx}, {spawn_ty}) should settle flush on solid ground"
        );
        let start_x = phys.pos.0;
        for _ in 0..20 {
            engine.step(
                &mut phys,
                MovementInput {
                    move_left: !walk_right_first,
                    move_right: walk_right_first,
                    jump: false,
                    drop_down: false,
                },
                &collision,
                0.016,
            );
        }
        println!("After walking along runway: start_x={start_x} -> pos={:?}", phys.pos);
        if walk_right_first {
            assert!(phys.pos.0 > start_x + 10.0, "player stuck walking right from door!");
        } else {
            assert!(phys.pos.0 < start_x - 10.0, "player stuck walking left from door!");
        }

        let turn_x = phys.pos.0;
        let start_y = phys.pos.1;
        for step in 0..40 {
            engine.step(
                &mut phys,
                MovementInput {
                    move_left: walk_right_first,
                    move_right: !walk_right_first,
                    jump: step < 18,
                    drop_down: false,
                },
                &collision,
                0.016,
            );
        }
        println!("After jumping+turning back: turn_x={turn_x} start_y={start_y} -> pos={:?}", phys.pos);
        if walk_right_first {
            assert!(phys.pos.0 < turn_x - 5.0, "player stuck walking left!");
        } else {
            assert!(phys.pos.0 > turn_x + 5.0, "player stuck walking right!");
        }
        assert!(phys.pos.1 < start_y - 5.0, "player failed to jump!");
    }
}

#[test]
fn test_walk_speed_capped_on_sustained_hold() {
    let mut map = SimpleCollisionMap::new(100, 10);
    for x in 0..100 {
        map.set(x, 8, TileCollisionKind::Solid);
    }
    let engine = PhysicsEngine::default();
    let mut state = PhysicsState::new(32.0, 224.0);
    state.on_ground = true;

    for _ in 0..180 {
        engine.step(
            &mut state,
            MovementInput { move_right: true, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
        assert!(
            state.vel.0 <= engine.config.walk_speed + 0.01,
            "walk speed must stay capped at {}, got {}",
            engine.config.walk_speed,
            state.vel.0
        );
    }
    assert!(
        (state.vel.0 - engine.config.walk_speed).abs() < 0.1,
        "sustained hold should stabilize at walk_speed"
    );

    // Speedy gear + hard cap check
    let mut insane_mods = CharacterModifiers::default();
    insane_mods.speed_multiplier = 2.5;
    for _ in 0..30 {
        engine.step_with_modifiers(
            &mut state,
            MovementInput { move_right: true, ..Default::default() },
            &insane_mods,
            &map,
            1.0 / 60.0,
        );
        assert!(
            state.vel.0 <= engine.config.max_walk_speed_cap + 0.01,
            "hard speed cap exceeded: {}",
            state.vel.0
        );
    }
}

#[test]
fn test_normal_jump_height_calibrated_native_growtopia() {
    let mut map = SimpleCollisionMap::new(20, 10);
    for x in 0..20 {
        map.set(x, 8, TileCollisionKind::Solid);
    }
    let engine = PhysicsEngine::default();
    let start_y = 224.0;

    // 1. Full held jump clears ~3 blocks (~98..112px) cleanly, never moon-jumping > 130px.
    let mut state = PhysicsState::new(64.0, start_y);
    state.on_ground = true;
    let mut min_y = start_y;
    for frame in 0..60 {
        engine.step(
            &mut state,
            MovementInput { jump: frame < 32, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
        min_y = min_y.min(state.pos.1);
    }
    let full_apex = start_y - min_y;
    assert!(
        full_apex > 96.0 && full_apex < 120.0,
        "native GT full jump apex should clear 3 blocks (~96..115px), got {full_apex}px"
    );

    // 2. Short tap jump (<3 frames) cuts early via jump_cut_decel (< 50px)
    let mut tap_state = PhysicsState::new(64.0, start_y);
    tap_state.on_ground = true;
    let mut tap_min_y = start_y;
    for frame in 0..40 {
        engine.step(
            &mut tap_state,
            MovementInput { jump: frame < 2, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
        tap_min_y = tap_min_y.min(tap_state.pos.1);
    }
    let tap_apex = start_y - tap_min_y;
    assert!(
        tap_apex > 12.0 && tap_apex < 50.0,
        "short-tap jump should cut early (<50px), got {tap_apex}px"
    );
}

#[test]
fn test_naked_walk_speed_caps_at_250_over_long_hold() {
    let mut map = SimpleCollisionMap::new(200, 10);
    for x in 0..200 {
        map.set(x, 8, TileCollisionKind::Solid);
    }
    let engine = PhysicsEngine::default();
    let mut state = PhysicsState::new(32.0, 224.0);
    state.on_ground = true;

    for _ in 0..600 {
        engine.step(
            &mut state,
            MovementInput { move_right: true, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
        assert!(
            state.vel.0 <= 250.01,
            "naked walk speed exceeded 250 px/s during 10s hold: {}",
            state.vel.0
        );
    }
    assert!((state.vel.0 - 250.0).abs() < 0.1, "expected 250 px/s steady speed, got {}", state.vel.0);
}

#[test]
fn test_wings_double_jump_edge_triggered_and_resets_on_land() {
    let mut map = SimpleCollisionMap::new(20, 12);
    for x in 0..20 {
        map.set(x, 10, TileCollisionKind::Solid);
    }
    let engine = PhysicsEngine::default();
    let mut state = PhysicsState::new(64.0, 288.0);
    state.on_ground = true;

    let mut wings_mods = CharacterModifiers::default();
    wings_mods.max_air_jumps = 1;

    // Holding jump continuously from ground must NOT consume air jump
    for _ in 0..10 {
        engine.step_with_modifiers(
            &mut state,
            MovementInput { jump: true, ..Default::default() },
            &wings_mods,
            &map,
            1.0 / 60.0,
        );
    }
    assert_eq!(state.air_jumps_used, 0);

    // Release jump for 1 frame, then press again to double jump
    engine.step_with_modifiers(&mut state, MovementInput::default(), &wings_mods, &map, 1.0 / 60.0);
    engine.step_with_modifiers(
        &mut state,
        MovementInput { jump: true, ..Default::default() },
        &wings_mods,
        &map,
        1.0 / 60.0,
    );
    assert_eq!(state.air_jumps_used, 1);
    assert!(state.vel.1 < -200.0, "second jump should impart upward impulse");

    // Releasing and pressing a third time in mid-air must NOT grant a triple jump
    engine.step_with_modifiers(&mut state, MovementInput::default(), &wings_mods, &map, 1.0 / 60.0);
    let vy_before = state.vel.1;
    engine.step_with_modifiers(
        &mut state,
        MovementInput { jump: true, ..Default::default() },
        &wings_mods,
        &map,
        1.0 / 60.0,
    );
    assert_eq!(state.air_jumps_used, 1);
    assert!(state.vel.1 > vy_before, "gravity continues pulling down on 3rd press");

    // Land back on ground -> air_jumps_used resets
    for _ in 0..120 {
        engine.step_with_modifiers(&mut state, MovementInput::default(), &wings_mods, &map, 1.0 / 60.0);
        if state.on_ground {
            break;
        }
    }
    assert!(state.on_ground);
    assert_eq!(state.air_jumps_used, 0);
}

#[test]
fn test_jetpack_high_long_jump_and_slow_fall_and_malady() {
    let mut map = SimpleCollisionMap::new(50, 12);
    for x in 0..50 {
        map.set(x, 10, TileCollisionKind::Solid);
    }
    let engine = PhysicsEngine::default();
    let start_y = 288.0;

    // 1. Jetpack vs normal jump
    let mut jet_mods = CharacterModifiers::default();
    jet_mods.jump_multiplier = 1.26;
    jet_mods.air_thrust_accel = 320.0;
    jet_mods.long_jump_speed_boost = 1.18;

    let mut naked_state = PhysicsState::new(32.0, start_y);
    naked_state.on_ground = true;
    for _ in 0..50 {
        engine.step(
            &mut naked_state,
            MovementInput { move_right: true, jump: true, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
    }

    let mut jet_state = PhysicsState::new(32.0, start_y);
    jet_state.on_ground = true;
    let mut jet_min_y = start_y;
    for _ in 0..50 {
        engine.step_with_modifiers(
            &mut jet_state,
            MovementInput { move_right: true, jump: true, ..Default::default() },
            &jet_mods,
            &map,
            1.0 / 60.0,
        );
        jet_min_y = jet_min_y.min(jet_state.pos.1);
    }
    let jet_apex = start_y - jet_min_y;
    assert!(jet_apex > 150.0, "jetpack should reach ~5+ tiles high jump (>150px), got {jet_apex}px");
    assert!(
        jet_state.pos.0 > naked_state.pos.0 + 15.0,
        "jetpack long jump should carry farther horizontally than naked ({} vs {})",
        jet_state.pos.0,
        naked_state.pos.0
    );

    // 2. Slow Fall (Parasol)
    let mut parasol_mods = CharacterModifiers::default();
    parasol_mods.slow_fall = true;
    parasol_mods.slow_fall_max_vy = 130.0;
    let mut pf_state = PhysicsState::new(64.0, 32.0);
    pf_state.on_ground = false;
    for _ in 0..40 {
        engine.step_with_modifiers(
            &mut pf_state,
            MovementInput { jump: true, ..Default::default() },
            &parasol_mods,
            &map,
            1.0 / 60.0,
        );
    }
    assert!(pf_state.slow_falling);
    assert!(pf_state.vel.1 <= 130.1, "slow fall descent exceeded cap: {}", pf_state.vel.1);
    assert!(pf_state.to_packet_flags().contains(PacketFlags::PARASOL));

    // 3. Chicken Feet malady
    let malady_mods = modifiers::resolve_character_modifiers(
        &crate::items::ItemsDat { version: 0, items: Vec::new() },
        &[],
        Some(MaladyKind::ChickenFeet),
        modifiers::ServerCharacterModifiers::default(),
    );
    assert!(malady_mods.speed_multiplier < 0.75);
    assert!(malady_mods.jump_multiplier < 0.85);
}

#[test]
fn test_holding_jump_does_not_auto_rejump_or_hover_on_landing() {
    let mut map = SimpleCollisionMap::new(12, 10);
    for x in 0..12 {
        map.set(x, 6, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    let ground_y = 6.0 * 32.0 - 30.0; // 162.0 (native colrect|0|0|20|30 resting on y=6)
    let mut state = PhysicsState::new(64.0, ground_y);
    state.on_ground = true;

    // Frame 0: press and hold Jump continuously for 120 frames (2 full seconds)
    let mut left_ground = false;
    let mut relanded_at = None;
    for frame in 0..120 {
        engine.step(
            &mut state,
            MovementInput { jump: true, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
        if frame == 0 {
            assert!(!state.on_ground, "first press must launch into jump");
            left_ground = true;
        }
        if left_ground && state.on_ground {
            if relanded_at.is_none() {
                relanded_at = Some(frame);
            }
        } else if relanded_at.is_some() {
            panic!(
                "bot auto-rejumped at frame {frame} while Jump was continuously held (vel={:?}, pos={:?})",
                state.vel, state.pos
            );
        }
    }

    assert!(relanded_at.is_some(), "single jump should land back on ground well within 2s");
    assert!(state.on_ground, "bot must remain firmly on ground while Jump stays held");
    assert_eq!(state.vel.1, 0.0, "vertical velocity must stay zero on ground");
    assert!(
        (state.pos.1 - ground_y).abs() < 0.01,
        "feet must rest flush at {ground_y}, got {}",
        state.pos.1
    );

    // Releasing Jump then clicking again must allow jumping a second time immediately
    engine.step(&mut state, MovementInput { jump: false, ..Default::default() }, &map, 1.0 / 60.0);
    assert!(state.on_ground);
    engine.step(&mut state, MovementInput { jump: true, ..Default::default() }, &map, 1.0 / 60.0);
    assert!(!state.on_ground, "fresh click after release must trigger next jump");
    assert!(state.vel.1 < -300.0);
}

#[test]
fn test_pressing_jump_while_falling_does_not_auto_bounce_on_impact() {
    let mut map = SimpleCollisionMap::new(10, 10);
    for x in 0..10 {
        map.set(x, 6, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    let ground_y = 6.0 * 32.0 - 30.0;
    let mut state = PhysicsState::new(64.0, 96.0);
    state.on_ground = false;

    // Hold Jump before touching the ground and keep holding through landing
    for _ in 0..90 {
        engine.step(
            &mut state,
            MovementInput { jump: true, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
    }

    assert!(state.on_ground, "falling while holding Jump must settle cleanly on ground");
    assert_eq!(state.vel.1, 0.0);
    assert!((state.pos.1 - ground_y).abs() < 0.01);
}

#[test]
fn test_jump_pulse_is_one_shot_across_hold_and_limited_to_max_two_with_wings() {
    let mut map = SimpleCollisionMap::new(12, 12);
    for x in 0..12 {
        map.set(x, 8, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    let ground_y = 8.0 * 32.0 - 30.0; // 226.0
    let mut state = PhysicsState::new(64.0, ground_y);
    state.on_ground = true;

    // 1. Naked long hold: must emit PacketFlags::JUMP ONLY once at jump launch,
    // NEVER repeatedly while vel.1 < -20 during the upward arc.
    let mut jump_packets = 0;
    for frame in 0..35 {
        engine.step(
            &mut state,
            MovementInput { jump: true, ..Default::default() },
            &map,
            1.0 / 60.0,
        );
        // Punch/place action flags must never emit JUMP or consume jump_pulse
        assert!(
            !state.to_action_packet_flags().contains(PacketFlags::JUMP),
            "action packets must not inject PacketFlags::JUMP on frame {frame}"
        );
        let flags = state.consume_packet_flags();
        if flags.contains(PacketFlags::JUMP) {
            jump_packets += 1;
            assert_eq!(frame, 0, "JUMP flag must only fire on launch frame 0, got frame {frame}");
        }
        assert!(!state.jump_pulse, "consume_packet_flags must reset jump_pulse");
    }
    assert_eq!(jump_packets, 1, "holding jump once must emit exactly 1 JUMP packet, not spam");

    // Releasing mid-air must NOT emit another JUMP packet
    for _ in 0..5 {
        engine.step(&mut state, MovementInput::default(), &map, 1.0 / 60.0);
        assert!(!state.consume_packet_flags().contains(PacketFlags::JUMP));
    }

    // 2. Wings double-jump: max 2 JUMP pulses total (ground launch + 1st air click).
    let mut wings_mods = CharacterModifiers::default();
    wings_mods.max_air_jumps = 1;
    let mut w_state = PhysicsState::new(64.0, ground_y);
    w_state.on_ground = true;
    let mut wings_jump_packets = 0;

    // Frame 0: ground launch
    engine.step_with_modifiers(
        &mut w_state,
        MovementInput { jump: true, ..Default::default() },
        &wings_mods,
        &map,
        1.0 / 60.0,
    );
    if w_state.consume_packet_flags().contains(PacketFlags::JUMP) {
        wings_jump_packets += 1;
    }

    // Frames 1..8: hold Jump -> 0 extra pulses
    for _ in 0..8 {
        engine.step_with_modifiers(
            &mut w_state,
            MovementInput { jump: true, ..Default::default() },
            &wings_mods,
            &map,
            1.0 / 60.0,
        );
        assert!(!w_state.consume_packet_flags().contains(PacketFlags::JUMP));
    }

    // Frame 9: release Jump
    engine.step_with_modifiers(&mut w_state, MovementInput::default(), &wings_mods, &map, 1.0 / 60.0);
    assert!(!w_state.consume_packet_flags().contains(PacketFlags::JUMP));

    // Frame 10: press 2nd jump in mid-air -> 1 extra JUMP pulse (total 2)
    engine.step_with_modifiers(
        &mut w_state,
        MovementInput { jump: true, ..Default::default() },
        &wings_mods,
        &map,
        1.0 / 60.0,
    );
    if w_state.consume_packet_flags().contains(PacketFlags::JUMP) {
        wings_jump_packets += 1;
    }
    assert_eq!(w_state.air_jumps_used, 1);

    // Hold + release + attempt 3rd press in mid-air -> must NEVER emit a 3rd jump
    for _ in 0..3 {
        engine.step_with_modifiers(
            &mut w_state,
            MovementInput { jump: true, ..Default::default() },
            &wings_mods,
            &map,
            1.0 / 60.0,
        );
        assert!(!w_state.consume_packet_flags().contains(PacketFlags::JUMP));
    }
    engine.step_with_modifiers(&mut w_state, MovementInput::default(), &wings_mods, &map, 1.0 / 60.0);
    engine.step_with_modifiers(
        &mut w_state,
        MovementInput { jump: true, ..Default::default() },
        &wings_mods,
        &map,
        1.0 / 60.0,
    );
    assert!(!w_state.consume_packet_flags().contains(PacketFlags::JUMP), "3rd jump in air must be blocked");
    assert_eq!(wings_jump_packets, 2, "double jump allows at most 2 JUMP pulses per air cycle");
}

#[test]
fn test_variable_hold_jump_short_medium_full_and_early_release() {
    let mut map = SimpleCollisionMap::new(12, 30);
    for x in 0..12 {
        map.set(x, 24, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    let start_y = 24.0 * 32.0 - 30.0; // 738.0 (row 23 resting on row 24)

    let simulate_hold = |hold_frames: usize| -> (f32, f32) {
        let mut s = PhysicsState::new(64.0, start_y);
        s.on_ground = true;
        let mut min_y = start_y;
        let mut vy_after_release = 0.0;
        for f in 0..90 {
            let jump = f < hold_frames;
            engine.step(
                &mut s,
                MovementInput { jump, ..Default::default() },
                &map,
                1.0 / 120.0,
            );
            if f == hold_frames + 1 {
                vy_after_release = s.vel.1;
            }
            if s.pos.1 < min_y {
                min_y = s.pos.1;
            }
        }
        (start_y - min_y, vy_after_release)
    };

    // Short tap (~16ms -> 2 frames @ 120Hz): < 1 tile (< 32px)
    let (short_rise, short_vy_rel) = simulate_hold(2);
    assert!(
        short_rise > 12.0 && short_rise < 32.0,
        "quick tap must stay under 1 tile (<32px), got {short_rise}"
    );
    assert!(short_vy_rel > -400.0, "early release must aggressively brake upward speed");

    // Medium hold (~117ms -> 14 frames @ 120Hz): between 1 and ~2.2 blocks, immediately stops rising when released
    let (med_rise, _) = simulate_hold(14);
    assert!(
        med_rise > 40.0 && med_rise < 76.0,
        "medium hold must reach 1.25-2.4 tiles, got {med_rise}"
    );

    // Full hold (~500ms -> 60 frames @ 120Hz): up to ~3 tiles (y=23 -> y=20, 96-112px)
    let (full_rise, _) = simulate_hold(60);
    assert!(
        full_rise >= 96.0 && full_rise < 115.0,
        "full hold must clear ~3 tiles without Wings, got {full_rise}"
    );
    assert!(short_rise < med_rise && med_rise < full_rise);
}

#[test]
fn test_settle_on_ground_snaps_spawn_flush_without_airborne_flash() {
    let mut map = SimpleCollisionMap::new(100, 60);
    for x in 0..100 {
        map.set(x, 24, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    assert_eq!(engine.config.hitbox_offset_x, 0.0);
    assert_eq!(engine.config.hitbox_offset_y, 0.0);
    assert_eq!(engine.config.hitbox_width, 20.0);
    assert_eq!(engine.config.hitbox_height, 30.0);

    // Native Growtopia spawn standing on row 24 (768.0) -> 738.0
    let mut flush = PhysicsState::new(1990.0, 738.0);
    flush.on_ground = false;
    assert!(engine.settle_on_ground(&mut flush, &map));
    assert!(flush.on_ground);
    assert!((flush.pos.1 - 738.0).abs() < 0.001);

    // Spawn within 2px above solid floor -> snaps flush onto 738.0 immediately
    let mut slightly_high = PhysicsState::new(1990.0, 736.0);
    slightly_high.on_ground = false;
    assert!(engine.settle_on_ground(&mut slightly_high, &map));
    assert!(slightly_high.on_ground);
    assert!((slightly_high.pos.1 - 738.0).abs() < 0.001);

    // High mid-air spawn stays airborne
    let mut mid_air = PhysicsState::new(1990.0, 600.0);
    assert!(!engine.settle_on_ground(&mut mid_air, &map));
    assert!(!mid_air.on_ground);
    assert!((mid_air.pos.1 - 600.0).abs() < 0.001);
}
