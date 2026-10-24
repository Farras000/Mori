#![allow(clippy::result_large_err)]

use std::net::ToSocketAddrs;

use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use super::SharedManager;
use super::mori;
use super::mori::mori_server::Mori;
use crate::bot::Socks5Config;
use crate::bot_manager::BotInfo as ManagerBotInfo;
use crate::bot_state::{BotCommand, BotDelays, BotState};
use crate::events::{WsEvent, WsInvItem, WsObject, WsTile, WsTx};
use crate::items::ItemInfo;
use crate::protocol::packet::{GamePacketType, GameUpdatePacket, PacketFlags};

pub struct MoriService {
    manager: SharedManager,
    ws_tx: WsTx,
}

impl MoriService {
    pub fn new(manager: SharedManager, ws_tx: WsTx) -> Self {
        Self { manager, ws_tx }
    }

    fn send_cmd(&self, bot_id: u32, cmd: BotCommand) -> Result<(), Status> {
        let ok = self
            .manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?
            .send_cmd(bot_id, cmd);
        if ok {
            Ok(())
        } else {
            Err(Status::not_found(format!("bot {bot_id} not found")))
        }
    }

    fn bot_state(&self, bot_id: u32) -> Result<BotState, Status> {
        self.manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?
            .get_state(bot_id)
            .ok_or_else(|| Status::not_found(format!("bot {bot_id} not found")))
    }

    fn bot_username(&self, bot_id: u32) -> String {
        self.bot_state(bot_id)
            .map(|s| s.username.clone())
            .unwrap_or_default()
    }
}

// ── Converters ─────────────────────────────────────────────────────────────

fn bot_ref(id: &Option<mori::BotRef>) -> Result<u32, Status> {
    id.as_ref()
        .map(|b| b.bot_id)
        .ok_or_else(|| Status::invalid_argument("missing bot ref"))
}

fn delays_to_proto(d: &BotDelays) -> mori::BotDelays {
    mori::BotDelays {
        place_ms: d.place_ms,
        walk_ms: d.walk_ms,
        twofa_secs: d.twofa_secs,
        server_overload_secs: d.server_overload_secs,
        too_many_logins_secs: d.too_many_logins_secs,
        maintenance_secs: d.maintenance_secs,
    }
}

fn delays_from_proto(d: &mori::BotDelays) -> BotDelays {
    BotDelays {
        place_ms: d.place_ms,
        walk_ms: d.walk_ms,
        twofa_secs: d.twofa_secs,
        server_overload_secs: d.server_overload_secs,
        too_many_logins_secs: d.too_many_logins_secs,
        maintenance_secs: d.maintenance_secs,
    }
}

fn config_to_proto(s: &BotState) -> mori::BotConfig {
    mori::BotConfig {
        auto_collect: s.auto_collect,
        collect_radius_tiles: s.collect_radius_tiles as u32,
        collect_blacklist: s.collect_blacklist.iter().map(|v| *v as u32).collect(),
        ignore_gems: s.ignore_gems,
        ignore_essences: s.ignore_essences,
        auto_leave_on_mod: s.auto_leave_on_mod,
        auto_ban: s.auto_ban,
        collect_path_check: s.collect_path_check,
        auto_reconnect: s.auto_reconnect,
        delays: Some(delays_to_proto(&s.delays)),
    }
}

fn info_to_proto(b: &ManagerBotInfo) -> mori::BotInfo {
    mori::BotInfo {
        bot_id: b.id,
        username: b.username.clone(),
        status: b.status.clone(),
        world: b.world.clone(),
        pos_x: b.pos_x,
        pos_y: b.pos_y,
        gems: b.gems,
        ping_ms: b.ping_ms,
    }
}

