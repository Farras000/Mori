pub mod mori {
    tonic::include_proto!("mori.v1");
}

mod service;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use mori::mori_server::MoriServer;

use crate::bot_manager::BotManager;
use crate::events::WsTx;

use self::service::MoriService;

pub type SharedManager = Arc<Mutex<BotManager>>;

pub async fn serve(manager: SharedManager, ws_tx: WsTx) {
    let addr: SocketAddr = std::env::var("MORI_GRPC_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:50051".to_string())
        .parse()
        .expect("invalid MORI_GRPC_ADDR");

    let svc = MoriService::new(manager, ws_tx);

    match std::env::var("MORI_GRPC_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(token) => {
            let expected = Arc::new(format!("Bearer {token}"));
            println!("[gRPC] Listening on {addr} (auth enabled)");
            tonic::transport::Server::builder()
                .add_service(MoriServer::with_interceptor(
                    svc,
                    move |req: tonic::Request<()>| {
                        let ok = req
                            .metadata()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            == Some(expected.as_str());
                        if ok {
                            Ok(req)
                        } else {
                            Err(tonic::Status::unauthenticated("invalid or missing token"))
                        }
                    },
                ))
                .serve(addr)
                .await
                .expect("gRPC server failed");
        }
        None => {
            println!("[gRPC] Listening on {addr} (WARN: MORI_GRPC_TOKEN unset — unauthenticated)");
            tonic::transport::Server::builder()
                .add_service(MoriServer::new(svc))
                .serve(addr)
                .await
                .expect("gRPC server failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::mori::mori_client::MoriClient;
    use super::mori::{
        BotRef, Empty, GetItemInfoRequest, ListItemsRequest, SayRequest, SendPacketRequest,
        SubscribeRequest, get_item_info_request,
    };
    use super::serve;
    use crate::bot_manager::BotManager;

    fn free_addr() -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap().to_string();
        drop(l);
        a
    }

    async fn wait_client(addr: &str) -> MoriClient<tonic::transport::Channel> {
        let url = format!("http://{addr}");
        for _ in 0..100 {
            if let Ok(c) = MoriClient::connect(url.clone()).await {
                return c;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("gRPC server on {addr} never came up");
    }

    #[tokio::test]
    async fn grpc_smoke() {
        // ── Server without token ─────────────────────────────────────────
        unsafe {
            std::env::remove_var("MORI_GRPC_TOKEN");
        }
        let addr = free_addr();
        unsafe {
            std::env::set_var("MORI_GRPC_ADDR", &addr);
        }
        let (ws_tx, _) = tokio::sync::broadcast::channel(16);
        let mgr = Arc::new(Mutex::new(BotManager::new(ws_tx.clone())));
        let srv = tokio::spawn(serve(mgr, ws_tx));
        let mut client = wait_client(&addr).await;

        // Empty manager.
        let bots = client.list_bots(Empty {}).await.unwrap().into_inner();
        assert!(bots.bots.is_empty());

        // Unknown bot → NotFound.
        let err = client
            .get_bot_state(BotRef { bot_id: 999 })
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::NotFound);

        // Missing bot ref → InvalidArgument.
        let err = client
            .say(SayRequest {
                bot: None,
                text: "hi".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);

        // items.dat queries (repo root ships items.dat).
        let info = client
            .get_item_info(GetItemInfoRequest {
                key: Some(get_item_info_request::Key::Id(242)),
            })
            .await
            .unwrap()
            .into_inner();
        assert_eq!(info.name.to_lowercase(), "world lock");

        let list = client
            .list_items(ListItemsRequest {
                query: "world lock".into(),
                page: 1,
                page_size: 10,
            })
            .await
            .unwrap()
            .into_inner();
        assert!(list.total >= 1);
        assert!(list.items.iter().any(|i| i.id == 242));

        let err = client
            .get_item_info(GetItemInfoRequest {
                key: Some(get_item_info_request::Key::Id(9_999_999)),
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::NotFound);

        // Raw packet type out of u8 range → InvalidArgument.
        let err = client
            .send_packet(SendPacketRequest {
                bot: Some(BotRef { bot_id: 1 }),
                packet_type: 999,
                text: "x".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);

        // Event stream opens and is cancellable.
        let mut stream = client
            .subscribe_events(SubscribeRequest { bot_ids: vec![] })
            .await
            .unwrap()
            .into_inner();
        tokio::select! {
            _ = stream.message() => {},
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {},
        }
        drop(stream);
        srv.abort();

        // ── Server with token ────────────────────────────────────────────
        unsafe {
            std::env::set_var("MORI_GRPC_TOKEN", "smoke-token");
        }
        let addr2 = free_addr();
        unsafe {
            std::env::set_var("MORI_GRPC_ADDR", &addr2);
        }
        let (ws_tx2, _) = tokio::sync::broadcast::channel(16);
        let mgr2 = Arc::new(Mutex::new(BotManager::new(ws_tx2.clone())));
        let srv2 = tokio::spawn(serve(mgr2, ws_tx2));
        let mut authed = wait_client(&addr2).await;

        // No metadata → Unauthenticated.
        let err = authed.list_bots(Empty {}).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);

        // Wrong token → Unauthenticated.
        let mut req = tonic::Request::new(Empty {});
        req.metadata_mut()
            .insert("authorization", "Bearer wrong".parse().unwrap());
        let err = authed.list_bots(req).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::Unauthenticated);

        // Right token → OK.
        let mut req = tonic::Request::new(Empty {});
        req.metadata_mut()
            .insert("authorization", "Bearer smoke-token".parse().unwrap());
        let bots = authed.list_bots(req).await.unwrap().into_inner();
        assert!(bots.bots.is_empty());

        srv2.abort();
        unsafe {
            std::env::remove_var("MORI_GRPC_TOKEN");
        }
        unsafe {
            std::env::remove_var("MORI_GRPC_ADDR");
        }
    }
}
