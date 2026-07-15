#![cfg_attr(not(test), allow(dead_code))]

use crate::metadata_store::MetadataStore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

const PAIRING_LIFETIME_SECONDS: u64 = 5 * 60;

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

pub struct RemoteAuth {
    store: MetadataStore,
    pending: HashMap<Vec<u8>, u64>,
}

impl RemoteAuth {
    pub fn new(store: MetadataStore) -> Self {
        Self {
            store,
            pending: HashMap::new(),
        }
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
        let device_token = format!(
            "picot_device_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        self.store
            .store_device_token(device_id, &device_token)
            .map_err(PairingError::Storage)?;
        Ok(device_token)
    }

    pub fn authorize(&self, device_token: &str) -> Result<bool, String> {
        self.store.verify_device_token(device_token)
    }

    pub fn revoke(&mut self, device_id: &str) -> Result<(), String> {
        self.store.revoke_device(device_id)
    }
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::{PairingError, RemoteAuth};
    use crate::metadata_store::MetadataStore;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn auth() -> (RemoteAuth, std::path::PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-remote-auth-{nonce}"));
        fs::create_dir_all(&temp).unwrap();
        let store = MetadataStore::open(&temp.join("picot.sqlite3")).unwrap();
        (RemoteAuth::new(store), temp)
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
    fn rejects_expired_pairing_tokens_and_supports_device_revocation() {
        let (mut auth, temp) = auth();
        let expired = auth.create_pairing(2_000);
        assert_eq!(
            auth.exchange(&expired.token, "phone", 2_301),
            Err(PairingError::Expired)
        );

        let pairing = auth.create_pairing(3_000);
        let token = auth.exchange(&pairing.token, "phone", 3_001).unwrap();
        auth.revoke("phone").unwrap();
        assert!(!auth.authorize(&token).unwrap());
        fs::remove_dir_all(temp).unwrap();
    }
}
