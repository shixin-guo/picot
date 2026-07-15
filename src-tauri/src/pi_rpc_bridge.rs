#![allow(dead_code)]

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Debug, Clone, PartialEq)]
pub enum BridgeFrame {
    Event(Value),
    ExtensionUi(Value),
    ProtocolError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    ProcessClosed,
    Timeout,
    Transport(String),
}

impl BridgeError {
    pub fn is_process_closed(&self) -> bool {
        matches!(self, Self::ProcessClosed)
    }
}

type PendingSender = oneshot::Sender<Result<Value, BridgeError>>;

struct BridgeInner {
    next_id: AtomicU64,
    outbound: mpsc::Sender<Value>,
    frames: Mutex<mpsc::Receiver<BridgeFrame>>,
    pending: Mutex<HashMap<String, PendingSender>>,
}

#[derive(Clone)]
pub struct PiRpcBridge {
    inner: Arc<BridgeInner>,
}

pub struct InMemoryPiProcess {
    outbound: mpsc::Receiver<Value>,
    incoming: Option<mpsc::Sender<Vec<u8>>>,
}

pub struct PiRpcProcess {
    child: Arc<StdMutex<Child>>,
    diagnostics: std::sync::mpsc::Receiver<String>,
}

impl PiRpcBridge {
    pub fn attach(
        mut child: Child,
        max_frame_bytes: usize,
    ) -> Result<(Self, PiRpcProcess), String> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Pi RPC process stdin is not piped".to_string())?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Pi RPC process stdout is not piped".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Pi RPC process stderr is not piped".to_string())?;
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<Value>(64);
        let (incoming_tx, incoming_rx) = mpsc::channel::<Vec<u8>>(64);
        let (frame_tx, frame_rx) = mpsc::channel(64);
        let inner = Arc::new(BridgeInner {
            next_id: AtomicU64::new(1),
            outbound: outbound_tx,
            frames: Mutex::new(frame_rx),
            pending: Mutex::new(HashMap::new()),
        });
        tokio::spawn(read_frames(
            incoming_rx,
            frame_tx,
            Arc::clone(&inner),
            max_frame_bytes,
        ));

        std::thread::Builder::new()
            .name("picot-pi-rpc-writer".into())
            .spawn(move || {
                while let Some(frame) = outbound_rx.blocking_recv() {
                    let mut encoded = frame.to_string();
                    encoded.push('\n');
                    if stdin.write_all(encoded.as_bytes()).is_err() || stdin.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Cannot start Pi RPC writer: {error}"))?;

        std::thread::Builder::new()
            .name("picot-pi-rpc-reader".into())
            .spawn(move || read_jsonl_stdout(&mut stdout, incoming_tx, max_frame_bytes))
            .map_err(|error| format!("Cannot start Pi RPC reader: {error}"))?;

        let (diagnostic_tx, diagnostic_rx) = std::sync::mpsc::sync_channel(64);
        std::thread::Builder::new()
            .name("picot-pi-rpc-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let bounded: String = line.chars().take(4096).collect();
                    let _ = diagnostic_tx.try_send(bounded);
                }
            })
            .map_err(|error| format!("Cannot start Pi RPC stderr reader: {error}"))?;

        Ok((
            Self { inner },
            PiRpcProcess {
                child: Arc::new(StdMutex::new(child)),
                diagnostics: diagnostic_rx,
            },
        ))
    }

    #[cfg(test)]
    pub(crate) fn in_memory(max_frame_bytes: usize) -> (Self, InMemoryPiProcess) {
        let (outbound_tx, outbound_rx) = mpsc::channel(32);
        let (incoming_tx, incoming_rx) = mpsc::channel(32);
        let (frame_tx, frame_rx) = mpsc::channel(32);
        let inner = Arc::new(BridgeInner {
            next_id: AtomicU64::new(1),
            outbound: outbound_tx,
            frames: Mutex::new(frame_rx),
            pending: Mutex::new(HashMap::new()),
        });
        tokio::spawn(read_frames(
            incoming_rx,
            frame_tx,
            Arc::clone(&inner),
            max_frame_bytes,
        ));
        (
            Self { inner },
            InMemoryPiProcess {
                outbound: outbound_rx,
                incoming: Some(incoming_tx),
            },
        )
    }

