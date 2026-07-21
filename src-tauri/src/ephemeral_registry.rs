// ABOUTME: Owns in-memory ephemeral chat records per window owner: quotas, state
// ABOUTME: transitions, generation-checked create/replace/close, and redacted descriptors.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;

use crate::window_owner::OwnerId;

const SIDE_CHAT_QUOTA: usize = 5;
const INSTANCE_ID_BYTES: usize = 12;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EphemeralKind {
    SideChat,
    QuickChat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum EphemeralState {
    Creating,
    Ready,
    Streaming,
    Replacing,
    Closing,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralDescriptor {
    pub instance_id: String,
    pub generation: u64,
    pub kind: EphemeralKind,
    pub state: EphemeralState,
    pub title: Option<String>,
    pub unread: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateReservation {
    pub owner_id: OwnerId,
    pub instance_id: String,
    pub generation: u64,
    pub kind: EphemeralKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedProcess {
    pub port: u16,
    pub pid: u32,
    pub child_identity: u64,
    pub canonical_cwd: PathBuf,
    pub transition_generation: u64,
    pub temporary_directory: Option<(PathBuf, String)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplacementReservation {
    pub old_instance: Option<(String, u64)>,
    pub candidate: CreateReservation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupLease {
    pub owner_id: OwnerId,
    pub instance_id: String,
    pub generation: u64,
    pub port: u16,
    pub pid: u32,
    pub child_identity: u64,
    pub transition_generation: u64,
    pub temporary_directory: Option<(PathBuf, String)>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EphemeralUiPatch {
    pub title: Option<String>,
    pub unread: Option<bool>,
}

#[derive(Clone, Default)]
pub struct EphemeralRegistry {
    inner: Arc<Mutex<HashMap<OwnerId, OwnerPartition>>>,
}

#[derive(Default)]
struct OwnerPartition {
    side: Vec<Record>,
    quick: Vec<Record>,
    next_generation: u64,
    next_creation_order: u64,
}

struct Record {
    instance_id: String,
    generation: u64,
    kind: EphemeralKind,
    state: EphemeralState,
    port: u16,
    pid: u32,
    child_identity: u64,
    canonical_cwd: PathBuf,
    transition_generation: u64,
    temporary_directory: Option<(PathBuf, String)>,
    title: Option<String>,
    unread: bool,
    creation_order: u64,
}

impl Record {
    fn descriptor(&self) -> EphemeralDescriptor {
        EphemeralDescriptor {
            instance_id: self.instance_id.clone(),
            generation: self.generation,
            kind: self.kind,
            state: self.state,
            title: self.title.clone(),
            unread: self.unread,
        }
    }

    fn lease(&self, owner_id: OwnerId) -> CleanupLease {
        CleanupLease {
            owner_id,
            instance_id: self.instance_id.clone(),
            generation: self.generation,
            port: self.port,
            pid: self.pid,
            child_identity: self.child_identity,
            transition_generation: self.transition_generation,
            temporary_directory: self.temporary_directory.clone(),
        }
    }
}

impl OwnerPartition {
    fn allocate_generation(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }

    fn allocate_creation_order(&mut self) -> u64 {
        let order = self.next_creation_order;
        self.next_creation_order += 1;
        order
    }

    fn find_record_mut(&mut self, id: &str, generation: u64) -> Option<&mut Record> {
        self.side
            .iter_mut()
            .chain(self.quick.iter_mut())
            .find(|r| r.instance_id == id && r.generation == generation)
    }

    fn find_record(&self, id: &str, generation: u64) -> Option<&Record> {
        self.side
            .iter()
            .chain(self.quick.iter())
            .find(|r| r.instance_id == id && r.generation == generation)
    }

    fn all_records_mut(&mut self) -> impl Iterator<Item = &mut Record> {
        self.side.iter_mut().chain(self.quick.iter_mut())
    }

    /// True when any quick record is mid-creation (an in-flight replacement candidate).
    fn quick_candidate_in_progress(&self) -> bool {
        self.quick
            .iter()
            .any(|r| r.state == EphemeralState::Creating)
    }
}

impl EphemeralRegistry {
    pub fn reserve_create(
        &self,
        owner: &OwnerId,
        kind: EphemeralKind,
    ) -> Result<CreateReservation, String> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let partition = state.entry(owner.clone()).or_default();
        match kind {
            EphemeralKind::SideChat => {
                if partition.side.len() >= SIDE_CHAT_QUOTA {
                    return Err("side chat quota reached".to_string());
                }
            }
            EphemeralKind::QuickChat => {
                if !partition.quick.is_empty() {
                    return Err("quick chat already exists".to_string());
                }
            }
        }
        let instance_id = fresh_instance_id();
        let generation = partition.allocate_generation();
        let creation_order = partition.allocate_creation_order();
        partition.side_or_quick_mut(kind).push(Record {
            instance_id: instance_id.clone(),
            generation,
            kind,
            state: EphemeralState::Creating,
            port: 0,
            pid: 0,
            child_identity: 0,
            canonical_cwd: PathBuf::new(),
            transition_generation: 0,
            temporary_directory: None,
            title: None,
            unread: false,
            creation_order,
        });
        Ok(CreateReservation {
            owner_id: owner.clone(),
            instance_id,
            generation,
            kind,
        })
    }

    pub fn commit_ready(
        &self,
        reservation: &CreateReservation,
        process: OwnedProcess,
    ) -> Result<EphemeralDescriptor, String> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let Some(partition) = state.get_mut(&reservation.owner_id) else {
            return Err("unknown owner".to_string());
        };
        let record = partition
            .find_record_mut(&reservation.instance_id, reservation.generation)
            .ok_or_else(|| "stale reservation".to_string())?;
        if record.state != EphemeralState::Creating {
            return Err("reservation is not in the creating state".to_string());
        }
        record.state = EphemeralState::Ready;
        record.port = process.port;
        record.pid = process.pid;
        record.child_identity = process.child_identity;
        record.canonical_cwd = process.canonical_cwd;
        record.transition_generation = process.transition_generation;
        record.temporary_directory = process.temporary_directory;
        Ok(record.descriptor())
    }

    pub fn reserve_quick_replacement(
        &self,
        owner: &OwnerId,
    ) -> Result<ReplacementReservation, String> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let partition = state.entry(owner.clone()).or_default();
        if partition.quick_candidate_in_progress() {
            return Err("a quick chat replacement is already in progress".to_string());
        }
        if partition.quick.len() != 1 {
            return Err("no quick chat to replace".to_string());
        }
        let old_identity = {
            let old = &mut partition.quick[0];
            if matches!(old.state, EphemeralState::Closing) {
                return Err("quick chat is already closing".to_string());
            }
            let identity = (old.instance_id.clone(), old.generation);
            old.state = EphemeralState::Replacing;
            identity
        };

        let instance_id = fresh_instance_id();
        let generation = partition.allocate_generation();
        let creation_order = partition.allocate_creation_order();
        partition.quick.push(Record {
            instance_id: instance_id.clone(),
            generation,
            kind: EphemeralKind::QuickChat,
            state: EphemeralState::Creating,
            port: 0,
            pid: 0,
            child_identity: 0,
            canonical_cwd: PathBuf::new(),
            transition_generation: 0,
            temporary_directory: None,
            title: None,
            unread: false,
            creation_order,
        });
        Ok(ReplacementReservation {
            old_instance: Some(old_identity),
            candidate: CreateReservation {
                owner_id: owner.clone(),
                instance_id,
                generation,
                kind: EphemeralKind::QuickChat,
            },
        })
    }

    pub fn begin_close(
        &self,
        owner: &OwnerId,
        id: &str,
        generation: u64,
    ) -> Result<Option<CleanupLease>, String> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let Some(partition) = state.get_mut(owner) else {
            return Ok(None);
        };

        // Cancelling an in-flight quick replacement candidate restores the old chat.
        let candidate_index = partition.quick.iter().position(|r| {
            r.instance_id == id && r.generation == generation && r.state == EphemeralState::Creating
        });
        if let Some(idx) = candidate_index {
            let removed = partition.quick.remove(idx);
            // Revert the remaining live quick record out of the replacing state.
            if let Some(live) = partition
                .quick
                .iter_mut()
                .find(|r| r.state == EphemeralState::Replacing)
            {
                live.state = EphemeralState::Ready;
            }
            return Ok(Some(removed.lease(owner.clone())));
        }

        let Some(record) = partition.find_record_mut(id, generation) else {
            return Ok(None);
        };
        if record.state == EphemeralState::Closing {
            return Ok(None);
        }
        if record.state == EphemeralState::Creating {
            // Uncommitted reservation cancelled before spawn/health: remove immediately.
            let lease = record.lease(owner.clone());
            let _ = partition.remove_record(id, generation);
            return Ok(Some(lease));
        }
        record.state = EphemeralState::Closing;
        Ok(Some(record.lease(owner.clone())))
    }

    pub fn finish_cleanup(&self, lease: &CleanupLease) {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let Some(partition) = state.get_mut(&lease.owner_id) else {
            return;
        };
        let Some(record) = partition.find_record(&lease.instance_id, lease.generation) else {
            return;
        };
        // Match owner, instance, generation, port, and ownership token before removing.
        if record.port != lease.port {
            return;
        }
        if !temp_token_matches(&record.temporary_directory, &lease.temporary_directory) {
            return;
        }
        partition.remove_record(&lease.instance_id, lease.generation);
    }

    pub fn descriptors(&self, owner: &OwnerId) -> Vec<EphemeralDescriptor> {
        let state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let Some(partition) = state.get(owner) else {
            return Vec::new();
        };
        let mut records: Vec<&Record> = partition
            .side
            .iter()
            .chain(partition.quick.iter())
            .collect();
        records.sort_by_key(|r| r.creation_order);
        records.iter().map(|r| r.descriptor()).collect()
    }

    /// Mark the exact record for a naturally exited child as closing and return
    /// its cleanup lease. A stale port or pid cannot affect a newer record.
    pub fn process_exit_cleanup(
        &self,
        port: u16,
        pid: u32,
        child_identity: u64,
    ) -> Option<CleanupLease> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        for (owner, partition) in state.iter_mut() {
            for record in partition.all_records_mut() {
                if record.port == port
                    && record.pid == pid
                    && record.child_identity == child_identity
                {
                    if record.state == EphemeralState::Closing {
                        return None;
                    }
                    record.state = EphemeralState::Closing;
                    return Some(record.lease(owner.clone()));
                }
            }
        }
        None
    }

    pub fn owner_cleanup(&self, owner: &OwnerId) -> Vec<CleanupLease> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let Some(partition) = state.get_mut(owner) else {
            return Vec::new();
        };
        let mut leases = Vec::new();
        for record in partition.all_records_mut() {
            if record.state != EphemeralState::Closing {
                record.state = EphemeralState::Closing;
            }
            leases.push(record.lease(owner.clone()));
        }
        leases
    }

    pub fn side_chat_cleanup_for_transition(
        &self,
        owner: &OwnerId,
        transition_generation: u64,
    ) -> Vec<CleanupLease> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let Some(partition) = state.get_mut(owner) else {
            return Vec::new();
        };
        let mut leases = Vec::new();
        for record in partition.side.iter_mut() {
            if record.transition_generation < transition_generation
                && record.state != EphemeralState::Closing
            {
                record.state = EphemeralState::Closing;
                leases.push(record.lease(owner.clone()));
            }
        }
        leases
    }

    /// Validate (owner, instance, generation) against the live record before
    /// mutating owner-scoped UI metadata. A mismatched request cannot mutate
    /// another owner's instance.
    pub fn update_ui_metadata(
        &self,
        owner: &OwnerId,
        instance_id: &str,
        generation: u64,
        patch: EphemeralUiPatch,
    ) -> Result<(), String> {
        let mut state = self.inner.lock().expect("ephemeral registry lock poisoned");
        let Some(partition) = state.get_mut(owner) else {
            return Err("unknown owner".to_string());
        };
        let record = partition
            .find_record_mut(instance_id, generation)
            .ok_or_else(|| "unknown ephemeral instance".to_string())?;
        if let Some(title) = patch.title {
            record.title = Some(title);
        }
        if let Some(unread) = patch.unread {
            record.unread = unread;
        }
        Ok(())
    }
}

