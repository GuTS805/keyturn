//! Keyturn release policy contract.
//!
//! A project lists the accounts that may approve a release (members) and the
//! accounts that may only propose one (proposers, for example CI). A release
//! is identified by project id and version and is bound to one artifact hash.
//!
//! Lifecycle:
//!   Proposed -> Pending (quorum reached, window running) -> Executing -> Released
//!   Pending -> Flagged (bonded flag during the window) -> Pending (dismissed) or Rejected
//!   Released -> Recalled (quorum)
//!
//! The worker account is the only one that can confirm a publication, and it
//! must report the same hash that was approved.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};
use std::collections::HashSet;

const MIN_FLAG_BOND_YOCTO: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const MAX_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_ID_LEN: usize = 120;

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Registry {
    Npm,
    Chrome,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Proposed,
    Pending,
    Flagged,
    Executing,
    Released,
    Rejected,
    Recalled,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Project {
    pub id: String,
    pub registry: Registry,
    pub members: Vec<AccountId>,
    pub proposers: Vec<AccountId>,
    pub threshold: u8,
    pub window_ms: u64,
    /// Bonds forfeited by dismissed flags, in yoctoNEAR.
    pub treasury: U128,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Flag {
    pub by: AccountId,
    pub reason: String,
    pub bond: U128,
    pub at_ms: u64,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Release {
    pub project_id: String,
    pub version: String,
    pub artifact_hash: String,
    pub proposer: AccountId,
    pub proposed_at_ms: u64,
    pub status: Status,
    pub approvals: Vec<AccountId>,
    pub ready_at_ms: Option<u64>,
    pub flag: Option<Flag>,
    pub dismiss_votes: Vec<AccountId>,
    pub reject_votes: Vec<AccountId>,
    pub recall_votes: Vec<AccountId>,
    pub released_at_ms: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Keyturn {
    worker: AccountId,
    projects: LookupMap<String, Project>,
    releases: LookupMap<String, Release>,
}

fn release_key(project_id: &str, version: &str) -> String {
    format!("{}@{}", project_id, version)
}

fn has_duplicates(accounts: &[AccountId]) -> bool {
    let mut seen = HashSet::new();
    accounts.iter().any(|a| !seen.insert(a))
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({ "standard": "keyturn", "version": "1.0.0", "event": event, "data": data })
    ));
}

#[near]
impl Keyturn {
    #[init]
    pub fn new(worker: AccountId) -> Self {
        Self {
            worker,
            projects: LookupMap::new(b"p".to_vec()),
            releases: LookupMap::new(b"r".to_vec()),
        }
    }

    /// Register a project. The caller must be one of the members.
    pub fn register_project(
        &mut self,
        id: String,
        registry: Registry,
        members: Vec<AccountId>,
        proposers: Vec<AccountId>,
        threshold: u8,
        window_ms: u64,
    ) {
        require!(!id.is_empty() && id.len() <= MAX_ID_LEN, "invalid project id");
        require!(!self.projects.contains_key(&id), "project already registered");
        require!(members.len() >= 2, "at least two members are required");
        require!(!has_duplicates(&members), "duplicate member");
        require!(!has_duplicates(&proposers), "duplicate proposer");
        require!(
            proposers.iter().all(|p| !members.contains(p)),
            "an account cannot be both proposer and member"
        );
        require!(
            threshold >= 2 && (threshold as usize) <= members.len(),
            "threshold must be at least 2 and at most the number of members"
        );
        require!(window_ms <= MAX_WINDOW_MS, "window is longer than seven days");
        require!(
            members.contains(&env::predecessor_account_id()),
            "caller must be a member"
        );
        emit(
            "project_registered",
            near_sdk::serde_json::json!({ "id": id, "threshold": threshold, "window_ms": window_ms }),
        );
        self.projects.insert(
            id.clone(),
            Project {
                id,
                registry,
                members,
                proposers,
                threshold,
                window_ms,
                treasury: U128(0),
            },
        );
    }

    /// Propose a release. Members and proposers can propose. Proposing does
    /// not count as an approval.
    pub fn propose_release(&mut self, project_id: String, version: String, artifact_hash: String) {
        let project = self.project(&project_id);
        let caller = env::predecessor_account_id();
        require!(
            project.members.contains(&caller) || project.proposers.contains(&caller),
            "caller cannot propose for this project"
        );
        require!(!version.is_empty() && version.len() <= MAX_ID_LEN, "invalid version");
        require!(is_sha256_hex(&artifact_hash), "artifact hash must be 64 lowercase hex characters");
        let key = release_key(&project_id, &version);
        require!(!self.releases.contains_key(&key), "this version was already proposed");
        let now = env::block_timestamp_ms();
        emit(
            "release_proposed",
            near_sdk::serde_json::json!({ "project": project_id, "version": version, "hash": artifact_hash, "by": caller }),
        );
        self.releases.insert(
            key,
            Release {
                project_id,
                version,
                artifact_hash,
                proposer: caller,
                proposed_at_ms: now,
                status: Status::Proposed,
                approvals: vec![],
                ready_at_ms: None,
                flag: None,
                dismiss_votes: vec![],
                reject_votes: vec![],
                recall_votes: vec![],
                released_at_ms: None,
            },
        );
    }

    /// Approve the exact hash that was proposed. When the threshold is
    /// reached the public window starts. If every member approved, there is
    /// no window.
    pub fn approve_release(&mut self, project_id: String, version: String) {
        let project = self.project(&project_id);
        let caller = env::predecessor_account_id();
        require!(project.members.contains(&caller), "only members can approve");
        let key = release_key(&project_id, &version);
        let release = self.release_mut(&key);
        require!(release.status == Status::Proposed, "release is not awaiting approvals");
        require!(!release.approvals.contains(&caller), "already approved");
        release.approvals.push(caller.clone());
        emit(
            "release_approved",
            near_sdk::serde_json::json!({ "project": project_id, "version": version, "by": caller, "count": release.approvals.len() }),
        );
        if release.approvals.len() >= project.threshold as usize {
            let now = env::block_timestamp_ms();
            let everyone = release.approvals.len() == project.members.len();
            let ready = if everyone { now } else { now + project.window_ms };
            release.status = Status::Pending;
            release.ready_at_ms = Some(ready);
            emit(
                "quorum_reached",
                near_sdk::serde_json::json!({ "project": project_id, "version": version, "ready_at_ms": ready }),
            );
        }
    }

    /// Flag a pending release during its public window. Needs an attached
    /// bond. The release is blocked until members dismiss or reject.
    #[payable]
    pub fn flag_release(&mut self, project_id: String, version: String, reason: String) {
        let bond = env::attached_deposit().as_yoctonear();
        require!(bond >= MIN_FLAG_BOND_YOCTO, "attach at least 0.1 NEAR as a bond");
        require!(!reason.is_empty() && reason.len() <= 500, "give a reason of up to 500 characters");
        self.project(&project_id);
        let key = release_key(&project_id, &version);
        let release = self.release_mut(&key);
        require!(release.status == Status::Pending, "only a pending release can be flagged");
        let ready = release.ready_at_ms.unwrap_or(0);
        require!(env::block_timestamp_ms() < ready, "the public window has closed");
        let by = env::predecessor_account_id();
        release.status = Status::Flagged;
        release.dismiss_votes.clear();
        release.flag = Some(Flag {
            by: by.clone(),
            reason: reason.clone(),
            bond: U128(bond),
            at_ms: env::block_timestamp_ms(),
        });
        emit(
            "release_flagged",
            near_sdk::serde_json::json!({ "project": project_id, "version": version, "by": by, "reason": reason }),
        );
    }

    /// Members vote to dismiss a flag. At the threshold the bond is
    /// forfeited to the project treasury and a fresh window starts.
    pub fn dismiss_flag(&mut self, project_id: String, version: String) {
        let project = self.project(&project_id);
        let caller = env::predecessor_account_id();
        require!(project.members.contains(&caller), "only members can vote");
        let key = release_key(&project_id, &version);
        let release = self.release_mut(&key);
        require!(release.status == Status::Flagged, "release is not flagged");
        require!(!release.dismiss_votes.contains(&caller), "already voted");
        release.dismiss_votes.push(caller);
        if release.dismiss_votes.len() >= project.threshold as usize {
            let forfeited = release.flag.as_ref().map(|f| f.bond.0).unwrap_or(0);
            release.status = Status::Pending;
            release.ready_at_ms = Some(env::block_timestamp_ms() + project.window_ms);
            release.flag = None;
            release.dismiss_votes.clear();
            let mut updated = project;
            updated.treasury = U128(updated.treasury.0 + forfeited);
            emit(
                "flag_dismissed",
                near_sdk::serde_json::json!({ "project": project_id, "version": version, "forfeited": U128(forfeited) }),
            );
            self.projects.insert(project_id, updated);
        }
    }

    /// Members vote to reject a release that has not been executed. At the
    /// threshold it is rejected and any flag bond returns to the flagger.
    pub fn reject_release(&mut self, project_id: String, version: String) {
        let project = self.project(&project_id);
        let caller = env::predecessor_account_id();
        require!(project.members.contains(&caller), "only members can vote");
        let key = release_key(&project_id, &version);
        let release = self.release_mut(&key);
        require!(
            matches!(release.status, Status::Proposed | Status::Pending | Status::Flagged),
            "release can no longer be rejected"
        );
        require!(!release.reject_votes.contains(&caller), "already voted");
        release.reject_votes.push(caller);
        if release.reject_votes.len() >= project.threshold as usize {
            release.status = Status::Rejected;
            let refund = release.flag.take();
            emit(
                "release_rejected",
                near_sdk::serde_json::json!({ "project": project_id, "version": version }),
            );
            if let Some(flag) = refund {
                let _ = Promise::new(flag.by).transfer(NearToken::from_yoctonear(flag.bond.0));
            }
        }
    }

    /// Anyone can start execution once the window has passed. This is the
    /// signal the worker reacts to.
    pub fn execute_release(&mut self, project_id: String, version: String) {
        self.project(&project_id);
        let key = release_key(&project_id, &version);
        let release = self.release_mut(&key);
        require!(release.status == Status::Pending, "release is not pending");
        let ready = release.ready_at_ms.unwrap_or(u64::MAX);
        require!(env::block_timestamp_ms() >= ready, "the public window is still open");
        release.status = Status::Executing;
        emit(
            "release_executing",
            near_sdk::serde_json::json!({ "project": project_id, "version": version, "hash": release.artifact_hash }),
        );
    }

    /// Called by the worker after it published. The hash must match the one
    /// that was approved.
    pub fn confirm_published(&mut self, project_id: String, version: String, published_hash: String) {
        require!(env::predecessor_account_id() == self.worker, "only the worker can confirm");
        self.project(&project_id);
        let key = release_key(&project_id, &version);
        let release = self.release_mut(&key);
        require!(release.status == Status::Executing, "release is not executing");
        require!(release.artifact_hash == published_hash, "published hash differs from the approved hash");
        release.status = Status::Released;
        release.released_at_ms = Some(env::block_timestamp_ms());
        emit(
            "release_published",
            near_sdk::serde_json::json!({ "project": project_id, "version": version, "hash": published_hash }),
        );
    }

    /// Members vote to recall a published release.
    pub fn recall_release(&mut self, project_id: String, version: String) {
        let project = self.project(&project_id);
        let caller = env::predecessor_account_id();
        require!(project.members.contains(&caller), "only members can vote");
        let key = release_key(&project_id, &version);
        let release = self.release_mut(&key);
        require!(release.status == Status::Released, "only a published release can be recalled");
        require!(!release.recall_votes.contains(&caller), "already voted");
        release.recall_votes.push(caller);
        if release.recall_votes.len() >= project.threshold as usize {
            release.status = Status::Recalled;
            emit(
                "release_recalled",
                near_sdk::serde_json::json!({ "project": project_id, "version": version }),
            );
        }
    }

    pub fn get_worker(&self) -> AccountId {
        self.worker.clone()
    }

    pub fn get_project(&self, project_id: String) -> Option<Project> {
        self.projects.get(&project_id).cloned()
    }

    pub fn get_release(&self, project_id: String, version: String) -> Option<Release> {
        self.releases.get(&release_key(&project_id, &version)).cloned()
    }

    /// True only if this exact hash was approved by the quorum and published,
    /// and has not been recalled. Verifiers call this.
    pub fn is_released(&self, project_id: String, version: String, artifact_hash: String) -> bool {
        self.releases
            .get(&release_key(&project_id, &version))
            .map(|r| r.status == Status::Released && r.artifact_hash == artifact_hash)
            .unwrap_or(false)
    }
}

impl Keyturn {
    fn project(&self, id: &str) -> Project {
        self.projects
            .get(&id.to_string())
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown project"))
    }

    fn release_mut(&mut self, key: &str) -> &mut Release {
        self.releases
            .get_mut(&key.to_string())
            .unwrap_or_else(|| env::panic_str("unknown release"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const HASH: &str = "a3f1c0de0000000000000000000000000000000000000000000000000000beef";
    const OTHER_HASH: &str = "b3f1c0de0000000000000000000000000000000000000000000000000000beef";
    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn at(who: &str, ms: u64, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(who))
            .signer_account_id(acct(who))
            .block_timestamp(ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn setup(members: &[&str], threshold: u8) -> Keyturn {
        at("ada.test", 1_000, 0);
        let mut c = Keyturn::new(acct("worker.test"));
        c.register_project(
            "npm:leftpad".to_string(),
            Registry::Npm,
            members.iter().map(|m| acct(m)).collect(),
            vec![acct("ci.test")],
            threshold,
            DAY_MS,
        );
        c
    }

    fn propose(c: &mut Keyturn, version: &str) {
        at("ci.test", 2_000, 0);
        c.propose_release("npm:leftpad".into(), version.into(), HASH.into());
    }

    fn rel(c: &Keyturn, version: &str) -> Release {
        c.get_release("npm:leftpad".into(), version.into()).unwrap()
    }

    #[test]
    fn lone_maintainer_cannot_release() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        propose(&mut c, "1.0.0");
        at("ada.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        assert_eq!(rel(&c, "1.0.0").status, Status::Proposed);
        at("ada.test", 3_000 + 10 * DAY_MS, 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.execute_release("npm:leftpad".into(), "1.0.0".into());
        }));
        assert!(r.is_err());
    }

    #[test]
    #[should_panic(expected = "already approved")]
    fn same_account_cannot_approve_twice() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        propose(&mut c, "1.0.0");
        at("ada.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
    }

    #[test]
    #[should_panic(expected = "only members can approve")]
    fn proposer_cannot_approve() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        propose(&mut c, "1.0.0");
        at("ci.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
    }

    #[test]
    #[should_panic(expected = "only members can approve")]
    fn stranger_cannot_approve() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        propose(&mut c, "1.0.0");
        at("mallory.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
    }

    #[test]
    #[should_panic(expected = "caller cannot propose for this project")]
    fn stranger_cannot_propose() {
        let mut c = setup(&["ada.test", "bob.test"], 2);
        at("mallory.test", 2_000, 0);
        c.propose_release("npm:leftpad".into(), "1.0.0".into(), HASH.into());
    }

    #[test]
    fn quorum_starts_window_and_execution_waits_for_it() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        propose(&mut c, "1.0.0");
        at("ada.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        at("bob.test", 4_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        let r = rel(&c, "1.0.0");
        assert_eq!(r.status, Status::Pending);
        assert_eq!(r.ready_at_ms, Some(4_000 + DAY_MS));

        at("cy.test", 4_000 + DAY_MS - 1, 0);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.execute_release("npm:leftpad".into(), "1.0.0".into());
        }));
        assert!(early.is_err());

        at("anyone.test", 4_000 + DAY_MS, 0);
        c.execute_release("npm:leftpad".into(), "1.0.0".into());
        assert_eq!(rel(&c, "1.0.0").status, Status::Executing);

        at("worker.test", 5_000 + DAY_MS, 0);
        c.confirm_published("npm:leftpad".into(), "1.0.0".into(), HASH.into());
        assert_eq!(rel(&c, "1.0.0").status, Status::Released);
        assert!(c.is_released("npm:leftpad".into(), "1.0.0".into(), HASH.into()));
        assert!(!c.is_released("npm:leftpad".into(), "1.0.0".into(), OTHER_HASH.into()));
    }

    #[test]
    fn full_approval_skips_the_window() {
        let mut c = setup(&["ada.test", "bob.test"], 2);
        propose(&mut c, "1.0.0");
        at("ada.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        at("bob.test", 4_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        assert_eq!(rel(&c, "1.0.0").ready_at_ms, Some(4_000));
        at("anyone.test", 4_000, 0);
        c.execute_release("npm:leftpad".into(), "1.0.0".into());
    }

    #[test]
    #[should_panic(expected = "published hash differs from the approved hash")]
    fn tampered_artifact_is_refused() {
        let mut c = setup(&["ada.test", "bob.test"], 2);
        propose(&mut c, "1.0.0");
        at("ada.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        at("bob.test", 4_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        at("anyone.test", 4_000, 0);
        c.execute_release("npm:leftpad".into(), "1.0.0".into());
        at("worker.test", 5_000, 0);
        c.confirm_published("npm:leftpad".into(), "1.0.0".into(), OTHER_HASH.into());
    }

    #[test]
    #[should_panic(expected = "only the worker can confirm")]
    fn only_the_worker_confirms() {
        let mut c = setup(&["ada.test", "bob.test"], 2);
        propose(&mut c, "1.0.0");
        at("ada.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        at("bob.test", 4_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        at("anyone.test", 4_000, 0);
        c.execute_release("npm:leftpad".into(), "1.0.0".into());
        at("ada.test", 5_000, 0);
        c.confirm_published("npm:leftpad".into(), "1.0.0".into(), HASH.into());
    }

    fn pending(c: &mut Keyturn) {
        propose(c, "1.0.0");
        at("ada.test", 3_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
        at("bob.test", 4_000, 0);
        c.approve_release("npm:leftpad".into(), "1.0.0".into());
    }

    #[test]
    fn flag_blocks_execution_until_dismissed() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        pending(&mut c);
        at("watcher.test", 5_000, MIN_FLAG_BOND_YOCTO);
        c.flag_release("npm:leftpad".into(), "1.0.0".into(), "new install script".into());
        assert_eq!(rel(&c, "1.0.0").status, Status::Flagged);

        at("anyone.test", 5_000 + 2 * DAY_MS, 0);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.execute_release("npm:leftpad".into(), "1.0.0".into());
        }));
        assert!(blocked.is_err());

        at("ada.test", 6_000, 0);
        c.dismiss_flag("npm:leftpad".into(), "1.0.0".into());
        assert_eq!(rel(&c, "1.0.0").status, Status::Flagged);
        at("bob.test", 7_000, 0);
        c.dismiss_flag("npm:leftpad".into(), "1.0.0".into());
        let r = rel(&c, "1.0.0");
        assert_eq!(r.status, Status::Pending);
        assert_eq!(r.ready_at_ms, Some(7_000 + DAY_MS));
        assert_eq!(c.get_project("npm:leftpad".into()).unwrap().treasury.0, MIN_FLAG_BOND_YOCTO);
    }

    #[test]
    #[should_panic(expected = "attach at least 0.1 NEAR as a bond")]
    fn flag_needs_a_bond() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        pending(&mut c);
        at("watcher.test", 5_000, 1);
        c.flag_release("npm:leftpad".into(), "1.0.0".into(), "suspicious".into());
    }

    #[test]
    #[should_panic(expected = "the public window has closed")]
    fn cannot_flag_after_the_window() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        pending(&mut c);
        at("watcher.test", 4_000 + DAY_MS, MIN_FLAG_BOND_YOCTO);
        c.flag_release("npm:leftpad".into(), "1.0.0".into(), "too late".into());
    }

    #[test]
    fn rejecting_a_flagged_release_returns_the_bond() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        pending(&mut c);
        at("watcher.test", 5_000, MIN_FLAG_BOND_YOCTO);
        c.flag_release("npm:leftpad".into(), "1.0.0".into(), "malware".into());
        at("ada.test", 6_000, 0);
        c.reject_release("npm:leftpad".into(), "1.0.0".into());
        at("cy.test", 7_000, 0);
        c.reject_release("npm:leftpad".into(), "1.0.0".into());
        let r = rel(&c, "1.0.0");
        assert_eq!(r.status, Status::Rejected);
        assert!(r.flag.is_none());
        assert_eq!(c.get_project("npm:leftpad".into()).unwrap().treasury.0, 0);
    }

    #[test]
    fn recall_needs_a_quorum_and_clears_is_released() {
        let mut c = setup(&["ada.test", "bob.test"], 2);
        pending(&mut c);
        at("anyone.test", 4_000, 0);
        c.execute_release("npm:leftpad".into(), "1.0.0".into());
        at("worker.test", 5_000, 0);
        c.confirm_published("npm:leftpad".into(), "1.0.0".into(), HASH.into());
        assert!(c.is_released("npm:leftpad".into(), "1.0.0".into(), HASH.into()));

        at("ada.test", 6_000, 0);
        c.recall_release("npm:leftpad".into(), "1.0.0".into());
        assert!(c.is_released("npm:leftpad".into(), "1.0.0".into(), HASH.into()));
        at("bob.test", 7_000, 0);
        c.recall_release("npm:leftpad".into(), "1.0.0".into());
        assert_eq!(rel(&c, "1.0.0").status, Status::Recalled);
        assert!(!c.is_released("npm:leftpad".into(), "1.0.0".into(), HASH.into()));
    }

    #[test]
    #[should_panic(expected = "this version was already proposed")]
    fn a_version_can_only_be_proposed_once() {
        let mut c = setup(&["ada.test", "bob.test"], 2);
        propose(&mut c, "1.0.0");
        propose(&mut c, "1.0.0");
    }

    #[test]
    #[should_panic(expected = "artifact hash must be 64 lowercase hex characters")]
    fn bad_hash_is_refused() {
        let mut c = setup(&["ada.test", "bob.test"], 2);
        at("ci.test", 2_000, 0);
        c.propose_release("npm:leftpad".into(), "1.0.0".into(), "not-a-hash".into());
    }

    #[test]
    #[should_panic(expected = "threshold must be at least 2")]
    fn threshold_of_one_is_refused() {
        setup(&["ada.test", "bob.test"], 1);
    }

    #[test]
    #[should_panic(expected = "at least two members are required")]
    fn single_member_project_is_refused() {
        at("ada.test", 1_000, 0);
        let mut c = Keyturn::new(acct("worker.test"));
        c.register_project("npm:solo".into(), Registry::Npm, vec![acct("ada.test")], vec![], 2, DAY_MS);
    }

    #[test]
    #[should_panic(expected = "an account cannot be both proposer and member")]
    fn proposer_and_member_must_differ() {
        at("ada.test", 1_000, 0);
        let mut c = Keyturn::new(acct("worker.test"));
        c.register_project(
            "npm:x".into(),
            Registry::Npm,
            vec![acct("ada.test"), acct("bob.test")],
            vec![acct("ada.test")],
            2,
            DAY_MS,
        );
    }
}
