#![cfg_attr(not(test), allow(dead_code))]

use crate::metadata_store::MetadataStore;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;
use uuid::Uuid;

const PAIRING_LIFETIME_SECONDS: u64 = 5 * 60;
pub const DEVICE_REQUEST_LIFETIME_SECONDS: u64 = 5 * 60;
pub const MAX_DEVICE_REQUESTS: usize = 64;
pub const MAX_DEVICE_ID_BYTES: usize = 128;
pub const MAX_DEVICE_NAME_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub token: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingError {
    InvalidOrUsed,
    Expired,
    Storage(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRequestCreated {
    pub request_id: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRequestInfo {
    pub request_id: String,
    pub device_name: String,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceRequestError {
    Invalid,
    Capacity,
    RateLimited,
    NotFound,
    Expired,
    WrongSecret,
    WrongDevice,
    Denied,
    Storage(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceClaim {
    Pending,
    Approved(String),
}

#[derive(Debug, Clone)]
enum Decision {
    Pending,
    Approved,
    Denied,
}

#[derive(Debug, Clone)]
struct PendingDeviceRequest {
    device_id: String,
    device_name: String,
    claim_hash: Vec<u8>,
    created_at: u64,
    expires_at: u64,
    decision: Decision,
}

pub struct RemoteAuth {
    store: Arc<Mutex<MetadataStore>>,
    pending: HashMap<Vec<u8>, u64>,
    device_requests: HashMap<String, PendingDeviceRequest>,
    create_attempts: VecDeque<u64>,
}

impl RemoteAuth {
    pub fn new(store: Arc<Mutex<MetadataStore>>) -> Self {
        Self {
            store,
            pending: HashMap::new(),
            device_requests: HashMap::new(),
            create_attempts: VecDeque::new(),
        }
    }

    /// Resolve (or mint) the stable workspace id for a project path. Shares the
    /// same metadata store that native windows use, so LAN/mobile clients get
    /// the identical workspace id and can reuse any live runtime instead of
    /// spawning a duplicate for the same session file.
    pub fn resolve_workspace(&self, path: &Path) -> Result<String, String> {
        self.store
            .lock()
            .map_err(|_| "metadata store poisoned".to_string())?
            .workspace_id_for_path(path)
    }

    pub fn create_pairing(&mut self, now: u64) -> Pairing {
        self.pending.retain(|_, expires_at| *expires_at > now);
        let token = format!("picot_pair_{}", Uuid::new_v4().simple());
        let expires_at = now + PAIRING_LIFETIME_SECONDS;
        self.pending.insert(hash(&token), expires_at);
        Pairing { token, expires_at }
    }

    pub fn exchange(
        &mut self,
        pairing_token: &str,
        device_id: &str,
        now: u64,
    ) -> Result<String, PairingError> {
        let token_hash = hash(pairing_token);
        let expires_at = self
            .pending
            .remove(&token_hash)
            .ok_or(PairingError::InvalidOrUsed)?;
        if now > expires_at {
            return Err(PairingError::Expired);
        }
        let device_token = new_device_token();
        self.store
            .lock()
            .map_err(|_| PairingError::Storage("metadata store poisoned".into()))?
            .store_device_token(device_id, &device_token)
            .map_err(PairingError::Storage)?;
        Ok(device_token)
    }

    pub fn create_device_request(
        &mut self,
        device_id: &str,
        device_name: &str,
        claim_secret: &str,
        now: u64,
    ) -> Result<DeviceRequestCreated, DeviceRequestError> {
        validate_device_request_fields(device_id, device_name, claim_secret)?;
        self.expire_device_requests(now);
        while self
            .create_attempts
            .front()
            .is_some_and(|at| *at + 60 <= now)
        {
            self.create_attempts.pop_front();
        }
        if self.create_attempts.len() >= 20 {
            return Err(DeviceRequestError::RateLimited);
        }
        self.create_attempts.push_back(now);
        self.device_requests
            .retain(|_, request| request.device_id != device_id);
        if self.device_requests.len() >= MAX_DEVICE_REQUESTS {
            return Err(DeviceRequestError::Capacity);
        }
        let request_id = format!("request-{}", Uuid::new_v4().simple());
        self.device_requests.insert(
            request_id.clone(),
            PendingDeviceRequest {
                device_id: device_id.to_string(),
                device_name: device_name.to_string(),
                claim_hash: hash(claim_secret),
                created_at: now,
                expires_at: now + DEVICE_REQUEST_LIFETIME_SECONDS,
                decision: Decision::Pending,
            },
        );
        Ok(DeviceRequestCreated {
            request_id,
            expires_at: now + DEVICE_REQUEST_LIFETIME_SECONDS,
        })
    }

    pub fn list_device_requests(&mut self, now: u64) -> Vec<DeviceRequestInfo> {
        self.expire_device_requests(now);
        self.device_requests
            .iter()
            .filter_map(|(request_id, request)| {
                if !matches!(request.decision, Decision::Pending) {
                    return None;
                }
                Some(DeviceRequestInfo {
                    request_id: request_id.clone(),
                    device_name: request.device_name.clone(),
                    created_at: request.created_at,
                    expires_at: request.expires_at,
                })
            })
            .collect()
    }

    pub fn decide_device_request(
        &mut self,
        request_id: &str,
        approve: bool,
        now: u64,
    ) -> Result<(), DeviceRequestError> {
        let request = self
            .device_requests
            .get_mut(request_id)
            .ok_or(DeviceRequestError::NotFound)?;
        if now >= request.expires_at {
            return Err(DeviceRequestError::Expired);
        }
        match request.decision {
            Decision::Pending => {
                request.decision = if approve {
                    Decision::Approved
                } else {
                    Decision::Denied
                };
                Ok(())
            }
            Decision::Approved if approve => Ok(()),
            Decision::Denied if !approve => Ok(()),
            Decision::Approved | Decision::Denied => {
                Err(if matches!(request.decision, Decision::Denied) {
                    DeviceRequestError::Denied
                } else {
                    DeviceRequestError::NotFound
                })
            }
        }
    }

    pub fn claim_device_request(
        &mut self,
        request_id: &str,
        device_id: &str,
        claim_secret: &str,
        now: u64,
    ) -> Result<DeviceClaim, DeviceRequestError> {
        validate_device_request_fields(device_id, "valid", claim_secret)
            .map_err(|_| DeviceRequestError::Invalid)?;
        let request = self
            .device_requests
            .get(request_id)
            .ok_or(DeviceRequestError::NotFound)?;
        if now >= request.expires_at {
            self.device_requests.remove(request_id);
            return Err(DeviceRequestError::Expired);
        }
        if request.device_id != device_id {
            return Err(DeviceRequestError::WrongDevice);
        }
        if request
            .claim_hash
            .as_slice()
            .ct_eq(hash(claim_secret).as_slice())
            .unwrap_u8()
            != 1
        {
            return Err(DeviceRequestError::WrongSecret);
        }
        match request.decision {
            Decision::Pending => Ok(DeviceClaim::Pending),
            Decision::Denied => Err(DeviceRequestError::Denied),
            Decision::Approved => {
                let device_token = new_device_token();
                self.store
                    .lock()
                    .map_err(|_| DeviceRequestError::Storage("metadata store poisoned".into()))?
                    .store_device_token(device_id, &device_token)
                    .map_err(DeviceRequestError::Storage)?;
                self.device_requests.remove(request_id);
                Ok(DeviceClaim::Approved(device_token))
            }
        }
    }

    fn expire_device_requests(&mut self, now: u64) {
        self.device_requests
            .retain(|_, request| request.expires_at > now);
    }

    pub fn authorize(&self, device_token: &str) -> Result<bool, String> {
        self.store
            .lock()
            .map_err(|_| "metadata store poisoned".to_string())?
            .verify_device_token(device_token)
    }

    #[allow(dead_code)]
    pub fn revoke(&mut self, device_id: &str) -> Result<(), String> {
        self.store
            .lock()
            .map_err(|_| "metadata store poisoned".to_string())?
            .revoke_device(device_id)
    }
}

fn validate_device_request_fields(
    device_id: &str,
    device_name: &str,
    claim_secret: &str,
) -> Result<(), DeviceRequestError> {
    if device_id.is_empty()
        || device_id.len() > MAX_DEVICE_ID_BYTES
        || !device_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || device_name.is_empty()
        || device_name.chars().count() > MAX_DEVICE_NAME_CHARS
        || device_name.chars().any(|ch| ch.is_control())
        || claim_secret.len() != 64
        || !claim_secret
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(DeviceRequestError::Invalid);
    }
    Ok(())
}

fn new_device_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("picot_device_{}", hex::encode(bytes))
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::{DeviceClaim, DeviceRequestError, PairingError, RemoteAuth};
    use crate::metadata_store::MetadataStore;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn auth() -> (RemoteAuth, std::path::PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-remote-auth-{nonce}"));
        fs::create_dir_all(&temp).unwrap();
        let store = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        (RemoteAuth::new(Arc::new(Mutex::new(store))), temp)
    }

    #[test]
    fn exchanges_a_five_minute_single_use_pairing_token_for_a_device_token() {
        let (mut auth, temp) = auth();
        let pairing = auth.create_pairing(1_000);
        assert_eq!(pairing.expires_at, 1_300);
        let device_token = auth.exchange(&pairing.token, "phone", 1_001).unwrap();
        assert!(auth.authorize(&device_token).unwrap());
        assert_eq!(
            auth.exchange(&pairing.token, "second-phone", 1_002),
            Err(PairingError::InvalidOrUsed)
        );
        assert!(
            !String::from_utf8_lossy(&fs::read(temp.join("picot.sqlite3")).unwrap())
                .contains(&device_token)
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn device_requests_are_approved_and_claimed_once() {
        let (mut auth, temp) = auth();
        let created = auth
            .create_device_request("device-phone", "Phone", &"a".repeat(64), 10)
            .unwrap();
        assert!(auth
            .list_device_requests(10)
            .iter()
            .any(|r| r.request_id == created.request_id));
        assert_eq!(
            auth.claim_device_request(&created.request_id, "device-phone", &"a".repeat(64), 11),
            Ok(DeviceClaim::Pending)
        );
        auth.decide_device_request(&created.request_id, true, 12)
            .unwrap();
        let token = match auth
            .claim_device_request(&created.request_id, "device-phone", &"a".repeat(64), 13)
            .unwrap()
        {
            DeviceClaim::Approved(token) => token,
            _ => panic!(),
        };
        assert!(auth.authorize(&token).unwrap());
        assert_eq!(
            auth.claim_device_request(&created.request_id, "device-phone", &"a".repeat(64), 14),
            Err(DeviceRequestError::NotFound)
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn validates_secret_shape_device_fields_and_wrong_proofs() {
        let (mut auth, temp) = auth();
        assert_eq!(
            auth.create_device_request("device-phone", "Phone", &"A".repeat(64), 1),
            Err(DeviceRequestError::Invalid)
        );
        assert_eq!(
            auth.create_device_request("device phone", "Phone", &"a".repeat(64), 1),
            Err(DeviceRequestError::Invalid)
        );
        assert_eq!(
            auth.create_device_request("device-phone", "", &"a".repeat(64), 1),
            Err(DeviceRequestError::Invalid)
        );
        assert_eq!(
            auth.create_device_request("d".repeat(129).as_str(), "Phone", &"a".repeat(64), 1),
            Err(DeviceRequestError::Invalid)
        );
        assert_eq!(
            auth.create_device_request("device-phone", &"N".repeat(129), &"a".repeat(64), 1),
            Err(DeviceRequestError::Invalid)
        );
        assert!(auth
            .create_device_request("device-unicode", &"📱".repeat(128), &"a".repeat(64), 1)
            .is_ok());
        let request = auth
            .create_device_request("device-phone", "Phone", &"a".repeat(64), 2)
            .unwrap();
        assert_eq!(
            auth.claim_device_request(&request.request_id, "other-device", &"a".repeat(64), 3),
            Err(DeviceRequestError::WrongDevice)
        );
        assert_eq!(
            auth.claim_device_request(&request.request_id, "device-phone", &"b".repeat(64), 3),
            Err(DeviceRequestError::WrongSecret)
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn bounds_pending_requests_and_replaces_same_device() {
        let (mut replacement_auth, temp) = auth();
        let first = replacement_auth
            .create_device_request("replace-me", "Phone", &"a".repeat(64), 0)
            .unwrap();
        let replacement = replacement_auth
            .create_device_request("replace-me", "Phone", &"b".repeat(64), 1)
            .unwrap();
        assert_ne!(first.request_id, replacement.request_id);
        assert_eq!(replacement_auth.list_device_requests(1).len(), 1);
        fs::remove_dir_all(temp).unwrap();

        let (mut capacity_auth, capacity_temp) = auth();
        for batch in 0..4 {
            for index in 0..16 {
                let id = format!("device-{batch}-{index}");
                capacity_auth
                    .create_device_request(&id, "Phone", &"a".repeat(64), batch * 61)
                    .unwrap();
            }
        }
        assert_eq!(capacity_auth.list_device_requests(183).len(), 64);
        assert_eq!(
            capacity_auth.create_device_request("overflow", "Phone", &"a".repeat(64), 183),
            Err(DeviceRequestError::Capacity)
        );
        fs::remove_dir_all(capacity_temp).unwrap();
    }

    #[test]
    fn decisions_are_first_terminal_wins_and_expiry_is_inclusive() {
        let (mut auth, temp) = auth();
        let request = auth
            .create_device_request("device-phone", "Phone", &"a".repeat(64), 10)
            .unwrap();
        auth.decide_device_request(&request.request_id, false, 11)
            .unwrap();
        assert!(auth
            .decide_device_request(&request.request_id, false, 12)
            .is_ok());
        assert_eq!(
            auth.decide_device_request(&request.request_id, true, 12),
            Err(DeviceRequestError::Denied)
        );
        assert_eq!(
            auth.claim_device_request(&request.request_id, "device-phone", &"a".repeat(64), 12),
            Err(DeviceRequestError::Denied)
        );
        let expired = auth
            .create_device_request("device-other", "Phone", &"a".repeat(64), 20)
            .unwrap();
        assert_eq!(
            auth.claim_device_request(&expired.request_id, "device-other", &"a".repeat(64), 320),
            Err(DeviceRequestError::Expired)
        );
        fs::remove_dir_all(temp).unwrap();
    }
}