fn state_to_proto(bot_id: u32, username: &str, s: &BotState) -> mori::BotState {
    let _ = bot_id;
    mori::BotState {
        status: s.status.to_string(),
        username: if s.username.is_empty() {
            username.to_string()
        } else {
            s.username.clone()
        },
        mac: s.mac.clone(),
        world_name: s.world_name.clone(),
        pos_x: s.pos_x,
        pos_y: s.pos_y,
        world_width: s.world_width,
        world_height: s.world_height,
        objects: s
            .objects
            .iter()
            .map(|o| mori::WorldObject {
                uid: o.uid,
                item_id: o.item_id as u32,
                x: o.x,
                y: o.y,
                count: o.count as u32,
            })
            .collect(),
        players: s
            .players
            .iter()
            .map(|p| mori::PlayerInfo {
                net_id: p.net_id,
                name: p.name.clone(),
                pos_x: p.pos_x,
                pos_y: p.pos_y,
                country: p.country.clone(),
            })
            .collect(),
        inventory: s
            .inventory
            .iter()
            .map(|i| mori::InvSlot {
                item_id: i.item_id as u32,
                amount: i.amount as u32,
                is_active: i.is_active,
                action_type: i.action_type as u32,
            })
            .collect(),
        inventory_size: s.inventory_size,
        gems: s.gems,
        console: s.console.clone(),
        ping_ms: s.ping_ms,
        config: Some(config_to_proto(s)),
    }
}

fn tiles_to_proto(s: &BotState) -> Vec<mori::TileInfo> {
    if s.world_width == 0 {
        return Vec::new();
    }
    s.tiles
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let i = i as u32;
            mori::TileInfo {
                x: i % s.world_width,
                y: i / s.world_width,
                fg_item_id: t.fg_item_id as u32,
                bg_item_id: t.bg_item_id as u32,
                flags: t.flags as u32,
                tile_type: format!("{:?}", t.tile_type),
            }
        })
        .collect()
}

fn item_to_proto(i: &ItemInfo) -> mori::ItemInfo {
    mori::ItemInfo {
        id: i.id,
        name: i.name.clone(),
        action_type: i.action_type as u32,
        collision_type: i.collision_type as u32,
        clothing_type: i.clothing_type as u32,
        rarity: i.rarity as u32,
        grow_time: i.grow_time,
        drop_chance: i.drop_chance,
        texture: i.texture_file_name.clone(),
        texture_hash: i.texture_hash,
        texture_x: i.texture_x as u32,
        texture_y: i.texture_y as u32,
        seed_color: i.base_color,
        seed_overlay_color: i.overlay_color,
        strength: (i.block_health / 6) as u32,
    }
}