impl OwnerPartition {
    fn side_or_quick_mut(&mut self, kind: EphemeralKind) -> &mut Vec<Record> {
        match kind {
            EphemeralKind::SideChat => &mut self.side,
            EphemeralKind::QuickChat => &mut self.quick,
        }
    }

    fn remove_record(&mut self, id: &str, generation: u64) -> bool {
        let was_in_side = self
            .side
            .iter()
            .position(|r| r.instance_id == id && r.generation == generation);
        if let Some(idx) = was_in_side {
            self.side.remove(idx);
            return true;
        }
        let was_in_quick = self
            .quick
            .iter()
            .position(|r| r.instance_id == id && r.generation == generation);
        if let Some(idx) = was_in_quick {
            self.quick.remove(idx);
            return true;
        }
        false
    }
}

fn fresh_instance_id() -> String {
    let mut bytes = [0u8; INSTANCE_ID_BYTES];
    OsRng.fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn temp_token_matches(
    record: &Option<(PathBuf, String)>,
    lease: &Option<(PathBuf, String)>,
) -> bool {
    match (record, lease) {
        (None, None) => true,
        (Some((_, a)), Some((_, b))) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_owner::WindowOwnerRegistry;

    fn owner(name: &str) -> OwnerId {
        let reg = WindowOwnerRegistry::default();
        reg.create_owner(
            name.to_string(),
            PathBuf::from("/ws"),
            4001,
            "http://127.0.0.1:4001".to_string(),
        )
        .expect("owner")
        .0
    }

    fn process_for(_reservation: &CreateReservation, port: u16) -> OwnedProcess {
        OwnedProcess {
            port,
            pid: 10_000 + port as u32,
            child_identity: port as u64,
            canonical_cwd: PathBuf::from("/ws"),
            transition_generation: 1,
            temporary_directory: None,
        }
    }

    fn commit(reg: &EphemeralRegistry, reservation: &CreateReservation, port: u16) {
        commit_with_identity(reg, reservation, port, port as u64);
    }

    fn commit_with_identity(
        reg: &EphemeralRegistry,
        reservation: &CreateReservation,
        port: u16,
        child_identity: u64,
    ) {
        reg.commit_ready(
            reservation,
            OwnedProcess {
                port,
                pid: 10_000 + port as u32,
                child_identity,
                canonical_cwd: PathBuf::from("/ws"),
                transition_generation: 1,
                temporary_directory: None,
            },
        )
        .expect("commit_ready");
    }

    #[test]
    fn enforces_side_chat_quota_of_five() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        for _ in 0..SIDE_CHAT_QUOTA {
            reg.reserve_create(&owner, EphemeralKind::SideChat)
                .expect("five side chats allowed");
        }
        assert!(reg.reserve_create(&owner, EphemeralKind::SideChat).is_err());
    }

    #[test]
    fn enforces_single_quick_chat_quota() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        reg.reserve_create(&owner, EphemeralKind::QuickChat)
            .expect("first quick chat");
        assert!(reg
            .reserve_create(&owner, EphemeralKind::QuickChat)
            .is_err());
    }

    #[test]
    fn reserve_spawn_commit_moves_to_ready() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let reservation = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        let descriptor = reg
            .commit_ready(&reservation, process_for(&reservation, 5100))
            .unwrap();
        assert_eq!(descriptor.state, EphemeralState::Ready);
        assert_eq!(descriptor.kind, EphemeralKind::SideChat);
    }

    #[test]
    fn stale_generation_commit_is_rejected() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let mut reservation = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        reservation.generation = 999; // stale
        assert!(reg
            .commit_ready(&reservation, process_for(&reservation, 5100))
            .is_err());
    }

    #[test]
    fn begin_close_for_unknown_instance_is_idempotent_none() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        assert_eq!(reg.begin_close(&owner, "missing", 1).unwrap(), None);
    }

    #[test]
    fn duplicate_close_is_idempotent() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let reservation = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &reservation, 5100);
        let lease = reg
            .begin_close(&owner, &reservation.instance_id, reservation.generation)
            .unwrap()
            .expect("first close leases");
        // Second close before cleanup returns None.
        assert_eq!(
            reg.begin_close(&owner, &reservation.instance_id, reservation.generation)
                .unwrap(),
            None
        );
        reg.finish_cleanup(&lease);
        assert!(reg.descriptors(&owner).is_empty());
        // After cleanup, another close is still None.
        assert_eq!(
            reg.begin_close(&owner, &reservation.instance_id, reservation.generation)
                .unwrap(),
            None
        );
    }

    #[test]
    fn candidate_failure_preserves_old_quick_chat() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let old = reg
            .reserve_create(&owner, EphemeralKind::QuickChat)
            .unwrap();
        commit(&reg, &old, 5200);

        let replacement = reg.reserve_quick_replacement(&owner).unwrap();
        let candidate = &replacement.candidate;
        assert_eq!(
            replacement.old_instance,
            Some((old.instance_id.clone(), old.generation))
        );

        // Candidate spawn failed: cancel the candidate.
        let lease = reg
            .begin_close(&owner, &candidate.instance_id, candidate.generation)
            .unwrap()
            .expect("candidate cancel lease");
        reg.finish_cleanup(&lease);

        // The old quick chat is back to ready and still listed.
        let descriptors = reg.descriptors(&owner);
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].state, EphemeralState::Ready);
        assert_eq!(descriptors[0].instance_id, old.instance_id);
    }

    #[test]
    fn replacement_commit_then_old_cleanup_leaves_candidate() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let old = reg
            .reserve_create(&owner, EphemeralKind::QuickChat)
            .unwrap();
        commit(&reg, &old, 5200);

        let replacement = reg.reserve_quick_replacement(&owner).unwrap();
        let (old_id, old_gen) = replacement.old_instance.clone().unwrap();
        let candidate = replacement.candidate.clone();
        commit(&reg, &candidate, 5201);

        // No second replacement while old has not been cleaned up.
        assert!(reg.reserve_quick_replacement(&owner).is_err());

        let old_lease = reg
            .begin_close(&owner, &old_id, old_gen)
            .unwrap()
            .expect("old cleanup lease");
        reg.finish_cleanup(&old_lease);

        let descriptors = reg.descriptors(&owner);
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].instance_id, candidate.instance_id);
    }

    #[test]
    fn replacement_is_busy_until_resolved() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let old = reg
            .reserve_create(&owner, EphemeralKind::QuickChat)
            .unwrap();
        commit(&reg, &old, 5200);
        reg.reserve_quick_replacement(&owner)
            .expect("first replacement");
        assert!(reg.reserve_quick_replacement(&owner).is_err());
    }

    #[test]
    fn close_during_replacement_keeps_the_old_record_closing() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w-close-replace");
        let old = reg
            .reserve_create(&owner, EphemeralKind::QuickChat)
            .unwrap();
        commit(&reg, &old, 5200);
        let replacement = reg.reserve_quick_replacement(&owner).unwrap();

        let old_lease = reg
            .begin_close(&owner, &old.instance_id, old.generation)
            .unwrap()
            .expect("old close lease");
        let candidate_lease = reg
            .begin_close(
                &owner,
                &replacement.candidate.instance_id,
                replacement.candidate.generation,
            )
            .unwrap()
            .expect("candidate cancel lease");
        reg.finish_cleanup(&candidate_lease);

        let descriptors = reg.descriptors(&owner);
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].state, EphemeralState::Closing);
        reg.finish_cleanup(&old_lease);
        assert!(reg.descriptors(&owner).is_empty());
    }

    #[test]
    fn descriptors_are_redacted_and_in_creation_order() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let a = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &a, 5300);
        let b = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &b, 5301);
        let descriptors = reg.descriptors(&owner);
        assert_eq!(descriptors.len(), 2);
        assert_eq!(descriptors[0].instance_id, a.instance_id);
        assert_eq!(descriptors[1].instance_id, b.instance_id);
        // Descriptors expose no port, pid, cwd, or temporary paths.
        let serialized = serde_json::to_string(&descriptors).unwrap();
        assert!(!serialized.contains("5300"));
        assert!(!serialized.contains("5301"));
        assert!(!serialized.contains("/ws"));
        assert!(!serialized.contains("port"));
        assert!(!serialized.contains("pid"));
        assert!(!serialized.contains("cwd"));
        assert!(!serialized.contains("temporary"));
    }

    #[test]
    fn owner_cleanup_leases_every_record() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let side = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &side, 5400);
        let quick = reg
            .reserve_create(&owner, EphemeralKind::QuickChat)
            .unwrap();
        commit(&reg, &quick, 5401);
        let leases = reg.owner_cleanup(&owner);
        assert_eq!(leases.len(), 2);
        for lease in &leases {
            reg.finish_cleanup(lease);
        }
        assert!(reg.descriptors(&owner).is_empty());
    }

    #[test]
    fn side_chat_cleanup_for_transition_targets_old_workspace_only() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let old_side = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &old_side, 5500);
        // Bump the record's transition generation to simulate an older workspace binding.
        {
            let mut state = reg.inner.lock().unwrap();
            let partition = state.get_mut(&owner).unwrap();
            let record = partition
                .find_record_mut(&old_side.instance_id, old_side.generation)
                .unwrap();
            record.transition_generation = 1;
        }
        // A newer side chat created after the transition (transition_generation == 5).
        let new_side = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &new_side, 5501);
        {
            let mut state = reg.inner.lock().unwrap();
            let partition = state.get_mut(&owner).unwrap();
            let record = partition
                .find_record_mut(&new_side.instance_id, new_side.generation)
                .unwrap();
            record.transition_generation = 5;
        }

        let leases = reg.side_chat_cleanup_for_transition(&owner, 5);
        assert_eq!(leases.len(), 1);
        assert_eq!(leases[0].instance_id, old_side.instance_id);
        for lease in &leases {
            reg.finish_cleanup(lease);
        }
        let remaining = reg.descriptors(&owner);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].instance_id, new_side.instance_id);
    }

    #[test]
    fn process_exit_cleanup_matches_exact_child_identity() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w-exit");
        let reservation = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &reservation, 5800);

        let lease = reg
            .process_exit_cleanup(5800, 15_800, 5800)
            .expect("matching exit lease");
        assert_eq!(lease.instance_id, reservation.instance_id);
        assert_eq!(reg.process_exit_cleanup(5800, 15_800, 5800), None);
        reg.finish_cleanup(&lease);
        assert!(reg.descriptors(&owner).is_empty());

        let replacement = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit_with_identity(&reg, &replacement, 5800, 5801);
        assert_eq!(reg.process_exit_cleanup(5800, 15_800, 5800), None);
        assert_eq!(reg.descriptors(&owner).len(), 1);
    }

    #[test]
    fn finish_cleanup_rejects_stale_port() {
        let reg = EphemeralRegistry::default();
        let owner = owner("w1");
        let reservation = reg.reserve_create(&owner, EphemeralKind::SideChat).unwrap();
        commit(&reg, &reservation, 5600);
        let mut lease = reg
            .begin_close(&owner, &reservation.instance_id, reservation.generation)
            .unwrap()
            .unwrap();
        lease.port = 9999; // stale port
        reg.finish_cleanup(&lease);
        // Record remains because the port did not match.
        assert_eq!(reg.descriptors(&owner).len(), 1);
    }

    #[test]
    fn update_ui_metadata_validates_owner_instance_generation() {
        let reg = EphemeralRegistry::default();
        let owner_id = owner("w1");
        let other_id = owner("w2");
        let reservation = reg
            .reserve_create(&owner_id, EphemeralKind::SideChat)
            .unwrap();
        commit(&reg, &reservation, 5700);

        // Wrong owner cannot mutate.
        assert!(reg
            .update_ui_metadata(
                &other_id,
                &reservation.instance_id,
                reservation.generation,
                EphemeralUiPatch {
                    title: Some("evil".to_string()),
                    unread: None
                },
            )
            .is_err());
        // Wrong generation cannot mutate.
        assert!(reg
            .update_ui_metadata(
                &owner_id,
                &reservation.instance_id,
                reservation.generation + 1,
                EphemeralUiPatch::default(),
            )
            .is_err());

        // Correct identity updates title + unread, reflected in descriptors.
        reg.update_ui_metadata(
            &owner_id,
            &reservation.instance_id,
            reservation.generation,
            EphemeralUiPatch {
                title: Some("My Chat".to_string()),
                unread: Some(true),
            },
        )
        .unwrap();
        let descriptor = &reg.descriptors(&owner_id)[0];
        assert_eq!(descriptor.title.as_deref(), Some("My Chat"));
        assert!(descriptor.unread);
    }
}
