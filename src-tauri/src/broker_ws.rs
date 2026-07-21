// ABOUTME: Multiplexes authenticated WebSocket clients to Pi upstreams and host controls.
// ABOUTME: Enforces owner-scoped ephemeral routing, bounded replay, and command policy.

use crate::command_policy::{classify_core_command, EphemeralPermission};
use crate::window_owner::{OwnerId, WindowOwnerRegistry};
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const PROTOCOL_VERSION: u8 = 1;
/// A client must send its first `client_hello` within this window or be closed.
const AUTH_TIMEOUT_SECS: u64 = 5;
pub const EPHEMERAL_JOURNAL_MAX_EVENTS: usize = 512;
const EPHEMERAL_JOURNAL_MAX_BYTES: usize = 2 * 1024 * 1024;

type Tx = mpsc::UnboundedSender<String>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientClass {
    Native,
    Remote,
}

/// Broker-created, per-connection authorization context. Host control handlers
/// and ephemeral routing derive owner/class from this, never from request fields.
#[derive(Clone, Debug)]
pub struct VerifiedClientContext {
    #[allow(dead_code)]
    pub client_id: u64,
    pub class: ClientClass,
    pub owner_id: Option<OwnerId>,
}

/// Emits an intermediate progress frame for an in-flight `broker_control`
/// request (e.g. updater download chunks). The broker wires this to the
/// requesting client's socket, tagged with the original `requestId`.
pub type ProgressSink = Arc<dyn Fn(Value) + Send + Sync>;

/// Async handler for `broker_control` requests. Given the verified client
/// context, a command name + args (+ a progress sink for streaming ops) it
/// resolves to `Ok(result_json)` or `Err(message)`. Injected from main.rs so
/// the broker can run process/window lifecycle and native ops on behalf of any
/// authenticated client without main.rs and broker_ws forming a circular
/// dependency. Native-only controls enforce class/owner in the host handler.
pub type ControlHandler = Arc<
    dyn Fn(
            VerifiedClientContext,
            String,
            Value,
            ProgressSink,
        ) -> BoxFuture<'static, Result<Value, String>>
        + Send
        + Sync,
>;

/// One registered ephemeral upstream route, owned by the host (Task 7a).
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct EphemeralRoute {
    pub owner_id: OwnerId,
    pub instance_id: String,
    pub generation: u64,
    pub port: u16,
}

type EphemeralRouteKey = (OwnerId, String, u64);
type EphemeralDescriptorProvider = Arc<dyn Fn(&OwnerId) -> Value + Send + Sync>;

struct JournalEntry {
    sequence: u64,
    frame: Value,
    bytes: usize,
}

#[derive(Default)]
struct EphemeralJournal {
    entries: VecDeque<JournalEntry>,
    bytes: usize,
}

/// Outcome of classifying a `client_hello` frame against the owner registry.
enum HelloOutcome {
    /// Presented a valid capability bound to this owner.
    Native(OwnerId),
    /// No capability: a remote (LAN/mobile) mirror client.
    Remote,
    /// Malformed or unrecognized hello; the socket must close without downgrading.
    Reject,
}

struct UiClient {
    tx: Tx,
    class: ClientClass,
    owner_id: Option<OwnerId>,
    authed: bool,
}

#[derive(Default)]
struct BrokerInner {
    ui_clients: Mutex<HashMap<u64, UiClient>>,
    /// Current authenticated native client id per owner; reload/reconnect supersedes.
    owner_to_client: Mutex<HashMap<OwnerId, u64>>,
    /// (owner, instance id, generation) -> upstream port. Authoritative route table.
    ephemeral_routes: Mutex<HashMap<EphemeralRouteKey, u16>>,
    ephemeral_journals: Mutex<HashMap<EphemeralRouteKey, EphemeralJournal>>,
    ephemeral_descriptor_provider: Mutex<Option<EphemeralDescriptorProvider>>,
    upstreams: Mutex<HashMap<u16, Tx>>,
    routes: Mutex<HashMap<String, u16>>,
    disabled_ports: Mutex<HashSet<u16>>,
    active_port: Mutex<Option<u16>>,
    next_client_id: AtomicU64,
    control_handler: Mutex<Option<ControlHandler>>,
    owner_registry: Mutex<Option<Arc<WindowOwnerRegistry>>>,
}

#[derive(Clone)]
pub struct BrokerWs {
    port: u16,
    inner: Arc<BrokerInner>,
}

