//! Local WebSocket relay between the Ottoman Chrome extension and the app window.
//! The extension connects to `/ext` and the app window to `/app`; text frames are passed through both ways.
//! Only the extension's own origin and the app (holding a per-run secret token) are accepted, so a web page
//! cannot connect and drive the browser.

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
    Message,
};

pub const PORT: u16 = 47801;
/// Fixed by the `key` in extension/manifest.json.
pub const EXTENSION_ORIGIN: &str = "chrome-extension://cijhjpoiomfnkhhbingkcaakgdenemkc";

type Tx = mpsc::UnboundedSender<String>;

#[derive(Default)]
struct Peers {
    ext: Option<(u64, Tx)>,
    app: Option<(u64, Tx)>,
}

pub struct Relay {
    pub token: String,
    peers: Mutex<Peers>,
}

impl Relay {
    /// Id of the connected extension, which changes when another extension instance (e.g. another profile) connects.
    pub fn extension_id(&self) -> Option<u64> {
        self.peers.lock().unwrap().ext.as_ref().map(|(id, _)| *id)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Side {
    Ext,
    App,
}

fn reject(code: StatusCode) -> ErrorResponse {
    let mut r = ErrorResponse::new(None);
    *r.status_mut() = code;
    r
}

pub fn start(token: String) -> Arc<Relay> {
    let relay = Arc::new(Relay { token, peers: Mutex::default() });
    let r = relay.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(l) => l,
            Err(e) => return eprintln!("Ottoman relay: cannot listen on {PORT}: {e}"),
        };
        let mut next_id = 0u64;
        while let Ok((stream, _)) = listener.accept().await {
            next_id += 1;
            tauri::async_runtime::spawn(serve(r.clone(), stream, next_id));
        }
    });
    relay
}

async fn serve(relay: Arc<Relay>, stream: tokio::net::TcpStream, id: u64) {
    let mut side = None;
    let token = relay.token.clone();
    let check = |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
        match req.uri().path() {
            "/ext" if origin == EXTENSION_ORIGIN => side = Some(Side::Ext),
            "/app" if req.uri().query() == Some(&format!("token={token}")) => side = Some(Side::App),
            _ => return Err(reject(StatusCode::FORBIDDEN)),
        }
        Ok(res)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, check).await else { return };
    let Some(side) = side else { return };

    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut peers = relay.peers.lock().unwrap();
        // A new extension (e.g. another profile, or the service worker restarting) replaces the old one; the app
        // connection is dropped too so the app reconnects with fresh tab state.
        if side == Side::Ext {
            peers.ext = Some((id, tx));
            peers.app = None;
        } else {
            peers.app = Some((id, tx));
        }
    }
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    while let Some(Ok(msg)) = source.next().await {
        let Message::Text(text) = msg else { continue };
        let peers = relay.peers.lock().unwrap();
        let other = if side == Side::Ext { &peers.app } else { &peers.ext };
        if let Some((_, tx)) = other {
            let _ = tx.send(text.to_string());
        }
    }
    {
        let mut peers = relay.peers.lock().unwrap();
        let slot = if side == Side::Ext { &mut peers.ext } else { &mut peers.app };
        // Only the current peer clears its slot; a replaced extension closing late must not cut off the app,
        // which by now talks to the newer extension.
        if slot.as_ref().map(|(i, _)| *i) == Some(id) {
            *slot = None;
            if side == Side::Ext {
                peers.app = None; // the app's tab state belonged to this extension
            }
        }
    }
    writer.abort();
}
