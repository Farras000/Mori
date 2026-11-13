mod astar;
mod auth;
mod bot;
mod bot_store;
mod constants;
mod cursor;
mod google_oauth;
mod local_browser;
mod inventory;
pub mod events;
mod bot_state;
mod bot_manager;
mod dashboard;
pub mod grpc;
pub mod items;
mod login;
mod lua;
mod oauth_session;
mod player;
mod protocol;
mod proxy_test;
mod settings;
pub mod save_dat;
mod remote_view;
mod server_data;
mod socks5;
mod sysbrowser;
pub mod world;
mod web;
pub mod script_channel;
pub mod vsproxy;
pub mod physics;


use std::sync::{Arc, Mutex};
use bot_manager::BotManager;

#[tokio::main]
async fn main() {
    let (ws_tx, _) = tokio::sync::broadcast::channel(2048);
    let mgr = Arc::new(Mutex::new(BotManager::new(ws_tx.clone())));
    // Bring back the bots that were flagged for auto-start, with the settings
    // they had before the restart (data/bots.json). Bots without their own
    // proxy fall back to the general proxy (data/settings.json).
    let boot_fallback = crate::settings::AppSettings::load().general_proxy_config();
    mgr.lock().unwrap().restore_saved(boot_fallback);
    let grpc_handle = tokio::spawn(grpc::serve(mgr.clone(), ws_tx.clone()));
    tokio::select! {
        _ = web::serve(mgr, ws_tx) => {},
        r = grpc_handle => {
            if let Err(e) = r {
                eprintln!("[gRPC] server task failed: {e}");
            }
        }
    }
}
