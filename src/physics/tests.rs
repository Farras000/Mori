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

    // Hitbox bottom should be at 160.0, so state.pos.1 = 160.0 - hitbox_height(30) - hitbox_offset_y(2) = 128.0
    assert!(state.on_ground, "Should have landed on the solid ground");
    assert_eq!(state.vel.1, 0.0, "Vertical velocity should be zero after landing");
    assert!((state.pos.1 - 128.0).abs() < 0.1, "Position Y should be snapped to ground, got {}", state.pos.1);
}

#[test]
fn test_jump_and_apex() {
    let mut map = SimpleCollisionMap::new(10, 10);
    for x in 0..10 {
        map.set(x, 5, TileCollisionKind::Solid);
    }

    let engine = PhysicsEngine::default();
    let mut state = PhysicsState::new(32.0, 128.0);
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

    // Right edge of hitbox (pos.0 + 6 + 20) cannot exceed 96.0 -> pos.0 <= 70.0
    assert!(state.pos.0 <= 70.01, "Should be stopped by the wall, pos.0={}", state.pos.0);
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

    // Jump up with extra strength to clear the platform
    let mut custom_engine = engine.clone();
    custom_engine.config.jump_impulse = -550.0;
    custom_engine.step(&mut state, MovementInput { jump: true, ..Default::default() }, &map, 1.0 / 60.0);

    // Entity moves upward past platform y=4
    let mut passed_above_platform = false;
    for _ in 0..50 {
        custom_engine.step(&mut state, MovementInput::default(), &map, 1.0 / 60.0);
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
    assert!((state.pos.1 - (128.0 - 32.0)).abs() < 1.0, "Should land on platform top, pos.1={}", state.pos.1);
}
