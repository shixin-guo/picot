#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTarget {
    pub workspace_id: String,
    pub session_id: String,
    pub instance_id: String,
}

impl RuntimeTarget {
    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
        instance_id: impl Into<String>,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            instance_id: instance_id.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, allow(dead_code))]
pub enum RuntimeState {
    Starting,
    Trusting,
    Ready,
    Working,
    Idle,
    Suspended,
    Crashed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationAcceptance {
    Accepted,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequencedEvent {
    pub target: RuntimeTarget,
    pub sequence: u64,
    pub event: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub target: RuntimeTarget,
    pub sequence: u64,
    pub state: RuntimeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinatorError {
    UnknownInstance,
    IdentityMismatch,
    DuplicateSession,
    InvalidState,
    ForbiddenIdentityReplacement,
    InvalidCommand,
    MissingIdempotencyKey,
}

struct RuntimeRecord {
    target: RuntimeTarget,
    state: RuntimeState,
    sequence: u64,
    mutations: VecDeque<MutationRecord>,
}

struct MutationRecord {
    key: String,
    result: Option<Value>,
}

pub struct RuntimeCoordinator {
    instances: HashMap<String, RuntimeRecord>,
    idempotency_capacity: usize,
}

impl RuntimeCoordinator {
    pub fn new(idempotency_capacity: usize) -> Self {
        Self {
            instances: HashMap::new(),
            idempotency_capacity: idempotency_capacity.max(1),
        }
    }

    pub fn register(
        &mut self,
        target: RuntimeTarget,
        state: RuntimeState,
    ) -> Result<(), CoordinatorError> {
        if self.instances.values().any(|record| {
            record.target.workspace_id == target.workspace_id
                && record.target.session_id == target.session_id
        }) {
            return Err(CoordinatorError::DuplicateSession);
        }
        if self.instances.contains_key(&target.instance_id) {
            return Err(CoordinatorError::IdentityMismatch);
        }
        self.instances.insert(
            target.instance_id.clone(),
            RuntimeRecord {
                target,
                state,
                sequence: 0,
                mutations: VecDeque::new(),
            },
        );
        Ok(())
    }

    pub fn validate(&self, target: &RuntimeTarget) -> Result<(), CoordinatorError> {
        let record = self
            .instances
            .get(&target.instance_id)
            .ok_or(CoordinatorError::UnknownInstance)?;
        if record.target != *target {
            return Err(CoordinatorError::IdentityMismatch);
        }
        Ok(())
    }

    pub fn validate_command(
        &self,
        target: &RuntimeTarget,
        command: &Value,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .ok_or(CoordinatorError::InvalidCommand)?;
        if matches!(command_type, "new_session" | "switch_session") {
            return Err(CoordinatorError::ForbiddenIdentityReplacement);
        }
        Ok(())
    }

    pub fn accept_mutation(
        &mut self,
        target: &RuntimeTarget,
        idempotency_key: &str,
    ) -> Result<MutationAcceptance, CoordinatorError> {
        self.validate(target)?;
        if idempotency_key.is_empty() {
            return Err(CoordinatorError::MissingIdempotencyKey);
        }
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        if record
            .mutations
            .iter()
            .any(|mutation| mutation.key == idempotency_key)
        {
            return Ok(MutationAcceptance::Duplicate);
        }
        record.mutations.push_back(MutationRecord {
            key: idempotency_key.to_owned(),
            result: None,
        });
        while record.mutations.len() > self.idempotency_capacity {
            record.mutations.pop_front();
        }
        Ok(MutationAcceptance::Accepted)
    }

    pub fn complete_mutation(
        &mut self,
        target: &RuntimeTarget,
        idempotency_key: &str,
        result: Value,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        let mutation = record
            .mutations
            .iter_mut()
            .find(|mutation| mutation.key == idempotency_key)
            .ok_or(CoordinatorError::MissingIdempotencyKey)?;
        mutation.result = Some(result);
        Ok(())
    }

    pub fn mutation_result(
        &self,
        target: &RuntimeTarget,
        idempotency_key: &str,
    ) -> Result<Option<Value>, CoordinatorError> {
        self.validate(target)?;
        Ok(self
            .instances
            .get(&target.instance_id)
            .unwrap()
            .mutations
            .iter()
            .find(|mutation| mutation.key == idempotency_key)
            .and_then(|mutation| mutation.result.clone()))
    }

    pub fn emit_event(
        &mut self,
        target: &RuntimeTarget,
        event: Value,
    ) -> Result<SequencedEvent, CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get_mut(&target.instance_id).unwrap();
        record.sequence += 1;
        Ok(SequencedEvent {
            target: target.clone(),
            sequence: record.sequence,
            event,
        })
    }

    pub fn snapshot(&self, target: &RuntimeTarget) -> Result<RuntimeSnapshot, CoordinatorError> {
        self.validate(target)?;
        let record = self.instances.get(&target.instance_id).unwrap();
        Ok(RuntimeSnapshot {
            target: record.target.clone(),
            sequence: record.sequence,
            state: record.state,
        })
    }

    pub fn set_state(
        &mut self,
        target: &RuntimeTarget,
        state: RuntimeState,
    ) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        self.instances.get_mut(&target.instance_id).unwrap().state = state;
        Ok(())
    }

    pub fn bind_session_id(
        &mut self,
        temporary: &RuntimeTarget,
        session_id: impl Into<String>,
    ) -> Result<RuntimeTarget, CoordinatorError> {
        self.validate(temporary)?;
        let session_id = session_id.into();
        if session_id.is_empty() {
            return Err(CoordinatorError::IdentityMismatch);
        }
        if self.instances.values().any(|record| {
            record.target.instance_id != temporary.instance_id
                && record.target.workspace_id == temporary.workspace_id
                && record.target.session_id == session_id
        }) {
            return Err(CoordinatorError::DuplicateSession);
        }
        let record = self.instances.get_mut(&temporary.instance_id).unwrap();
        record.target.session_id = session_id;
        Ok(record.target.clone())
    }

    pub fn unregister(&mut self, target: &RuntimeTarget) -> Result<(), CoordinatorError> {
        self.validate(target)?;
        self.instances.remove(&target.instance_id);
        Ok(())
    }

    pub fn resume(
        &mut self,
        suspended: &RuntimeTarget,
        new_instance_id: impl Into<String>,
    ) -> Result<RuntimeTarget, CoordinatorError> {
        self.validate(suspended)?;
        let record = self.instances.get(&suspended.instance_id).unwrap();
        if record.state != RuntimeState::Suspended {
            return Err(CoordinatorError::InvalidState);
        }
        let new_target = RuntimeTarget::new(
            &suspended.workspace_id,
            &suspended.session_id,
            new_instance_id,
        );
        if self.instances.contains_key(&new_target.instance_id) {
            return Err(CoordinatorError::IdentityMismatch);
        }
        self.instances.remove(&suspended.instance_id);
        self.register(new_target.clone(), RuntimeState::Starting)?;
        Ok(new_target)
    }
}

#[cfg(test)]
mod tests {
    use super::{MutationAcceptance, RuntimeCoordinator, RuntimeState, RuntimeTarget};
    use serde_json::json;