impl BrokerWs {
    pub fn start() -> Result<Self, String> {
        let std_listener = std::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|e| format!("Failed to bind broker websocket: {}", e))?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to configure broker websocket: {}", e))?;
        let port = std_listener
            .local_addr()
            .map_err(|e| format!("Failed to read broker websocket address: {}", e))?
            .port();
        let broker = Self {
            port,
            inner: Arc::new(BrokerInner::default()),
        };
        let server = broker.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(std_listener) {
                Ok(listener) => listener,
                Err(err) => {
                    log::error!("[broker-ws] failed to create Tokio listener: {}", err);
                    return;
                }
            };
            server.run(listener).await;
        });
        Ok(broker)
    }

    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}/ui-ws", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn set_active_port(&self, port: u16) {
        *self.inner.active_port.lock().unwrap() = Some(port);
    }

    pub fn active_port(&self) -> Option<u16> {
        *self.inner.active_port.lock().unwrap()
    }

    /// Number of pi upstream connections the broker is currently maintaining.
    /// Used to detect when a global `active_port` fallback would be ambiguous:
    /// with more than one live pi process (multi-window / multi-workspace) the
    /// active_port belongs to whichever window registered most recently, so it
    /// cannot be safely used to guess the target of an unaddressed command.
    pub fn live_upstream_count(&self) -> usize {
        self.inner.upstreams.lock().unwrap().len()
    }

    /// Install the handler used to execute `broker_control` requests. Called
    /// once from main.rs after PiManager + BrokerWs exist.
    pub fn set_control_handler(&self, handler: ControlHandler) {
        *self.inner.control_handler.lock().unwrap() = Some(handler);
    }

    /// Install the window-owner registry used to authenticate `client_hello`
    /// capabilities. Called once from main.rs after both the broker and the
    /// registry exist.
    pub fn set_owner_registry(&self, registry: Arc<WindowOwnerRegistry>) {
        *self.inner.owner_registry.lock().unwrap() = Some(registry);
    }

    /// Provide redacted owner-scoped descriptors for the native reconnect bootstrap.
    pub fn set_ephemeral_descriptor_provider(&self, provider: EphemeralDescriptorProvider) {
        *self.inner.ephemeral_descriptor_provider.lock().unwrap() = Some(provider);
    }

    /// Resolve an owner-scoped ephemeral route without accepting route hints from a client.
    pub fn ephemeral_port(
        &self,
        owner: &OwnerId,
        instance_id: &str,
        generation: u64,
    ) -> Option<u16> {
        self.inner
            .ephemeral_routes
            .lock()
            .unwrap()
            .get(&(owner.clone(), instance_id.to_string(), generation))
            .copied()
    }

    /// Publish an extension UI request emitted by Pi's RPC stdout. Normal
    /// events still come from the embedded server WebSocket; this path exists
    /// because Pi's RPC host owns extension UI response resolution.
    pub fn publish_rpc_output(&self, port: u16, payload: Value) {
        if payload.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
            return;
        }
        let framed = json!({ "type": "event", "event": payload }).to_string();
        if let Some(message) = self.wrap_upstream_message(port, &framed) {
            self.broadcast(&message);
        }
    }

    /// Register an ephemeral upstream route owned by the host (Task 7a). The
    /// broker never accepts route registrations from a client payload.
    #[allow(dead_code)]
    pub fn register_ephemeral_route(&self, route: EphemeralRoute) -> Result<(), String> {
        self.inner
            .disabled_ports
            .lock()
            .unwrap()
            .remove(&route.port);
        let mut routes = self.inner.ephemeral_routes.lock().unwrap();
        let key = (route.owner_id, route.instance_id, route.generation);
        routes.insert(key.clone(), route.port);
        self.inner
            .ephemeral_journals
            .lock()
            .unwrap()
            .entry(key)
            .or_default();
        Ok(())
    }

    /// Remove an ephemeral route only when owner, instance, generation, and port
    /// all still match, so a stale cleanup cannot unregister a newer route.
    #[allow(dead_code)]
    pub fn unregister_ephemeral_route(
        &self,
        owner: &OwnerId,
        id: &str,
        generation: u64,
        port: u16,
    ) {
        let removed = {
            let mut routes = self.inner.ephemeral_routes.lock().unwrap();
            let key = (owner.clone(), id.to_string(), generation);
            match routes.get(&key) {
                Some(&registered) if registered == port => {
                    routes.remove(&key);
                    self.inner.ephemeral_journals.lock().unwrap().remove(&key);
                    true
                }
                _ => false,
            }
        };
        // A dedicated ephemeral process owns this port. Disable its upstream
        // before the host terminates the child so `run_upstream` never retries
        // a deliberately closed listener.
        if removed {
            self.unregister_port(port);
        }
    }

    fn record_ephemeral_frame(&self, key: &EphemeralRouteKey, frame: Value) {
        let Some(sequence) = frame.get("runtimeSequence").and_then(Value::as_u64) else {
            return;
        };
        let bytes = frame.to_string().len();
        let mut journals = self.inner.ephemeral_journals.lock().unwrap();
        let journal = journals.entry(key.clone()).or_default();
        journal.entries.push_back(JournalEntry {
            sequence,
            frame,
            bytes,
        });
        journal.bytes += bytes;
        while journal.entries.len() > EPHEMERAL_JOURNAL_MAX_EVENTS
            || journal.bytes > EPHEMERAL_JOURNAL_MAX_BYTES
        {
            let Some(oldest) = journal.entries.pop_front() else {
                break;
            };
            journal.bytes = journal.bytes.saturating_sub(oldest.bytes);
        }
    }

    fn replay_ephemeral_events(&self, key: &EphemeralRouteKey, watermark: u64) -> Vec<Value> {
        self.inner
            .ephemeral_journals
            .lock()
            .unwrap()
            .get(key)
            .map(|journal| {
                journal
                    .entries
                    .iter()
                    .filter(|entry| entry.sequence > watermark)
                    .map(|entry| entry.frame.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Deliver an event only to the current authenticated client for this owner.
    /// Remote clients and other owners never receive ephemeral existence frames.
    /// Returns true when delivered.
    pub fn send_owner_event(&self, owner: &OwnerId, value: Value) -> bool {
        let message = value.to_string();
        let client_id = self
            .inner
            .owner_to_client
            .lock()
            .unwrap()
            .get(owner)
            .copied();
        let Some(id) = client_id else {
            return false;
        };
        let delivered = {
            let clients = self.inner.ui_clients.lock().unwrap();
            clients
                .get(&id)
                .filter(|c| c.authed && c.owner_id.as_ref() == Some(owner))
                .and_then(|c| c.tx.send(message).ok())
                .is_some()
        };
        delivered
    }

    /// Classify a `client_hello` frame. A valid capability authenticates as the
    /// bound owner; absence of a capability is a remote client; an invalid or
    /// malformed hello is rejected and must never downgrade to remote.
    fn classify_hello(&self, text: &str) -> HelloOutcome {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return HelloOutcome::Reject;
        };
        if value.get("type").and_then(Value::as_str) != Some("client_hello") {
            return HelloOutcome::Reject;
        }
        let Some(registry) = self.inner.owner_registry.lock().unwrap().clone() else {
            // Without a registry installed the broker cannot trust any capability;
            // a hello carrying one is rejected, a bare hello is remote.
            return match value.get("capability").and_then(Value::as_str) {
                Some(_) => HelloOutcome::Reject,
                None => HelloOutcome::Remote,
            };
        };
        match value.get("capability").and_then(Value::as_str) {
            Some(capability) => match registry.authenticate(capability) {
                Some(owner) => HelloOutcome::Native(owner),
                None => HelloOutcome::Reject,
            },
            None => HelloOutcome::Remote,
        }
    }

    /// Resolve an `ephemeral_command` to its upstream port using the verified
    /// owner, ignoring any owner/cwd/port hints in the payload, and enforce the
    /// shared command classification on the inner payload type. Never changes
    /// the broker `active_port`.
    fn resolve_ephemeral_command(
        &self,
        ctx: &VerifiedClientContext,
        value: &Value,
    ) -> Result<u16, String> {
        let Some(owner) = &ctx.owner_id else {
            return Err(unauthorized());
        };
        if ctx.class != ClientClass::Native {
            return Err(unauthorized());
        }
        let instance_id = value
            .get("ephemeralInstanceId")
            .and_then(Value::as_str)
            .ok_or_else(unauthorized)?;
        let generation = value
            .get("generation")
            .and_then(Value::as_u64)
            .ok_or_else(unauthorized)?;
        let inner_type = value
            .pointer("/payload/type")
            .and_then(Value::as_str)
            .ok_or_else(unauthorized)?;
        // Fail closed: only explicitly allowed commands reach an ephemeral route.
        match classify_core_command(inner_type) {
            Some(EphemeralPermission::Allowed) => {}
            _ => return Err(unauthorized()),
        }
        self.inner
            .ephemeral_routes
            .lock()
            .unwrap()
            .get(&(owner.clone(), instance_id.to_string(), generation))
            .copied()
            .ok_or_else(unauthorized)
    }

    pub fn register_session(&self, port: u16, session_id: &str) {
        log::info!(
            "[broker-ws] register_session port={} session_id={}",
            port,
            session_id
        );
        self.inner.disabled_ports.lock().unwrap().remove(&port);
        self.set_active_port(port);
        self.set_route(port, session_id);
        self.ensure_upstream(port);
    }

    /// Like `register_session` but does NOT promote this port to active_port.
    /// Use for background/dedicated session processes that should not become
    /// the default command target.
    pub fn track_background_session(&self, port: u16, session_id: &str) {
        self.inner.disabled_ports.lock().unwrap().remove(&port);
        self.set_route(port, session_id);
        self.ensure_upstream(port);
    }

    /// Point `session_id` at `port`, first evicting any other session id that
    /// previously resolved to this port.
    ///
    /// A `pi --mode rpc` process drives exactly ONE active session at a time, so
    /// a port maps to at most one session id. An in-place `new_session` /
    /// `switch_session` reuses the same port for a *different* session; without
    /// this eviction the PREVIOUS session id would keep pointing here. Because
    /// `resolve_command_port` consults the session-id route BEFORE `sourcePort`,
    /// a command still tagged with that now-defunct session would be silently
    /// misrouted into whatever session currently occupies the port — and would
    /// even override a correct `sourcePort` hint. Evicting stale entries keeps
    /// the routing table 1:1 with live sessions (fixes F1 + F2).
    fn set_route(&self, port: u16, session_id: &str) {
        let session_id = session_id.trim();
        let mut routes = self.inner.routes.lock().unwrap();
        // Drop every other session id resolving to this port; keep only the
        // entry for `session_id` itself (so a repeated learn stays idempotent).
        routes.retain(|existing, routed| *routed != port || existing == session_id);
        if !session_id.is_empty() {
            routes.insert(session_id.to_string(), port);
        }
    }

    pub fn unregister_port(&self, port: u16) {
        log::info!("[broker-ws] unregister_port port={}", port);
        self.inner.disabled_ports.lock().unwrap().insert(port);
        self.inner.upstreams.lock().unwrap().remove(&port);
        self.inner
            .routes
            .lock()
            .unwrap()
            .retain(|_, routed| *routed != port);
        let mut active = self.inner.active_port.lock().unwrap();
        if *active == Some(port) {
            *active = None;
        }
    }

    async fn run(self, listener: TcpListener) {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let broker = self.clone();
                    tauri::async_runtime::spawn(async move {
                        broker.handle_ui_client(stream).await;
                    });
                }
                Err(err) => {
                    log::warn!("[broker-ws] accept failed: {}", err);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    }

    async fn handle_ui_client(self, stream: TcpStream) {
        let ws = match tokio_tungstenite::accept_async(stream).await {
            Ok(ws) => ws,
            Err(err) => {
                log::warn!("[broker-ws] UI websocket handshake failed: {}", err);
                return;
            }
        };
        let client_id = self.inner.next_client_id.fetch_add(1, Ordering::Relaxed);
        let (mut writer, mut reader) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        // Accept the socket as unauthenticated; it cannot route commands until a
        // valid `client_hello` is classified and the record is marked authed.
        self.inner.ui_clients.lock().unwrap().insert(
            client_id,
            UiClient {
                tx: tx.clone(),
                class: ClientClass::Remote,
                owner_id: None,
                authed: false,
            },
        );

        let writer_task = tauri::async_runtime::spawn(async move {
            while let Some(message) = rx.recv().await {
                if writer.send(Message::Text(message)).await.is_err() {
                    break;
                }
            }
        });

        // Require a client_hello within a short window. No hello, a malformed
        // hello, or a hello carrying an invalid capability closes the socket
        // without downgrading to remote and without revealing owner existence.
        let hello =
            tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), reader.next()).await;
        let ctx = match hello {
            Ok(Some(Ok(Message::Text(text)))) => match self.classify_hello(&text) {
                HelloOutcome::Native(owner) => {
                    self.promote_native_client(client_id, &owner);
                    VerifiedClientContext {
                        client_id,
                        class: ClientClass::Native,
                        owner_id: Some(owner),
                    }
                }
                HelloOutcome::Remote => {
                    self.promote_remote_client(client_id);
                    VerifiedClientContext {
                        client_id,
                        class: ClientClass::Remote,
                        owner_id: None,
                    }
                }
                HelloOutcome::Reject => {
                    self.remove_client(client_id);
                    writer_task.abort();
                    return;
                }
            },
            _ => {
                self.remove_client(client_id);
                writer_task.abort();
                return;
            }
        };

        let _ = tx.send(
            json!({
                "type": "capabilities",
                "protocolVersion": PROTOCOL_VERSION,
                "class": match ctx.class {
                    ClientClass::Native => "native",
                    ClientClass::Remote => "remote",
                },
            })
            .to_string(),
        );
        if ctx.class == ClientClass::Native {
            if let Some(owner) = &ctx.owner_id {
                self.send_owner_bootstrap(owner, &tx);
            }
        }

        while let Some(item) = reader.next().await {
            match item {
                Ok(Message::Text(text)) => self.route_ui_message(&ctx, &text, &tx),
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(err) => {
                    log::warn!("[broker-ws] UI websocket read failed: {}", err);
                    break;
                }
            }
        }

        self.remove_client(client_id);
        writer_task.abort();
    }

    fn promote_native_client(&self, client_id: u64, owner: &OwnerId) {
        // A reconnecting native window supersedes its previous connection so a
        // reload/reconnect does not create duplicate ephemeral delivery.
        let superseded = {
            let mut owner_map = self.inner.owner_to_client.lock().unwrap();
            owner_map
                .insert(owner.clone(), client_id)
                .filter(|&id| id != client_id)
        };
        if let Some(old_id) = superseded {
            self.remove_client(old_id);
        }
        let mut clients = self.inner.ui_clients.lock().unwrap();
        if let Some(client) = clients.get_mut(&client_id) {
            client.class = ClientClass::Native;
            client.owner_id = Some(owner.clone());
            client.authed = true;
        }
    }

    fn promote_remote_client(&self, client_id: u64) {
        let mut clients = self.inner.ui_clients.lock().unwrap();
        if let Some(client) = clients.get_mut(&client_id) {
            client.class = ClientClass::Remote;
            client.owner_id = None;
            client.authed = true;
        }
    }

    /// Remove a client and clear its owner binding if it was the current client
    /// for that owner, so a stale socket never receives owner-targeted events.
    fn remove_client(&self, client_id: u64) {
        let removed = self.inner.ui_clients.lock().unwrap().remove(&client_id);
        if let Some(client) = removed {
            if let Some(owner) = &client.owner_id {
                let mut owner_map = self.inner.owner_to_client.lock().unwrap();
                if owner_map.get(owner).copied() == Some(client_id) {
                    owner_map.remove(owner);
                }
            }
        }
    }

    /// Send the owner's non-secret ephemeral descriptors in creation order so a
    /// native client can rebind live chats after reload. Task 7a/14 supplies the
    /// descriptor provider; until then a native client with no chats is valid.
    fn send_owner_bootstrap(&self, owner: &OwnerId, tx: &Tx) {
        let instances = self
            .inner
            .ephemeral_descriptor_provider
            .lock()
            .unwrap()
            .as_ref()
            .map(|provider| provider(owner))
            .unwrap_or_else(|| json!([]));
        let _ = tx.send(
            json!({
                "type": "owner_bootstrap",
                "protocolVersion": PROTOCOL_VERSION,
                "instances": instances
            })
            .to_string(),
        );
    }

    fn route_ui_message(&self, ctx: &VerifiedClientContext, text: &str, client_tx: &Tx) {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            log::warn!("[broker-ws] invalid UI message");
            return;
        };

        // `broker_control` requests are NOT forwarded to a pi upstream — they are
        // process/window lifecycle or native ops handled by the host (Rust).
        // Dispatch to the injected control handler and reply to this client only.
        if value.get("type").and_then(Value::as_str) == Some("broker_control") {
            self.dispatch_control(ctx, &value, client_tx);
            return;
        }

        // Ephemeral commands are owner-scoped: the broker resolves the route
        // from the verified client context (never payload fields), enforces the
        // shared command classification, and never changes active_port. This
        // must run before the generic UI-response branch because an ephemeral
        // UI response also carries `payload.type = extension_ui_response`.
        if value.get("type").and_then(Value::as_str) == Some("ephemeral_command") {
            self.dispatch_ephemeral_command(ctx, &value, client_tx);
            return;
        }

        if value.pointer("/payload/type").and_then(Value::as_str) == Some("extension_ui_response") {
            self.dispatch_rpc_ui_response(ctx, &value, client_tx);
            return;
        }

        let Some(port) = self.resolve_command_port(&value) else {
            log::warn!("[broker-ws] no route for UI command: {}", value);
            self.notify_undeliverable(client_tx, &value, "no_route");
            return;
        };
        log::info!(
            "[broker-ws] route command={} request_id={:?} session_id={:?} source_port={:?} -> port={}",
            value.pointer("/payload/type").and_then(Value::as_str).unwrap_or_else(|| {
                value.get("type").and_then(Value::as_str).unwrap_or("unknown")
            }),
            value.get("requestId").and_then(Value::as_str),
            value.get("sessionId").and_then(Value::as_str),
            value.get("sourcePort").and_then(Value::as_u64),
            port
        );
        self.ensure_upstream(port);
        let upstream_tx = self.inner.upstreams.lock().unwrap().get(&port).cloned();
        // A `broker_command` is fire-and-forget on the wire, so a routing/delivery
        // failure here would otherwise vanish silently — the user sees their
        // prompt echoed but the agent never receives it. Reply to the sender with
        // a `command_undeliverable` frame (tagged with the original requestId) so
        // the UI can surface the loss instead of hanging (F3). `ensure_upstream`
        // queues into the channel even while reconnecting, so a `None` tx (or a
        // closed channel) means the port is genuinely gone (killed/disabled).
        let delivered = match upstream_tx {
            Some(tx) => tx.send(text.to_string()).is_ok(),
            None => false,
        };
        if !delivered {
            log::warn!("[broker-ws] upstream {} unavailable; command dropped", port);
            self.notify_undeliverable(client_tx, &value, "upstream_unavailable");
        }
    }

    fn dispatch_rpc_ui_response(&self, ctx: &VerifiedClientContext, value: &Value, client_tx: &Tx) {
        let Some(port) = self.resolve_command_port(value) else {
            return;
        };
        let authorized = match ctx.class {
            ClientClass::Remote => *self.inner.active_port.lock().unwrap() == Some(port),
            ClientClass::Native => ctx.owner_id.as_ref().is_some_and(|owner| {
                self.inner
                    .owner_registry
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|registry| registry.current_workspace(owner))
                    .is_some_and(|(_, current_port)| current_port == port)
            }),
        };
        if !authorized {
            let _ = client_tx.send(
                json!({
                    "type": "command_undeliverable",
                    "requestId": value.get("requestId"),
                    "command": "extension_ui_response",
                    "reason": "unauthorized",
                })
                .to_string(),
            );
            return;
        }
        let Some(handler) = self.inner.control_handler.lock().unwrap().clone() else {
            return;
        };
        let response = value.get("payload").cloned().unwrap_or(Value::Null);
        let request_id = value.get("requestId").cloned().unwrap_or(Value::Null);
        let args = json!({ "port": port, "response": response });
        let context = ctx.clone();
        let tx = client_tx.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = handler(
                context,
                "rpc_extension_ui_response".to_string(),
                args,
                Arc::new(|_| {}),
            )
            .await
            {
                let _ = tx.send(
                    json!({
                        "type": "command_undeliverable",
                        "requestId": request_id,
                        "command": "extension_ui_response",
                        "reason": error,
                    })
                    .to_string(),
                );
            }
        });
    }

    /// Resolve and forward an `ephemeral_command`. Owner is derived from the
    /// verified context; payload owner/cwd/port hints are ignored. A routing or
    // policy failure replies with a generic error that reveals no instance state.
    fn dispatch_ephemeral_command(
        &self,
        ctx: &VerifiedClientContext,
        value: &Value,
        client_tx: &Tx,
    ) {
        let request_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut payload = value.get("payload").cloned().unwrap_or(Value::Null);
        let fail = || {
            let _ = client_tx.send(
                json!({
                    "type": "ephemeral_command_failed",
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "error": unauthorized(),
                })
                .to_string(),
            );
        };
        let port = match self.resolve_ephemeral_command(ctx, value) {
            Ok(port) => port,
            Err(_) => {
                fail();
                return;
            }
        };
        if payload.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
            self.dispatch_ephemeral_extension_response(ctx, value, payload, client_tx);
            return;
        }
        // The embedded server correlates response frames through `command.id`;
        // carry the browser request id across the broker envelope so scoped
        // runtime requests (notably the model list) can resolve.
        if let Some(command) = payload.as_object_mut() {
            command.insert("id".to_string(), Value::String(request_id.clone()));
        }
        self.ensure_upstream(port);
        let upstream_tx = self.inner.upstreams.lock().unwrap().get(&port).cloned();
        let delivered = matches!(&upstream_tx, Some(tx) if tx.send(payload.to_string()).is_ok());
        if !delivered {
            fail();
        }
    }

    fn dispatch_ephemeral_extension_response(
        &self,
        ctx: &VerifiedClientContext,
        value: &Value,
        response: Value,
        client_tx: &Tx,
    ) {
        let Some(handler) = self.inner.control_handler.lock().unwrap().clone() else {
            return;
        };
        let request_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = json!({
            "instanceId": value.get("ephemeralInstanceId").cloned().unwrap_or(Value::Null),
            "generation": value.get("generation").cloned().unwrap_or(Value::Null),
            "response": response,
        });
        let tx = client_tx.clone();
        let context = ctx.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(_error) = handler(
                context,
                "ephemeral_extension_ui_response".to_string(),
                args,
                Arc::new(|_| {}),
            )
            .await
            {
                let _ = tx.send(
                    json!({
                        "type": "ephemeral_command_failed",
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request_id,
                        "error": unauthorized(),
                    })
                    .to_string(),
                );
            }
        });
    }

    /// Reply to the originating UI client that a `broker_command` could not be
    /// delivered. Tagged with the original `requestId` so the frontend can
    /// correlate it to the in-flight prompt and surface a visible error.
    fn notify_undeliverable(&self, client_tx: &Tx, value: &Value, reason: &str) {
        let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
        let command = value
            .pointer("/payload/type")
            .and_then(Value::as_str)
            .or_else(|| value.get("type").and_then(Value::as_str))
            .unwrap_or("");
        let _ = client_tx.send(
            json!({
                "type": "command_undeliverable",
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "command": command,
                "reason": reason,
                "sessionId": value.get("sessionId").cloned().unwrap_or(Value::Null),
            })
            .to_string(),
        );
    }

    fn dispatch_control(&self, ctx: &VerifiedClientContext, value: &Value, client_tx: &Tx) {
        let request_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let command = value
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = value.get("args").cloned().unwrap_or(Value::Null);

        let handler = self.inner.control_handler.lock().unwrap().clone();
        let tx = client_tx.clone();

        let Some(handler) = handler else {
            let _ = tx.send(
                json!({
                    "type": "control_response",
                    "requestId": request_id,
                    "ok": false,
                    "error": "Control commands are not available on this server",
                })
                .to_string(),
            );
            return;
        };

        // Progress sink: streams intermediate frames (e.g. updater download
        // chunks) back to the requesting client, tagged with the requestId.
        let progress_tx = tx.clone();
        let progress_request_id = request_id.clone();
        let sink: ProgressSink = Arc::new(move |data: Value| {
            let _ = progress_tx.send(
                json!({
                    "type": "control_progress",
                    "requestId": progress_request_id,
                    "data": data,
                })
                .to_string(),
            );
        });

        log::info!(
            "[broker-ws] control command={} request_id={}",
            command,
            request_id
        );
        let ctx = ctx.clone();
        tauri::async_runtime::spawn(async move {
            let response = match handler(ctx, command.clone(), args, sink).await {
                Ok(result) => json!({
                    "type": "control_response",
                    "requestId": request_id,
                    "ok": true,
                    "result": result,
                }),
                Err(error) => {
                    log::warn!("[broker-ws] control command {} failed: {}", command, error);
                    json!({
                        "type": "control_response",
                        "requestId": request_id,
                        "ok": false,
                        "error": error,
                    })
                }
            };
            let _ = tx.send(response.to_string());
        });
    }

    fn resolve_command_port(&self, value: &Value) -> Option<u16> {
        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| value.pointer("/payload/sessionId").and_then(Value::as_str))
            .or_else(|| {
                value
                    .pointer("/payload/sessionFile")
                    .and_then(Value::as_str)
            })
            .or_else(|| {
                value
                    .pointer("/payload/sessionPath")
                    .and_then(Value::as_str)
            });
        let source_port = value
            .get("sourcePort")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok());
        if let Some(session_id) = session_id {
            if let Some(port) = self.inner.routes.lock().unwrap().get(session_id).copied() {
                // The session route is authoritative — it is learned from real
                // upstream traffic and kept 1:1 with live sessions by set_route.
                // A disagreeing sourcePort means the client's foreground-port
                // hint has drifted; trust the route but make it observable so a
                // genuine misroute can never hide (F2).
                if let Some(source_port) = source_port {
                    if source_port != port {
                        log::warn!(
                            "[broker-ws] route/source_port disagree: session_id={} -> port={} but source_port={}; trusting session route",
                            session_id,
                            port,
                            source_port
                        );
                    }
                }
                return Some(port);
            }
        }
        if let Some(source_port) = source_port {
            return Some(source_port);
        }
        // Last resort: the global active_port. Safe only when unambiguous — with
        // multiple live pi processes it belongs to whichever window registered
        // most recently, so guessing it would misroute an unaddressed command
        // into another window's session. When ambiguous, return None so the
        // command surfaces as undeliverable (F3) instead of misrouting (F4).
        let active = *self.inner.active_port.lock().unwrap();
        if self.inner.upstreams.lock().unwrap().len() > 1 {
            log::warn!(
                "[broker-ws] refusing ambiguous active_port fallback ({:?}) among {} live upstreams",
                active,
                self.inner.upstreams.lock().unwrap().len()
            );
            return None;
        }
        active
    }

    fn ensure_upstream(&self, port: u16) {
        if self.inner.disabled_ports.lock().unwrap().contains(&port) {
            return;
        }
        // Insert the sender inside the lock before spawning so that a second
        // concurrent call sees the key and returns early — eliminates the
        // TOCTOU window between the contains_key check and the spawn.
        let rx = {
            let mut upstreams = self.inner.upstreams.lock().unwrap();
            if upstreams.contains_key(&port) {
                return;
            }
            let (tx, rx) = mpsc::unbounded_channel::<String>();
            upstreams.insert(port, tx);
            rx
        };
        let broker = self.clone();
        tauri::async_runtime::spawn(async move {
            broker.run_upstream(port, rx).await;
        });
    }

    async fn run_upstream(self, port: u16, mut rx: mpsc::UnboundedReceiver<String>) {
        let url = format!("ws://127.0.0.1:{}/ws", port);

        loop {
            if self.inner.disabled_ports.lock().unwrap().contains(&port) {
                self.inner.upstreams.lock().unwrap().remove(&port);
                return;
            }
            match tokio_tungstenite::connect_async(&url).await {
                Ok((ws, _)) => {
                    log::info!("[broker-ws] connected upstream port {}", port);
                    let (mut writer, mut reader) = ws.split();
                    let mut shutdown_check =
                        tokio::time::interval(std::time::Duration::from_millis(500));
                    loop {
                        tokio::select! {
                            _ = shutdown_check.tick() => {
                                if self.inner.disabled_ports.lock().unwrap().contains(&port) {
                                    self.inner.upstreams.lock().unwrap().remove(&port);
                                    return;
                                }
                            }
                            Some(outbound) = rx.recv() => {
                                if writer.send(Message::Text(outbound)).await.is_err() {
                                    break;
                                }
                            }
                            inbound = reader.next() => {
                                match inbound {
                                    Some(Ok(Message::Text(text))) => {
                                        if let Some(message) = self.wrap_upstream_message(port, &text) {
                                            self.broadcast(&message);
                                        }
                                    }
                                    Some(Ok(Message::Close(_))) | None => break,
                                    Some(Ok(_)) => {}
                                    Some(Err(err)) => {
                                        if !self.inner.disabled_ports.lock().unwrap().contains(&port)
                                        {
                                            log::warn!(
                                                "[broker-ws] upstream {} read failed: {}",
                                                port,
                                                err
                                            );
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if self.inner.disabled_ports.lock().unwrap().contains(&port) {
                        self.inner.upstreams.lock().unwrap().remove(&port);
                        return;
                    }
                    log::warn!(
                        "[broker-ws] upstream port {} disconnected; reconnecting",
                        port
                    );
                }
                Err(err) => {
                    log::warn!("[broker-ws] upstream {} connect failed: {}", port, err);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        }
    }

    fn wrap_upstream_message(&self, port: u16, text: &str) -> Option<String> {
        let Ok(payload) = serde_json::from_str::<Value>(text) else {
            return None;
        };
        // Ephemeral upstream events are delivered only to the owner's current
        // authenticated client, never broadcast. The route is identified by the
        // registered port; the child never supplies a trusted owner identity.
        let ephemeral_key = {
            let routes = self.inner.ephemeral_routes.lock().unwrap();
            routes
                .iter()
                .find(|(_, registered_port)| **registered_port == port)
                .map(|(key, _)| key.clone())
        };
        if let Some(key) = ephemeral_key {
            let owner = &key.0;
            let payload = rekey_ephemeral_payload(payload, &key.1, key.2);
            let is_snapshot =
                payload.get("type").and_then(Value::as_str) == Some("ephemeral_snapshot");
            // Hoist the producer's runtimeSequence to the envelope top level so
            // the frontend runtime can sequence events without peeking into the
            // payload (the snapshot response carries no sequence and is detected
            // by payload.type below).
            let runtime_sequence = payload.get("runtimeSequence").and_then(Value::as_u64);
            let mut envelope = json!({
                "type": "ephemeral_event",
                "protocolVersion": PROTOCOL_VERSION,
                "instanceId": key.1,
                "generation": key.2,
                "payload": payload,
            });
            let watermark = envelope["payload"]
                .get("runtimeSequenceWatermark")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if let Some(seq) = runtime_sequence {
                envelope["runtimeSequence"] = json!(seq);
                self.record_ephemeral_frame(&key, envelope.clone());
            }
            self.send_owner_event(owner, envelope);
            if is_snapshot {
                for replay in self.replay_ephemeral_events(&key, watermark) {
                    self.send_owner_event(owner, replay);
                }
            }
            return None;
        }
        if let Some(session_id) = extract_session_id(&payload) {
            log::debug!(
                "[broker-ws] learn route session_id={} -> port={}",
                session_id,
                port
            );
            // Use set_route (not a bare insert) so an in-place `new_session` —
            // which reuses the port and is only ever observed through this
            // learn path (`new_session_core` does not call register_session) —
            // evicts the previous session's now-defunct route on this port.
            self.set_route(port, session_id);
        }
        let workspace_id = payload.get("workspaceId").cloned().unwrap_or(Value::Null);
        let session_id = payload.get("sessionId").cloned().unwrap_or(Value::Null);
        Some(
            json!({
                "type": "broker_event",
                "protocolVersion": PROTOCOL_VERSION,
                "workspaceId": workspace_id,
                "sessionId": session_id,
                "sourcePort": port,
                "payload": payload,
            })
            .to_string(),
        )
    }

    fn broadcast(&self, message: &str) {
        let mut stale = Vec::new();
        let clients = self.inner.ui_clients.lock().unwrap();
        for (id, client) in clients.iter() {
            if client.tx.send(message.to_string()).is_err() {
                stale.push(*id);
            }
        }
        drop(clients);
        if !stale.is_empty() {
            let mut clients = self.inner.ui_clients.lock().unwrap();
            for id in stale {
                clients.remove(&id);
            }
        }
    }
}

fn unauthorized() -> String {
    "Command is not available in temporary chat".to_string()
}

fn extract_session_id(payload: &Value) -> Option<&str> {
    payload
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| payload.get("sessionFile").and_then(Value::as_str))
}

/// The host-owned route is authoritative for an adopted standby. Its embedded
/// runtime was intentionally started with a placeholder identity, so rewrite
/// any identity fields before its frame reaches the owner-scoped frontend.
fn rekey_ephemeral_payload(mut payload: Value, instance_id: &str, generation: u64) -> Value {
    if payload.get("instanceId").is_some() {
        payload["instanceId"] = json!(instance_id);
    }
    if payload.get("generation").is_some() {
        payload["generation"] = json!(generation);
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn extract_session_id_prefers_route_metadata() {
        let payload = json!({
            "sessionId": "session-id",
            "sessionFile": "session-file"
        });

        assert_eq!(extract_session_id(&payload), Some("session-id"));
    }

    #[test]
    fn rekeys_standby_snapshot_to_its_adopted_route() {
        let snapshot = json!({
            "type": "ephemeral_snapshot",
            "instanceId": "standby",
            "generation": 0,
            "runtimeSequenceWatermark": 0,
        });

        let rekeyed = rekey_ephemeral_payload(snapshot, "chat-42", 7);

        assert_eq!(rekeyed["instanceId"], "chat-42");
        assert_eq!(rekeyed["generation"], 7);
    }

    #[test]
    fn command_routes_by_session_id_before_active_port() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);
        broker.register_session(47822, "/tmp/session-b.jsonl");

        let command = json!({
            "type": "broker_command",
            "sessionId": "/tmp/session-b.jsonl",
            "payload": { "type": "mirror_sync_request" }
        });

        assert_eq!(broker.resolve_command_port(&command), Some(47822));
    }

    #[test]
    fn command_falls_back_to_active_port_without_route() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);

        assert_eq!(
            broker.resolve_command_port(&json!({ "type": "broker_command" })),
            Some(47821)
        );
    }

    #[test]
    fn in_place_session_swap_evicts_previous_session_route() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // An unrelated session the user is NOT viewing lives on its own port.
        broker.register_session(47822, "/tmp/other.jsonl");
        // Port 47821 first hosts session A...
        broker.register_session(47821, "/tmp/session-a.jsonl");
        // ...then swaps in-place to session B (same port reused).
        broker.register_session(47821, "/tmp/session-b.jsonl");

        let routes = broker.inner.routes.lock().unwrap();
        // The now-defunct session A must no longer resolve anywhere (F1).
        assert_eq!(routes.get("/tmp/session-a.jsonl"), None);
        assert_eq!(routes.get("/tmp/session-b.jsonl"), Some(&47821));
        // Eviction is scoped to the reused port — unrelated routes are intact.
        assert_eq!(routes.get("/tmp/other.jsonl"), Some(&47822));
    }

    #[test]
    fn evicted_session_id_does_not_override_source_port() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // Port 50001 hosted session A, then swapped in-place to session B.
        broker.register_session(50001, "/tmp/session-a.jsonl");
        broker.register_session(50001, "/tmp/session-b.jsonl");

        // A command still tagged with the defunct session A but carrying the
        // correct live source port (50002) must fall back to source_port — the
        // stale A route is gone, so it cannot hijack the command (F2).
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sessionId": "/tmp/session-a.jsonl",
                "sourcePort": 50002,
                "payload": { "type": "prompt" }
            })),
            Some(50002)
        );
    }

    #[test]
    fn refuses_ambiguous_active_port_fallback_with_multiple_upstreams() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // Two windows / workspaces are live; active_port is whichever registered
        // last (47822), which has nothing to do with where an unaddressed command
        // from the OTHER window should go.
        broker.register_session(47821, "/tmp/a.jsonl");
        broker.register_session(47822, "/tmp/b.jsonl");

        // A command with neither a known session route nor a sourcePort must not
        // be silently routed to the global active_port — it surfaces as
        // undeliverable instead of misrouting across windows (F4).
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "payload": { "type": "prompt" }
            })),
            None
        );

        // An explicit sourcePort is still honored even with multiple upstreams.
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sourcePort": 47821,
                "payload": { "type": "prompt" }
            })),
            Some(47821)
        );
    }

    #[test]
    fn command_routes_by_source_port_when_session_route_is_unknown() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);

        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sessionId": "/tmp/unknown-session.jsonl",
                "sourcePort": 47824,
                "payload": { "type": "mirror_sync_request" }
            })),
            Some(47824)
        );
    }

    // ─── Task 5: capability handshake + owner-scoped ephemeral routing ────

    fn broker_with_registry() -> (BrokerWs, Arc<WindowOwnerRegistry>) {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        let registry = Arc::new(WindowOwnerRegistry::default());
        broker.set_owner_registry(registry.clone());
        (broker, registry)
    }

    fn test_owner(label: &str) -> OwnerId {
        WindowOwnerRegistry::default()
            .create_owner(
                label.to_string(),
                PathBuf::from("/ws"),
                47821,
                "http://127.0.0.1:47821".to_string(),
            )
            .expect("owner")
            .0
    }

    fn native_ctx(
        broker: &BrokerWs,
        registry: &WindowOwnerRegistry,
        label: &str,
    ) -> VerifiedClientContext {
        let (owner, capability) = registry
            .create_owner(
                label.to_string(),
                PathBuf::from("/ws"),
                47821,
                "http://127.0.0.1:47821".to_string(),
            )
            .expect("owner");
        let hello = json!({ "type": "client_hello", "capability": capability }).to_string();
        match broker.classify_hello(&hello) {
            HelloOutcome::Native(resolved) => VerifiedClientContext {
                client_id: 1,
                class: ClientClass::Native,
                owner_id: Some(resolved),
            },
            _ => panic!("expected native hello, owner mismatch: {:?}", owner),
        }
    }

    #[test]
    fn hello_with_valid_capability_authenticates_as_owner() {
        let (broker, registry) = broker_with_registry();
        let ctx = native_ctx(&broker, &registry, "w1");
        assert_eq!(ctx.class, ClientClass::Native);
        assert!(ctx.owner_id.is_some());
    }

    #[test]
    fn hello_without_capability_is_remote() {
        let (broker, _registry) = broker_with_registry();
        let hello = json!({ "type": "client_hello" }).to_string();
        assert!(matches!(
            broker.classify_hello(&hello),
            HelloOutcome::Remote
        ));
    }

    #[test]
    fn hello_with_invalid_capability_is_rejected_not_downgraded() {
        let (broker, _registry) = broker_with_registry();
        let hello = json!({ "type": "client_hello", "capability": "bogus-token" }).to_string();
        assert!(matches!(
            broker.classify_hello(&hello),
            HelloOutcome::Reject
        ));
    }

    #[test]
    fn non_hello_first_frame_is_rejected() {
        let (broker, _registry) = broker_with_registry();
        let frame =
            json!({ "type": "broker_command", "payload": { "type": "prompt" } }).to_string();
        assert!(matches!(
            broker.classify_hello(&frame),
            HelloOutcome::Reject
        ));
    }

    fn ephemeral_command(instance: &str, generation: u64, inner_type: &str) -> Value {
        json!({
            "type": "ephemeral_command",
            "requestId": "req-1",
            "ephemeralInstanceId": instance,
            "generation": generation,
            "payload": { "type": inner_type }
        })
    }

    #[test]
    fn ephemeral_command_routes_by_verified_owner_not_payload_hints() {
        let (broker, registry) = broker_with_registry();
        let ctx = native_ctx(&broker, &registry, "w1");
        let owner = ctx.owner_id.as_ref().unwrap();
        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner.clone(),
                instance_id: "inst-A".to_string(),
                generation: 1,
                port: 50001,
            })
            .unwrap();

        // Forged owner/instance/port fields in the payload must be ignored.
        let forged = json!({
            "type": "ephemeral_command",
            "requestId": "req-1",
            "ephemeralInstanceId": "inst-A",
            "generation": 1,
            "ownerId": "someone-else",
            "payload": { "type": "prompt" }
        });
        assert_eq!(
            broker.resolve_ephemeral_command(&ctx, &forged).unwrap(),
            50001
        );
    }

    #[test]
    fn ephemeral_command_forwards_request_id_as_upstream_command_id() {
        let (broker, registry) = broker_with_registry();
        let ctx = native_ctx(&broker, &registry, "w1");
        let owner = ctx.owner_id.as_ref().expect("owner");
        let port = 50001;
        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner.clone(),
                instance_id: "inst-A".to_string(),
                generation: 1,
                port,
            })
            .expect("route");
        let (upstream_tx, mut upstream_rx) = mpsc::unbounded_channel();
        broker
            .inner
            .upstreams
            .lock()
            .unwrap()
            .insert(port, upstream_tx);
        let (client_tx, _client_rx) = mpsc::unbounded_channel();

        broker.dispatch_ephemeral_command(
            &ctx,
            &ephemeral_command("inst-A", 1, "get_available_models"),
            &client_tx,
        );

        let forwarded: Value =
            serde_json::from_str(&upstream_rx.try_recv().expect("forwarded command"))
                .expect("JSON command");
        assert_eq!(forwarded["id"], "req-1");
        assert_eq!(forwarded["type"], "get_available_models");
    }

    #[test]
    fn ephemeral_command_denied_for_other_owner() {
        let (broker, registry) = broker_with_registry();
        let owner_a = native_ctx(&broker, &registry, "wA");
        let owner_b = native_ctx(&broker, &registry, "wB");
        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner_b.owner_id.clone().unwrap(),
                instance_id: "inst-B".to_string(),
                generation: 1,
                port: 50002,
            })
            .unwrap();
        // owner_a cannot reach owner_b's instance even naming it.
        assert!(broker
            .resolve_ephemeral_command(&owner_a, &ephemeral_command("inst-B", 1, "prompt"))
            .is_err());
    }

    #[test]
    fn ephemeral_command_denied_for_remote_client() {
        let (broker, registry) = broker_with_registry();
        let native = native_ctx(&broker, &registry, "w1");
        let owner = native.owner_id.as_ref().unwrap();
        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner.clone(),
                instance_id: "inst-A".to_string(),
                generation: 1,
                port: 50003,
            })
            .unwrap();
        let remote_ctx = VerifiedClientContext {
            client_id: 99,
            class: ClientClass::Remote,
            owner_id: None,
        };
        assert!(broker
            .resolve_ephemeral_command(&remote_ctx, &ephemeral_command("inst-A", 1, "prompt"))
            .is_err());
    }

    #[test]
    fn ephemeral_command_denies_session_lifecycle_policy() {
        let (broker, registry) = broker_with_registry();
        let ctx = native_ctx(&broker, &registry, "w1");
        let owner = ctx.owner_id.as_ref().unwrap();
        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner.clone(),
                instance_id: "inst-A".to_string(),
                generation: 1,
                port: 50004,
            })
            .unwrap();
        // new_session is deniedSessionLifecycle in the shared manifest.
        assert!(broker
            .resolve_ephemeral_command(&ctx, &ephemeral_command("inst-A", 1, "new_session"))
            .is_err());
    }

    #[test]
    fn ephemeral_command_preserves_active_port() {
        let (broker, registry) = broker_with_registry();
        let ctx = native_ctx(&broker, &registry, "w1");
        let owner = ctx.owner_id.as_ref().unwrap();
        broker.set_active_port(47821);
        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner.clone(),
                instance_id: "inst-A".to_string(),
                generation: 1,
                port: 50005,
            })
            .unwrap();
        let _ = broker.resolve_ephemeral_command(&ctx, &ephemeral_command("inst-A", 1, "prompt"));
        assert_eq!(broker.active_port(), Some(47821));
    }

    #[test]
    fn unregister_ephemeral_route_requires_port_match() {
        let (broker, registry) = broker_with_registry();
        let ctx = native_ctx(&broker, &registry, "w1");
        let owner = ctx.owner_id.as_ref().unwrap();
        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner.clone(),
                instance_id: "inst-A".to_string(),
                generation: 1,
                port: 50006,
            })
            .unwrap();
        // Stale port must not unregister the live route.
        broker.unregister_ephemeral_route(owner, "inst-A", 1, 9999);
        assert_eq!(
            broker.resolve_ephemeral_command(&ctx, &ephemeral_command("inst-A", 1, "prompt")),
            Ok(50006)
        );
        let stale_cleanup_disabled_port = match broker.inner.disabled_ports.lock() {
            Ok(ports) => ports.contains(&50006),
            Err(_) => false,
        };
        assert!(!stale_cleanup_disabled_port);
        broker.unregister_ephemeral_route(owner, "inst-A", 1, 50006);
        assert!(broker
            .resolve_ephemeral_command(&ctx, &ephemeral_command("inst-A", 1, "prompt"))
            .is_err());
        let live_cleanup_disabled_port = match broker.inner.disabled_ports.lock() {
            Ok(ports) => ports.contains(&50006),
            Err(_) => false,
        };
        assert!(live_cleanup_disabled_port);
    }

    #[test]
    fn registering_a_replacement_ephemeral_route_reenables_its_reused_port() {
        let (broker, registry) = broker_with_registry();
        let ctx = native_ctx(&broker, &registry, "w1");
        let owner = ctx.owner_id.as_ref().unwrap();
        let route = EphemeralRoute {
            owner_id: owner.clone(),
            instance_id: "inst-A".to_string(),
            generation: 1,
            port: 50006,
        };
        broker.register_ephemeral_route(route).unwrap();
        broker.unregister_ephemeral_route(owner, "inst-A", 1, 50006);

        broker
            .register_ephemeral_route(EphemeralRoute {
                owner_id: owner.clone(),
                instance_id: "inst-B".to_string(),
                generation: 2,
                port: 50006,
            })
            .unwrap();

        let disabled = broker
            .inner
            .disabled_ports
            .lock()
            .expect("disabled ports lock")
            .contains(&50006);
        assert!(!disabled);
    }

    #[test]
    fn owner_bootstrap_uses_the_registered_descriptor_provider() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        let registry = Arc::new(WindowOwnerRegistry::default());
        let (owner, _) = registry
            .create_owner(
                "w1".to_string(),
                PathBuf::from("/ws"),
                47821,
                "http://127.0.0.1:47821".to_string(),
            )
            .unwrap();
        broker.set_ephemeral_descriptor_provider(Arc::new(
            |_| json!([{ "instanceId": "chat-1", "generation": 1, "kind": "side-chat" }]),
        ));

        let (tx, mut rx) = mpsc::unbounded_channel();
        broker.send_owner_bootstrap(&owner, &tx);
        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "owner_bootstrap");
        assert_eq!(frame["instances"][0]["instanceId"], "chat-1");
        assert!(frame["instances"][0].get("port").is_none());
    }

    #[test]
    fn ephemeral_journal_replays_events_after_snapshot_watermark() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        let owner = test_owner("journal-a");
        let key = (owner.clone(), "inst-a".to_string(), 1);
        for sequence in 1..=3 {
            broker.record_ephemeral_frame(
                &key,
                json!({
                    "type": "ephemeral_event",
                    "instanceId": "inst-a",
                    "generation": 1,
                    "runtimeSequence": sequence,
                    "payload": { "type": "event" }
                }),
            );
        }

        let replay = broker.replay_ephemeral_events(&key, 1);
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0]["runtimeSequence"], 2);
        assert_eq!(replay[1]["runtimeSequence"], 3);
    }

    #[test]
    fn ephemeral_journal_is_bounded_and_evicts_oldest_sequences() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        let key = (test_owner("journal-b"), "inst-a".to_string(), 1);
        for sequence in 1..=(EPHEMERAL_JOURNAL_MAX_EVENTS as u64 + 1) {
            broker.record_ephemeral_frame(
                &key,
                json!({
                    "type": "ephemeral_event",
                    "runtimeSequence": sequence,
                    "payload": { "type": "event" }
                }),
            );
        }

        let replay = broker.replay_ephemeral_events(&key, 0);
        assert_eq!(replay.len(), EPHEMERAL_JOURNAL_MAX_EVENTS);
        assert_eq!(replay[0]["runtimeSequence"], 2);
        assert_eq!(
            replay.last().unwrap()["runtimeSequence"],
            EPHEMERAL_JOURNAL_MAX_EVENTS as u64 + 1
        );
    }
}
