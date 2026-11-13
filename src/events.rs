use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DialogField {
    pub name: String,
    pub label: String,
    pub default_val: String,
    pub max_len: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DialogCheckbox {
    pub name: String,
    pub label: String,
    pub checked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DialogEmbed {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DialogButton {
    pub name: String,
    pub label: String,
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DialogElement {
    Label {
        text: String,
        size: String,
        item_id: Option<u32>,
        align: String,
    },
    Textbox {
        text: String,
        small: bool,
    },
    TextInput {
        name: String,
        label: String,
        default_val: String,
        max_len: u32,
        is_password: bool,
    },
    Checkbox {
        name: String,
        label: String,
        checked: bool,
    },
    Button {
        name: String,
        label: String,
        url: Option<String>,
        item_id: Option<u32>,
        frame: Option<String>,
        flags: Option<String>,
    },
    ItemPicker {
        name: String,
        label: String,
        title: String,
        default_item_id: u32,
    },
    Spacer {
        size: String,
    },
    PlayerInfo {
        player_name: String,
        level: String,
        xp: String,
        raw_parts: Vec<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct WsDialog {
    pub dialog_name: String,
    pub raw: String,
    pub title: String,
    pub body_text: Vec<String>,
    pub inputs: Vec<DialogField>,
    pub buttons: Vec<DialogButton>,
    pub confirm_label: String,
    pub cancel_label: String,
    #[serde(default)]
    pub checkboxes: Vec<DialogCheckbox>,
    #[serde(default)]
    pub embed_data: Vec<DialogEmbed>,
    #[serde(default)]
    pub elements: Vec<DialogElement>,
    #[serde(default)]
    pub quick_exit: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct TradeSlot {
    pub item_id: u32,
    pub count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct TradeState {
    pub partner_net_id: u32,
    pub partner_name: String,
    pub self_slots: Vec<TradeSlot>,
    pub partner_slots: Vec<TradeSlot>,
    pub self_locked: bool,
    pub partner_locked: bool,
    pub self_accepted: bool,
    pub partner_accepted: bool,
    pub status_text: String,
}

use crate::world::TileType;

#[derive(Serialize, Clone, Debug)]
pub struct WsTile {
    pub fg:        u16,
    pub bg:        u16,
    pub flags:     u16,
    pub tile_type: TileType,
}

#[derive(Serialize, Clone, Debug)]
pub struct WsObject {
    pub uid:     u32,
    pub item_id: u16,
    pub x:       f32,
    pub y:       f32,
    pub count:   u8,
}

#[derive(Serialize, Clone, Debug)]
pub struct WsInvItem {
    pub item_id:     u16,
    pub amount:      u8,
    pub is_active:   bool,
    pub action_type: u8,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "event", content = "data")]
pub enum WsEvent {
    /// A new bot was spawned.
    BotAdded { bot_id: u32, username: String },
    /// A bot was stopped/removed.
    BotRemoved { bot_id: u32 },
    /// Bot connection status changed.
    BotStatus { bot_id: u32, status: String },
    /// Bot entered or left a world (world_name is empty when leaving).
    BotWorld { bot_id: u32, world_name: String },
    /// Bot position updated (tile coordinates). `on_ground` lets the renderer plant feet immediately on impact.
    BotMove {
        bot_id: u32,
        x: f32,
        y: f32,
        #[serde(skip_serializing_if = "Option::is_none")]
        on_ground: Option<bool>,
    },
    /// Bot gems balance updated.
    BotGems { bot_id: u32, gems: i32 },
    /// Bot ping updated (emitted when value changes).
    BotPing { bot_id: u32, ping_ms: u32 },
    /// A player appeared in the bot's world.
    PlayerSpawn {
        bot_id: u32,
        net_id: u32,
        name: String,
        country: String,
        x: f32,
        y: f32,
        #[serde(default)]
        clothes: [u32; 9],
        #[serde(default)]
        m_state: u32,
        #[serde(default)]
        sm_state: u32,
    },
    /// A player moved.
    PlayerMove { bot_id: u32, net_id: u32, x: f32, y: f32 },
    /// A player left the bot's world.
    PlayerLeave { bot_id: u32, net_id: u32 },
    /// Remote player clothing updated via OnSetClothing.
    PlayerClothes { bot_id: u32, net_id: u32, clothes: [u32; 9] },
    /// Local bot clothing updated via OnSetClothing.
    BotClothes { bot_id: u32, clothes: [u32; 9] },
    /// Full world data (sent once on world load).
    WorldLoaded {
        bot_id: u32,
        name: String,
        width: u32,
        height: u32,
        #[serde(default)]
        base_weather: u16,
        #[serde(default)]
        current_weather: u16,
        tiles: Vec<WsTile>,
    },
    /// World active weather changed via OnSetCurrentWeather.
    WeatherUpdate { bot_id: u32, weather: u16 },
    /// A single tile was updated.
    TileUpdate {
        bot_id: u32,
        x: u32,
        y: u32,
        fg: u16,
        bg: u16,
        #[serde(default)]
        flags: u16,
        tile_type: TileType,
    },
    /// The full set of dropped world objects changed.
    ObjectsUpdate { bot_id: u32, objects: Vec<WsObject> },
    /// Bot inventory updated.
    InventoryUpdate { bot_id: u32, gems: i32, inventory_size: u32, items: Vec<WsInvItem> },
    /// A new console message arrived.
    Console { bot_id: u32, message: String },
    /// A chat / game message arrived from the server or sent by the bot.
    Chat { bot_id: u32, message: String, kind: ChatKind },
    /// Overhead speech bubble triggered via OnTalkBubble.
    TalkBubble { bot_id: u32, net_id: u32, text: String, bubble_type: u8 },
    /// Server requested audio SFX playback (`action|play_sfx`).
    PlaySfx { bot_id: u32, file: String, delay_ms: u32 },
    /// Player-to-player trade session started (`OnStartTrade`).
    TradeStart { bot_id: u32, partner_net_id: u32, partner_name: String },
    /// Trade window state/slots updated (`OnTradeStatus`).
    TradeStatus { bot_id: u32, trade: TradeState },
    /// Trade session closed (`OnForceTradeEnd`).
    TradeEnd { bot_id: u32, reason: String },
    /// Account info extracted from the Track packet (sent once per login).
    BotTrackInfo { bot_id: u32, level: u32, grow_id: u64, install_date: u64, global_playtime: u64, awesomeness: u32 },
    /// GrowID resolved from SetHasGrowID (useful when logged in via ltoken).
    BotUsername { bot_id: u32, username: String },
    /// Bot auto-collect toggled.
    BotAutoCollect { bot_id: u32, enabled: bool },
    /// Bot delays updated.
    BotDelays { bot_id: u32, place_ms: u64, place_max_ms: Option<u64>, walk_ms: u64, walk_max_ms: Option<u64>, twofa_secs: u64, server_overload_secs: u64, too_many_logins_secs: u64, maintenance_secs: u64 },
    /// Bot SOCKS5 proxy updated (`proxy_host` is `None` = direct connection).
    BotProxy { bot_id: u32, proxy_host: Option<String>, proxy_port: Option<u16>, proxy_username: Option<String>, proxy_password: Option<String> },
    /// Quick dialog / Captcha requested by game server.
    DialogRequest { bot_id: u32, dialog: WsDialog },
    /// Active dialog closed or answered.
    DialogClose { bot_id: u32 },
    /// World select menu received with sections/worlds.
    WorldMenu { bot_id: u32, sections: Vec<crate::bot_state::WorldMenuSection> },
    /// Character physics modifiers updated (wings double jump, jetpack, slow fall, malady).
    BotPhysicsMods { bot_id: u32, mods: crate::physics::CharacterModifiers },
    /// Tile crack/damage progress updated (from punch / tile damage tracking).
    TileDamage { bot_id: u32, x: u32, y: u32, damage: u16, max_health: u16 },
}

/// Direction of a chat message.
#[derive(Serialize, Clone, Debug)]
pub enum ChatKind {
    /// Message sent by the bot (outgoing).
    Outgoing,
    /// Message received from the game server / other players (incoming).
    Incoming,
}

pub type WsTx = tokio::sync::broadcast::Sender<WsEvent>;