    pub async fn request(
        &self,
        mut command: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let id = format!(
            "picot-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let object = command
            .as_object_mut()
            .ok_or_else(|| BridgeError::Transport("RPC command must be an object".into()))?;
        object.insert("id".into(), Value::String(id.clone()));

        let (response_tx, response_rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(id.clone(), response_tx);
        if self.inner.outbound.send(command).await.is_err() {
            self.inner.pending.lock().await.remove(&id);
            return Err(BridgeError::ProcessClosed);
        }

        match tokio::time::timeout(timeout, response_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BridgeError::ProcessClosed),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(BridgeError::Timeout)
            }
        }
    }

    pub async fn send_frame(&self, frame: Value) -> Result<(), BridgeError> {
        self.inner
            .outbound
            .send(frame)
            .await
            .map_err(|_| BridgeError::ProcessClosed)
    }

    pub async fn next_frame(&self) -> Option<BridgeFrame> {
        self.inner.frames.lock().await.recv().await
    }
}

impl PiRpcProcess {
    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>, String> {
        self.child
            .lock()
            .map_err(|_| "Pi RPC process lock poisoned".to_string())?
            .try_wait()
            .map_err(|error| format!("Cannot inspect Pi RPC process: {error}"))
    }

    pub fn wait(&mut self) -> Result<ExitStatus, String> {
        self.child
            .lock()
            .map_err(|_| "Pi RPC process lock poisoned".to_string())?
            .wait()
            .map_err(|error| format!("Cannot wait for Pi RPC process: {error}"))
    }

    pub fn kill(&mut self) -> Result<(), String> {
        self.child
            .lock()
            .map_err(|_| "Pi RPC process lock poisoned".to_string())?
            .kill()
            .map_err(|error| format!("Cannot stop Pi RPC process: {error}"))
    }

    pub fn take_diagnostic(&self) -> Option<String> {
        self.diagnostics.try_recv().ok()
    }
}

fn read_jsonl_stdout(
    stdout: &mut impl Read,
    incoming: mpsc::Sender<Vec<u8>>,
    max_frame_bytes: usize,
) {
    let mut chunk = [0_u8; 8192];
    let mut frame = Vec::new();
    let mut oversized = false;
    loop {
        let read = match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for byte in &chunk[..read] {
            if *byte == b'\n' {
                if oversized {
                    if incoming
                        .blocking_send(vec![0; max_frame_bytes + 1])
                        .is_err()
                    {
                        return;
                    }
                } else {
                    if frame.last() == Some(&b'\r') {
                        frame.pop();
                    }
                    if incoming.blocking_send(std::mem::take(&mut frame)).is_err() {
                        return;
                    }
                }
                frame.clear();
                oversized = false;
            } else if !oversized {
                frame.push(*byte);
                if frame.len() > max_frame_bytes {
                    frame.clear();
                    oversized = true;
                }
            }
        }
    }
}