fn packet_from_proto(p: &mori::GameUpdatePacket) -> GameUpdatePacket {
    GameUpdatePacket {
        packet_type: GamePacketType::from(p.r#type as u8),
        object_type: p.object_type as u8,
        jump_count: p.count1 as u8,
        animation_type: p.count2 as u8,
        net_id: p.netid,
        target_net_id: p.item,
        flags: PacketFlags::from_bits_retain(p.flags),
        float_variable: p.float_var,
        value: p.int_data,
        vector_x: p.vec_x,
        vector_y: p.vec_y,
        vector_x2: p.vec2_x,
        vector_y2: p.vec2_y,
        particle_rotation: p.particle_rotation,
        int_x: p.int_x,
        int_y: p.int_y,
        ..Default::default()
    }
}

fn parse_proxy(p: &mori::ProxyConfig) -> Result<Socks5Config, Status> {
    let addr = format!("{}:{}", p.host, p.port).parse().or_else(|_| {
        let mut addrs = format!("{}:{}", p.host, p.port)
            .to_socket_addrs()
            .map_err(|_| Status::invalid_argument("invalid proxy host"))?;
        addrs
            .next()
            .ok_or_else(|| Status::invalid_argument("cannot resolve proxy host"))
    })?;
    Ok(Socks5Config {
        proxy_addr: addr,
        username: (!p.username.is_empty()).then(|| p.username.clone()),
        password: (!p.password.is_empty()).then(|| p.password.clone()),
    })
}

// ── WsEvent → proto ────────────────────────────────────────────────────────

fn event_bot_id(ev: &WsEvent) -> u32 {
    match ev {
        WsEvent::BotAdded { bot_id, .. }
        | WsEvent::BotRemoved { bot_id }
        | WsEvent::BotStatus { bot_id, .. }
        | WsEvent::BotWorld { bot_id, .. }
        | WsEvent::BotMove { bot_id, .. }
        | WsEvent::BotGems { bot_id, .. }
        | WsEvent::BotPing { bot_id, .. }
        | WsEvent::PlayerSpawn { bot_id, .. }
        | WsEvent::PlayerMove { bot_id, .. }
        | WsEvent::PlayerLeave { bot_id, .. }
        | WsEvent::WorldLoaded { bot_id, .. }
        | WsEvent::TileUpdate { bot_id, .. }
        | WsEvent::ObjectsUpdate { bot_id, .. }
        | WsEvent::InventoryUpdate { bot_id, .. }
        | WsEvent::Console { bot_id, .. }
        | WsEvent::BotTrackInfo { bot_id, .. }
        | WsEvent::BotUsername { bot_id, .. }
        | WsEvent::BotAutoCollect { bot_id, .. }
        | WsEvent::BotDelays { bot_id, .. }
        | WsEvent::BotProxy { bot_id, .. }
        | WsEvent::Chat { bot_id, .. }
        | WsEvent::DialogRequest { bot_id, .. }
        | WsEvent::DialogClose { bot_id } => *bot_id,
    }
}

fn ws_tile_to_proto(bot_id: u32, t: &WsTile) -> mori::TileEvent {
    mori::TileEvent {
        bot_id,
        fg: t.fg as u32,
        bg: t.bg as u32,
        flags: t.flags as u32,
        tile_type: format!("{:?}", t.tile_type),
    }
}

fn ws_object_to_proto(o: &WsObject) -> mori::WorldObject {
    mori::WorldObject {
        uid: o.uid,
        item_id: o.item_id as u32,
        x: o.x,
        y: o.y,
        count: o.count as u32,
    }
}

fn ws_item_to_proto(i: &WsInvItem) -> mori::InvSlot {
    mori::InvSlot {
        item_id: i.item_id as u32,
        amount: i.amount as u32,
        is_active: i.is_active,
        action_type: i.action_type as u32,
    }
}

fn event_to_proto(ev: &WsEvent) -> mori::BotEvent {
    let event = match ev {
        WsEvent::BotAdded { bot_id, username } => mori::bot_event::Event::BotAdded(mori::BotInfo {
            bot_id: *bot_id,
            username: username.clone(),
            ..Default::default()
        }),
        WsEvent::BotRemoved { bot_id } => {
            mori::bot_event::Event::BotRemoved(mori::BotRef { bot_id: *bot_id })
        }
        WsEvent::BotStatus { bot_id, status } => {
            mori::bot_event::Event::BotStatus(mori::BotStatusEvent {
                bot_id: *bot_id,
                status: status.clone(),
            })
        }
        WsEvent::BotWorld { bot_id, world_name } => {
            mori::bot_event::Event::BotWorld(mori::BotWorldEvent {
                bot_id: *bot_id,
                world_name: world_name.clone(),
            })
        }
        WsEvent::BotMove { bot_id, x, y } => mori::bot_event::Event::BotMove(mori::BotMoveEvent {
            bot_id: *bot_id,
            x: *x,
            y: *y,
        }),
        WsEvent::BotGems { bot_id, gems } => mori::bot_event::Event::BotGems(mori::BotGemsEvent {
            bot_id: *bot_id,
            gems: *gems,
        }),
        WsEvent::BotPing { bot_id, ping_ms } => {
            mori::bot_event::Event::BotPing(mori::BotPingEvent {
                bot_id: *bot_id,
                ping_ms: *ping_ms,
            })
        }
        WsEvent::PlayerSpawn {
            bot_id,
            net_id,
            name,
            country,
            x,
            y,
        } => mori::bot_event::Event::PlayerSpawn(mori::PlayerSpawnEvent {
            bot_id: *bot_id,
            net_id: *net_id,
            name: name.clone(),
            country: country.clone(),
            x: *x,
            y: *y,
        }),
        WsEvent::PlayerMove {
            bot_id,
            net_id,
            x,
            y,
        } => mori::bot_event::Event::PlayerMove(mori::PlayerMoveEvent {
            bot_id: *bot_id,
            net_id: *net_id,
            x: *x,
            y: *y,
        }),
        WsEvent::PlayerLeave { bot_id, net_id } => {
            mori::bot_event::Event::PlayerLeave(mori::PlayerLeaveEvent {
                bot_id: *bot_id,
                net_id: *net_id,
            })
        }
        WsEvent::WorldLoaded {
            bot_id,
            name,
            width,
            height,
            tiles,
        } => mori::bot_event::Event::WorldLoaded(mori::WorldLoadedEvent {
            bot_id: *bot_id,
            name: name.clone(),
            width: *width,
            height: *height,
            tiles: tiles.iter().map(|t| ws_tile_to_proto(*bot_id, t)).collect(),
        }),
        WsEvent::TileUpdate {
            bot_id,
            x,
            y,
            fg,
            bg,
        } => mori::bot_event::Event::TileUpdate(mori::TileUpdateEvent {
            bot_id: *bot_id,
            x: *x,
            y: *y,
            fg: *fg as u32,
            bg: *bg as u32,
        }),
        WsEvent::ObjectsUpdate { bot_id, objects } => {
            mori::bot_event::Event::ObjectsUpdate(mori::ObjectsUpdateEvent {
                bot_id: *bot_id,
                objects: objects.iter().map(ws_object_to_proto).collect(),
            })
        }
        WsEvent::InventoryUpdate {
            bot_id,
            gems,
            inventory_size,
            items,
        } => mori::bot_event::Event::InventoryUpdate(mori::InventoryUpdateEvent {
            bot_id: *bot_id,
            gems: *gems,
            inventory_size: *inventory_size,
            items: items.iter().map(ws_item_to_proto).collect(),
        }),
        WsEvent::Console { bot_id, message } => {
            mori::bot_event::Event::Console(mori::ConsoleEvent {
                bot_id: *bot_id,
                message: message.clone(),
            })
        }
        WsEvent::BotTrackInfo {
            bot_id,
            level,
            grow_id,
            install_date,
            global_playtime,
            awesomeness,
        } => mori::bot_event::Event::TrackInfo(mori::TrackInfoEvent {
            bot_id: *bot_id,
            level: *level,
            grow_id: *grow_id,
            install_date: *install_date,
            global_playtime: *global_playtime,
            awesomeness: *awesomeness,
        }),
        WsEvent::BotUsername { bot_id, username } => {
            mori::bot_event::Event::Username(mori::UsernameEvent {
                bot_id: *bot_id,
                username: username.clone(),
            })
        }
        WsEvent::BotAutoCollect { bot_id, enabled } => {
            mori::bot_event::Event::AutoCollect(mori::AutoCollectEvent {
                bot_id: *bot_id,
                enabled: *enabled,
            })
        }
        WsEvent::BotDelays {
            bot_id,
            place_ms,
            walk_ms,
            twofa_secs,
            server_overload_secs,
            too_many_logins_secs,
            maintenance_secs,
        } => mori::bot_event::Event::Delays(mori::DelaysEvent {
            bot_id: *bot_id,
            delays: Some(mori::BotDelays {
                place_ms: *place_ms,
                walk_ms: *walk_ms,
                twofa_secs: *twofa_secs,
                server_overload_secs: *server_overload_secs,
                too_many_logins_secs: *too_many_logins_secs,
                maintenance_secs: *maintenance_secs,
            }),
        }),
        WsEvent::BotProxy { bot_id, proxy_host, proxy_port, .. } => {
            // No dedicated proto event yet — surface as a console line.
            let target = match (proxy_host, proxy_port) {
                (Some(h), Some(p)) => format!("{h}:{p}"),
                _ => "direct".to_string(),
            };
            mori::bot_event::Event::Console(mori::ConsoleEvent {
                bot_id: *bot_id,
                message: format!("[Bot] Proxy updated — {target}"),
            })
        }
        WsEvent::Chat { bot_id, message, kind } => {
            mori::bot_event::Event::Console(mori::ConsoleEvent {
                bot_id: *bot_id,
                message: format!("[Chat {:?}] {message}", kind),
            })
        }
        WsEvent::DialogRequest { bot_id, dialog } => {
            mori::bot_event::Event::Console(mori::ConsoleEvent {
                bot_id: *bot_id,
                message: format!("[Dialog] {}", dialog.title),
            })
        }
        WsEvent::DialogClose { bot_id } => {
            mori::bot_event::Event::Console(mori::ConsoleEvent {
                bot_id: *bot_id,
                message: "[Dialog] Closed".into(),
            })
        }
    };
    mori::BotEvent { event: Some(event) }
}

// ── Service impl ───────────────────────────────────────────────────────────

#[tonic::async_trait]
impl Mori for MoriService {
    // ── Manager ──

    async fn spawn_bot(
        &self,
        req: Request<mori::SpawnBotRequest>,
    ) -> Result<Response<mori::SpawnBotResponse>, Status> {
        let r = req.into_inner();
        if r.username.is_empty() || r.password.is_empty() {
            return Err(Status::invalid_argument("username and password required"));
        }
        let proxy = r
            .proxy
            .as_ref()
            .filter(|_| r.has_proxy)
            .map(parse_proxy)
            .transpose()?;
        let id = self
            .manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?
            .spawn(r.username, r.password, proxy, None);
        Ok(Response::new(mori::SpawnBotResponse { bot_id: id }))
    }

    async fn spawn_ltoken_bot(
        &self,
        req: Request<mori::SpawnLtokenRequest>,
    ) -> Result<Response<mori::SpawnBotResponse>, Status> {
        let r = req.into_inner();
        if r.ltoken.is_empty() {
            return Err(Status::invalid_argument("ltoken required"));
        }
        let proxy = r
            .proxy
            .as_ref()
            .filter(|_| r.has_proxy)
            .map(parse_proxy)
            .transpose()?;
        let id = self
            .manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?
            .spawn_ltoken(r.ltoken, proxy);
        Ok(Response::new(mori::SpawnBotResponse { bot_id: id }))
    }

    async fn stop_bot(&self, req: Request<mori::BotRef>) -> Result<Response<mori::Empty>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let ok = self
            .manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?
            .stop(id, "gRPC StopBot");
        if ok {
            Ok(Response::new(mori::Empty {}))
        } else {
            Err(Status::not_found(format!("bot {id} not found")))
        }
    }

    async fn list_bots(
        &self,
        _req: Request<mori::Empty>,
    ) -> Result<Response<mori::ListBotsResponse>, Status> {
        let bots = self
            .manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?
            .list()
            .iter()
            .map(info_to_proto)
            .collect();
        Ok(Response::new(mori::ListBotsResponse { bots }))
    }

    async fn get_bot_state(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::BotState>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let username = self.bot_username(id);
        let s = self.bot_state(id)?;
        Ok(Response::new(state_to_proto(id, &username, &s)))
    }

    async fn get_config(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::BotConfig>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let s = self.bot_state(id)?;
        Ok(Response::new(config_to_proto(&s)))
    }

    // ── World actions ──

    async fn say(&self, req: Request<mori::SayRequest>) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Say { text: r.text })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn warp(&self, req: Request<mori::WarpRequest>) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::Warp {
                name: r.name,
                id: r.id,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn leave_world(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::Empty>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        self.send_cmd(id, BotCommand::LeaveWorld)?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn respawn(&self, req: Request<mori::BotRef>) -> Result<Response<mori::Empty>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        self.send_cmd(id, BotCommand::Respawn)?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn active(
        &self,
        req: Request<mori::TileActionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Active { x: r.x, y: r.y })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn enter(
        &self,
        req: Request<mori::EnterRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let pass = r.has_pass.then(|| r.pass.clone());
        self.send_cmd(id, BotCommand::Enter { pass })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn accept_access(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::Empty>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        self.send_cmd(id, BotCommand::AcceptAccess)?;
        Ok(Response::new(mori::Empty {}))
    }

    // ── Tile / inventory ──

    async fn place(
        &self,
        req: Request<mori::PlaceRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::Place {
                x: r.x,
                y: r.y,
                item: r.item_id,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn hit(
        &self,
        req: Request<mori::TileActionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Hit { x: r.x, y: r.y })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn wrench(
        &self,
        req: Request<mori::TileActionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Wrench { x: r.x, y: r.y })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn wrench_player(
        &self,
        req: Request<mori::WrenchPlayerRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::WrenchPlayer { net_id: r.net_id })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn wear(&self, req: Request<mori::ItemRequest>) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Wear { item_id: r.item_id })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn unwear(
        &self,
        req: Request<mori::ItemRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Unwear { item_id: r.item_id })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn drop(
        &self,
        req: Request<mori::InventoryActionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::Drop {
                item_id: r.item_id,
                count: r.count,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn trash(
        &self,
        req: Request<mori::InventoryActionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::Trash {
                item_id: r.item_id,
                count: r.count,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn fast_drop(
        &self,
        req: Request<mori::InventoryActionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::FastDrop {
                item_id: r.item_id,
                count: r.count,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn fast_trash(
        &self,
        req: Request<mori::InventoryActionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::FastTrash {
                item_id: r.item_id,
                count: r.count,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn buy(&self, req: Request<mori::BuyRequest>) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Buy { pack_id: r.pack_id })?;
        Ok(Response::new(mori::Empty {}))
    }

    // ── Movement ──

    async fn move_relative(
        &self,
        req: Request<mori::MoveRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::Move { x: r.x, y: r.y })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn move_to(
        &self,
        req: Request<mori::MoveToRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::MoveTo { x: r.x, y: r.y })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn walk_to(
        &self,
        req: Request<mori::MoveToRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        if r.x < 0 || r.y < 0 {
            return Err(Status::invalid_argument("coordinates must be non-negative"));
        }
        self.send_cmd(
            id,
            BotCommand::WalkTo {
                x: r.x as u32,
                y: r.y as u32,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_direction(
        &self,
        req: Request<mori::SetDirectionRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::SetDirection {
                facing_left: r.facing_left,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn find_path(
        &self,
        req: Request<mori::MoveToRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        if r.x < 0 || r.y < 0 {
            return Err(Status::invalid_argument("coordinates must be non-negative"));
        }
        self.send_cmd(
            id,
            BotCommand::FindPath {
                x: r.x as u32,
                y: r.y as u32,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn collect(
        &self,
        req: Request<mori::CollectRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::Collect {
                range: r.range,
                interval_ms: r.interval_ms,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn collect_object(
        &self,
        req: Request<mori::CollectObjectRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(
            id,
            BotCommand::CollectObject {
                oid: r.oid,
                range: r.range,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    // ── Connection / raw ──

    async fn reconnect(&self, req: Request<mori::BotRef>) -> Result<Response<mori::Empty>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        self.send_cmd(id, BotCommand::Reconnect)?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn disconnect(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::Empty>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        self.send_cmd(id, BotCommand::Disconnect)?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn send_packet(
        &self,
        req: Request<mori::SendPacketRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        if r.packet_type > u8::MAX as u32 {
            return Err(Status::invalid_argument("packet_type must fit in u8"));
        }
        self.send_cmd(
            id,
            BotCommand::SendPacket {
                ptype: r.packet_type as u8,
                text: r.text,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn send_raw(
        &self,
        req: Request<mori::SendRawRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let pkt = r.packet.as_ref().map(packet_from_proto).unwrap_or_default();
        self.send_cmd(id, BotCommand::SendRaw { pkt })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_mac(
        &self,
        req: Request<mori::SetMacRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetMac { mac: r.mac })?;
        Ok(Response::new(mori::Empty {}))
    }

    // ── Settings ──

    async fn set_auto_collect(
        &self,
        req: Request<mori::SetBoolRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetAutoCollect { enabled: r.enabled })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_ignore_gems(
        &self,
        req: Request<mori::SetBoolRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetIgnoreGems { enabled: r.enabled })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_ignore_essences(
        &self,
        req: Request<mori::SetBoolRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetIgnoreEssences { enabled: r.enabled })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_auto_leave_on_mod(
        &self,
        req: Request<mori::SetBoolRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetAutoLeaveOnMod { enabled: r.enabled })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_auto_ban(
        &self,
        req: Request<mori::SetBoolRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetAutoBan { enabled: r.enabled })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_collect_path_check(
        &self,
        req: Request<mori::SetBoolRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetCollectPathCheck { enabled: r.enabled })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_auto_reconnect(
        &self,
        req: Request<mori::SetBoolRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetAutoReconnect { enabled: r.enabled })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_collect_interval(
        &self,
        req: Request<mori::SetUintRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetCollectInterval { ms: r.value })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_collect_range(
        &self,
        req: Request<mori::SetUintRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        if r.value > u8::MAX as u64 {
            return Err(Status::invalid_argument("range must fit in u8"));
        }
        self.send_cmd(
            id,
            BotCommand::SetCollectRange {
                tiles: r.value as u8,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_reconnect_interval(
        &self,
        req: Request<mori::SetUintRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetReconnectInterval { ms: r.value })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_place_delay(
        &self,
        req: Request<mori::SetUintRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetPlaceDelay { ms: r.value })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_walk_delay(
        &self,
        req: Request<mori::SetUintRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::SetWalkDelay { ms: r.value })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_delays(
        &self,
        req: Request<mori::SetDelaysRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let d = r.delays.as_ref().map(delays_from_proto).unwrap_or_default();
        self.send_cmd(id, BotCommand::SetDelays(d))?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn set_collect_config(
        &self,
        req: Request<mori::SetCollectConfigRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        if r.radius_tiles > u8::MAX as u32 {
            return Err(Status::invalid_argument("radius_tiles must fit in u8"));
        }
        let blacklist = r
            .blacklist
            .into_iter()
            .map(|v| v.min(u16::MAX as u32) as u16)
            .collect();
        self.send_cmd(
            id,
            BotCommand::SetCollectConfig {
                radius_tiles: r.radius_tiles as u8,
                blacklist,
            },
        )?;
        Ok(Response::new(mori::Empty {}))
    }

    // ── Scripts ──

    async fn run_script(
        &self,
        req: Request<mori::RunScriptRequest>,
    ) -> Result<Response<mori::Empty>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        self.send_cmd(id, BotCommand::RunScript { content: r.content })?;
        Ok(Response::new(mori::Empty {}))
    }

    async fn stop_script(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::Empty>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        self.send_cmd(id, BotCommand::StopScript)?;
        Ok(Response::new(mori::Empty {}))
    }

    // ── Queries ──

    async fn get_world(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::WorldResponse>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let s = self.bot_state(id)?;
        if s.world_name.is_empty() {
            return Err(Status::not_found("bot is not in a world"));
        }
        Ok(Response::new(mori::WorldResponse {
            name: s.world_name.clone(),
            width: s.world_width,
            height: s.world_height,
            tiles: tiles_to_proto(&s),
            objects: s
                .objects
                .iter()
                .map(|o| mori::WorldObject {
                    uid: o.uid,
                    item_id: o.item_id as u32,
                    x: o.x,
                    y: o.y,
                    count: o.count as u32,
                })
                .collect(),
            players: s
                .players
                .iter()
                .map(|p| mori::PlayerInfo {
                    net_id: p.net_id,
                    name: p.name.clone(),
                    pos_x: p.pos_x,
                    pos_y: p.pos_y,
                    country: p.country.clone(),
                })
                .collect(),
        }))
    }

    async fn get_inventory(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::InventoryResponse>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let s = self.bot_state(id)?;
        Ok(Response::new(mori::InventoryResponse {
            size: s.inventory_size,
            gems: s.gems,
            items: s
                .inventory
                .iter()
                .map(|i| mori::InvSlot {
                    item_id: i.item_id as u32,
                    amount: i.amount as u32,
                    is_active: i.is_active,
                    action_type: i.action_type as u32,
                })
                .collect(),
        }))
    }

    async fn get_players(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::PlayersResponse>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let s = self.bot_state(id)?;
        Ok(Response::new(mori::PlayersResponse {
            players: s
                .players
                .iter()
                .map(|p| mori::PlayerInfo {
                    net_id: p.net_id,
                    name: p.name.clone(),
                    pos_x: p.pos_x,
                    pos_y: p.pos_y,
                    country: p.country.clone(),
                })
                .collect(),
        }))
    }

    async fn get_player(
        &self,
        req: Request<mori::GetPlayerRequest>,
    ) -> Result<Response<mori::PlayerInfo>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let s = self.bot_state(id)?;
        let found = match r.key {
            Some(mori::get_player_request::Key::NetId(net_id)) => {
                s.players.iter().find(|p| p.net_id == net_id)
            }
            Some(mori::get_player_request::Key::Name(name)) => s
                .players
                .iter()
                .find(|p| p.name.eq_ignore_ascii_case(&name)),
            None => None,
        };
        found
            .map(|p| {
                Response::new(mori::PlayerInfo {
                    net_id: p.net_id,
                    name: p.name.clone(),
                    pos_x: p.pos_x,
                    pos_y: p.pos_y,
                    country: p.country.clone(),
                })
            })
            .ok_or_else(|| Status::not_found("player not found"))
    }

    async fn get_tile(
        &self,
        req: Request<mori::GetTileRequest>,
    ) -> Result<Response<mori::TileInfo>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let s = self.bot_state(id)?;
        if s.world_width == 0 || r.x >= s.world_width || r.y >= s.world_height {
            return Err(Status::not_found("tile out of bounds or no world loaded"));
        }
        let idx = (r.y * s.world_width + r.x) as usize;
        s.tiles
            .get(idx)
            .map(|t| {
                Response::new(mori::TileInfo {
                    x: r.x,
                    y: r.y,
                    fg_item_id: t.fg_item_id as u32,
                    bg_item_id: t.bg_item_id as u32,
                    flags: t.flags as u32,
                    tile_type: format!("{:?}", t.tile_type),
                })
            })
            .ok_or_else(|| Status::not_found("tile not found"))
    }

    async fn get_object(
        &self,
        req: Request<mori::GetObjectRequest>,
    ) -> Result<Response<mori::WorldObject>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let s = self.bot_state(id)?;
        s.objects
            .iter()
            .find(|o| o.uid == r.oid)
            .map(|o| {
                Response::new(mori::WorldObject {
                    uid: o.uid,
                    item_id: o.item_id as u32,
                    x: o.x,
                    y: o.y,
                    count: o.count as u32,
                })
            })
            .ok_or_else(|| Status::not_found("object not found"))
    }

    async fn get_item_info(
        &self,
        req: Request<mori::GetItemInfoRequest>,
    ) -> Result<Response<mori::ItemInfo>, Status> {
        let key = req
            .into_inner()
            .key
            .ok_or_else(|| Status::invalid_argument("id or name required"))?;
        let mgr = self
            .manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?;
        let found = match &key {
            mori::get_item_info_request::Key::Id(id) => mgr.items_dat.find_by_id(*id).cloned(),
            mori::get_item_info_request::Key::Name(name) => {
                if let Ok(id) = name.parse::<u32>() {
                    mgr.items_dat.find_by_id(id).cloned()
                } else {
                    mgr.items_dat.find_by_name(name).cloned()
                }
            }
        };
        found
            .map(|i| Response::new(item_to_proto(&i)))
            .ok_or_else(|| Status::not_found("item not found"))
    }

    async fn list_items(
        &self,
        req: Request<mori::ListItemsRequest>,
    ) -> Result<Response<mori::ListItemsResponse>, Status> {
        let r = req.into_inner();
        let page = r.page.max(1);
        let page_size = r.page_size.clamp(1, 200);
        let q = r.query.to_lowercase();
        let mgr = self
            .manager
            .lock()
            .map_err(|_| Status::internal("manager lock poisoned"))?;
        let filtered: Vec<&ItemInfo> = mgr
            .items_dat
            .items
            .iter()
            .filter(|i| {
                if q.is_empty() {
                    return true;
                }
                if let Ok(id) = q.parse::<u32>()
                    && i.id == id
                {
                    return true;
                }
                i.name.to_lowercase().contains(&q)
            })
            .collect();
        let total = filtered.len() as u64;
        let start = ((page - 1) * page_size) as usize;
        let items = filtered
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .map(item_to_proto)
            .collect();
        Ok(Response::new(mori::ListItemsResponse {
            items,
            total,
            page,
            page_size,
        }))
    }

    async fn get_local(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::LocalPlayer>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let username = self.bot_username(id);
        let s = self.bot_state(id)?;
        Ok(Response::new(mori::LocalPlayer {
            net_id: 0,
            username: if s.username.is_empty() {
                username
            } else {
                s.username.clone()
            },
            pos_x: s.pos_x,
            pos_y: s.pos_y,
            mac: s.mac.clone(),
        }))
    }

    async fn get_ping(
        &self,
        req: Request<mori::BotRef>,
    ) -> Result<Response<mori::PingResponse>, Status> {
        let id = bot_ref(&Some(req.into_inner()))?;
        let s = self.bot_state(id)?;
        Ok(Response::new(mori::PingResponse { ping_ms: s.ping_ms }))
    }

    async fn is_in_world(
        &self,
        req: Request<mori::IsInWorldRequest>,
    ) -> Result<Response<mori::BoolResponse>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let s = self.bot_state(id)?;
        let value = match r.has_name {
            true => s.world_name.to_uppercase() == r.name.to_uppercase(),
            false => !s.world_name.is_empty(),
        };
        Ok(Response::new(mori::BoolResponse { value }))
    }

    async fn is_in_tile(
        &self,
        req: Request<mori::IsInTileRequest>,
    ) -> Result<Response<mori::BoolResponse>, Status> {
        let r = req.into_inner();
        let id = bot_ref(&r.bot)?;
        let s = self.bot_state(id)?;
        Ok(Response::new(mori::BoolResponse {
            value: s.pos_x as u32 == r.x && s.pos_y as u32 == r.y,
        }))
    }

    type SubscribeEventsStream = ReceiverStream<Result<mori::BotEvent, Status>>;

    async fn subscribe_events(
        &self,
        req: Request<mori::SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeEventsStream>, Status> {
        let filter = req.into_inner().bot_ids;
        let mut rx = self.ws_tx.subscribe();
        let (tx, rx_out) = tokio::sync::mpsc::channel(256);
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if !filter.is_empty() && !filter.contains(&event_bot_id(&ev)) {
                            continue;
                        }
                        if tx.send(Ok(event_to_proto(&ev))).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        Ok(Response::new(ReceiverStream::new(rx_out)))
    }
}