    fn target(instance: &str) -> RuntimeTarget {
        RuntimeTarget::new("workspace-a", "session-a", instance)
    }

    #[test]
    fn validates_all_target_identities_and_rejects_session_replacement() {
        let mut coordinator = RuntimeCoordinator::new(8);
        coordinator
            .register(target("instance-a"), RuntimeState::Ready)
            .unwrap();

        assert!(coordinator.validate(&target("instance-a")).is_ok());
        assert!(coordinator
            .validate(&RuntimeTarget::new(
                "workspace-b",
                "session-a",
                "instance-a"
            ))
            .is_err());
        assert!(coordinator
            .validate(&RuntimeTarget::new(
                "workspace-a",
                "session-b",
                "instance-a"
            ))
            .is_err());
        assert!(coordinator.validate(&target("stale-instance")).is_err());
        assert!(coordinator
            .validate_command(&target("instance-a"), &json!({ "type": "new_session" }))
            .is_err());
        assert!(coordinator
            .validate_command(
                &target("instance-a"),
                &json!({ "type": "switch_session", "sessionPath": "/tmp/session.jsonl" }),
            )
            .is_err());
    }

    #[test]
    fn deduplicates_mutations_and_sequences_events_per_instance() {
        let mut coordinator = RuntimeCoordinator::new(2);
        coordinator
            .register(target("instance-a"), RuntimeState::Ready)
            .unwrap();

        assert_eq!(
            coordinator
                .accept_mutation(&target("instance-a"), "intent-1")
                .unwrap(),
            MutationAcceptance::Accepted
        );
        assert_eq!(
            coordinator
                .accept_mutation(&target("instance-a"), "intent-1")
                .unwrap(),
            MutationAcceptance::Duplicate
        );
        coordinator
            .accept_mutation(&target("instance-a"), "intent-2")
            .unwrap();
        coordinator
            .accept_mutation(&target("instance-a"), "intent-3")
            .unwrap();
        assert_eq!(
            coordinator
                .accept_mutation(&target("instance-a"), "intent-1")
                .unwrap(),
            MutationAcceptance::Accepted,
            "bounded cache evicts the least-recent accepted key"
        );

        let first = coordinator
            .emit_event(&target("instance-a"), json!({ "type": "agent_start" }))
            .unwrap();
        let second = coordinator
            .emit_event(&target("instance-a"), json!({ "type": "agent_end" }))
            .unwrap();
        assert_eq!((first.sequence, second.sequence), (1, 2));
        assert_eq!(
            coordinator
                .snapshot(&target("instance-a"))
                .unwrap()
                .sequence,
            2
        );
    }

    #[test]
    fn resume_preserves_session_but_replaces_instance() {
        let mut coordinator = RuntimeCoordinator::new(8);
        coordinator
            .register(target("instance-a"), RuntimeState::Suspended)
            .unwrap();
        let resumed = coordinator
            .resume(&target("instance-a"), "instance-b")
            .unwrap();

        assert_eq!(resumed.workspace_id, "workspace-a");
        assert_eq!(resumed.session_id, "session-a");
        assert_eq!(resumed.instance_id, "instance-b");
        assert!(coordinator.validate(&target("instance-a")).is_err());
        assert_eq!(
            coordinator.snapshot(&resumed).unwrap().state,
            RuntimeState::Starting
        );
    }

    #[test]
    fn binds_a_formal_session_without_replacing_the_instance() {
        let temporary = RuntimeTarget::new("workspace-a", "temporary-a", "instance-a");
        let mut coordinator = RuntimeCoordinator::new(8);
        coordinator
            .register(temporary.clone(), RuntimeState::Ready)
            .unwrap();

        let formal = coordinator
            .bind_session_id(&temporary, "session-formal")
            .unwrap();

        assert_eq!(formal.instance_id, temporary.instance_id);
        assert_eq!(formal.session_id, "session-formal");
        assert!(coordinator.validate(&temporary).is_err());
        assert!(coordinator.validate(&formal).is_ok());
    }
}