async fn read_frames(
    mut incoming: mpsc::Receiver<Vec<u8>>,
    frames: mpsc::Sender<BridgeFrame>,
    inner: Arc<BridgeInner>,
    max_frame_bytes: usize,
) {
    while let Some(raw) = incoming.recv().await {
        if raw.len() > max_frame_bytes {
            let _ = frames
                .send(BridgeFrame::ProtocolError(format!(
                    "Pi RPC frame exceeded {max_frame_bytes} bytes"
                )))
                .await;
            continue;
        }
        let parsed = match serde_json::from_slice::<Value>(&raw) {
            Ok(value) => value,
            Err(error) => {
                let _ = frames
                    .send(BridgeFrame::ProtocolError(format!(
                        "Invalid Pi RPC JSONL frame: {error}"
                    )))
                    .await;
                continue;
            }
        };
        if let Some(id) = parsed.get("id").and_then(Value::as_str) {
            if let Some(sender) = inner.pending.lock().await.remove(id) {
                let _ = sender.send(Ok(parsed));
                continue;
            }
        }
        let frame = if parsed
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.starts_with("extension_ui"))
        {
            BridgeFrame::ExtensionUi(parsed)
        } else {
            BridgeFrame::Event(parsed)
        };
        let _ = frames.send(frame).await;
    }

    for (_, sender) in inner.pending.lock().await.drain() {
        let _ = sender.send(Err(BridgeError::ProcessClosed));
    }
}

#[cfg(test)]
impl InMemoryPiProcess {
    pub(crate) async fn read_request(&mut self) -> Option<Value> {
        self.outbound.recv().await
    }

    pub(crate) fn try_read_request(&mut self) -> Option<Value> {
        self.outbound.try_recv().ok()
    }

    pub(crate) async fn write_frame(&mut self, value: Value) -> Result<(), BridgeError> {
        self.write_raw(format!("{}\n", value)).await
    }

    async fn write_raw(&mut self, raw: String) -> Result<(), BridgeError> {
        self.incoming
            .as_ref()
            .ok_or(BridgeError::ProcessClosed)?
            .send(raw.trim_end_matches('\n').as_bytes().to_vec())
            .await
            .map_err(|_| BridgeError::ProcessClosed)
    }

    async fn close(&mut self) {
        self.incoming.take();
    }
}

#[cfg(test)]
mod tests {
    use super::{BridgeFrame, PiRpcBridge};
    use serde_json::json;
    #[cfg(unix)]
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[tokio::test]
    async fn correlates_responses_and_surfaces_events() {
        let (bridge, mut process) = PiRpcBridge::in_memory(1024);

        let request = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .request(json!({ "type": "get_state" }), Duration::from_secs(1))
                    .await
            }
        });

        let outbound = process.read_request().await.expect("request frame");
        assert_eq!(outbound["type"], "get_state");
        let id = outbound["id"].as_str().expect("native request id");

        process
            .write_frame(json!({ "id": id, "type": "response", "success": true }))
            .await
            .expect("response frame");
        assert_eq!(request.await.unwrap().unwrap()["success"], true);

        process
            .write_frame(json!({ "type": "agent_start" }))
            .await
            .expect("event frame");
        assert_eq!(
            bridge.next_frame().await,
            Some(BridgeFrame::Event(json!({ "type": "agent_start" })))
        );
    }

    #[tokio::test]
    async fn rejects_oversized_frames_and_pending_requests_on_exit() {
        let (bridge, mut process) = PiRpcBridge::in_memory(32);
        let request = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .request(json!({ "type": "get_state" }), Duration::from_secs(1))
                    .await
            }
        });

        process.read_request().await.expect("request frame");
        process
            .write_raw(format!("{{\"value\":\"{}\"}}\n", "x".repeat(64)))
            .await
            .expect("oversized frame");

        assert!(matches!(
            bridge.next_frame().await,
            Some(BridgeFrame::ProtocolError(_))
        ));
        process.close().await;
        assert!(request.await.unwrap().unwrap_err().is_process_closed());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn attaches_to_a_real_jsonl_subprocess() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("IFS= read -r line; printf '%s\\n' '{\"id\":\"picot-1\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true}'")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().unwrap();
        let (bridge, mut process) = PiRpcBridge::attach(child, 1024).unwrap();

        let response = bridge
            .request(json!({ "type": "get_state" }), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(response["command"], "get_state");
        assert!(process.wait().unwrap().success());
    }
}
