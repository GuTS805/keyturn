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
//!
//! Recovery: a project may name guardians, accounts that are not members. If
//! members lose their keys, the guardians can start a recovery that replaces the
//! member list. It waits seven days in public, and any current member can cancel
//! it during that time.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};
use std::collections::HashSet;

const MIN_FLAG_BOND_YOCTO: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const MAX_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_ID_LEN: usize = 120;
const RECOVERY_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1000;

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

/// Accounts, separate from the members, that can start a recovery.
#[near(serializers=[borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Guardians {
    pub accounts: Vec<AccountId>,
    pub threshold: u8,
}

/// Guardians proposed by a member and waiting for the members' quorum.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct GuardianProposal {
    pub guardians: Guardians,
    pub approvals: Vec<AccountId>,
}

/// A request to replace the member list.
#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Recovery {
    pub new_members: Vec<AccountId>,
    pub new_threshold: u8,
    pub started_by: AccountId,
    pub approvals: Vec<AccountId>,
    /// Set when enough guardians approved. The recovery can finish after this time.
    pub ready_at_ms: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Keyturn {
    worker: AccountId,
    projects: LookupMap<String, Project>,
    releases: LookupMap<String, Release>,
    guardians: LookupMap<String, Guardians>,
    guardian_proposals: LookupMap<String, GuardianProposal>,
    recoveries: LookupMap<String, Recovery>,
}

/// The state before recovery existed. Used by `migrate`.
#[near(serializers=[borsh])]
struct OldKeyturn {
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

/// The rules for a member list, shared by registration and recovery.
fn check_member_set(members: &[AccountId], proposers: &[AccountId], threshold: u8) {
    require!(members.len() >= 2, "at least two members are required");
    require!(!has_duplicates(members), "duplicate member");
    require!(!has_duplicates(proposers), "duplicate proposer");
    require!(
        proposers.iter().all(|p| !members.contains(p)),
        "an account cannot be both proposer and member"
    );
    require!(
        threshold >= 2 && (threshold as usize) <= members.len(),
        "threshold must be at least 2 and at most the number of members"
    );
}

fn check_guardians(guardians: &[AccountId], threshold: u8, members: &[AccountId], proposers: &[AccountId]) {
    require!(guardians.len() >= 2, "at least two guardians are required");
    require!(!has_duplicates(guardians), "duplicate guardian");
    require!(
        guardians.iter().all(|g| !members.contains(g) && !proposers.contains(g)),
        "a guardian cannot be a member or a proposer"
    );
    require!(
        threshold >= 2 && (threshold as usize) <= guardians.len(),
        "guardian threshold must be at least 2 and at most the number of guardians"
    );
}

fn same_guardians(a: &Guardians, b: &Guardians) -> bool {
    let mut x = a.accounts.clone();
    let mut y = b.accounts.clone();
    x.sort();
    y.sort();
    a.threshold == b.threshold && x == y
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
            guardians: LookupMap::new(b"g".to_vec()),
            guardian_proposals: LookupMap::new(b"q".to_vec()),
            recoveries: LookupMap::new(b"c".to_vec()),
        }
    }

    /// Upgrade from the state without recovery. Only the contract account can call it.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: OldKeyturn = env::state_read().unwrap_or_else(|| env::panic_str("no old state to migrate"));
        Self {
            worker: old.worker,
            projects: old.projects,
            releases: old.releases,
            guardians: LookupMap::new(b"g".to_vec()),
            guardian_proposals: LookupMap::new(b"q".to_vec()),
            recoveries: LookupMap::new(b"c".to_vec()),
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
        check_member_set(&members, &proposers, threshold);
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
        // After a recovery, approvals by accounts that are no longer members do not count.
        let project = self.project(&project_id);
        let release = self.release_mut(&key);
        let valid = release.approvals.iter().filter(|a| project.members.contains(a)).count();
        require!(valid >= project.threshold as usize, "too few of the approvers are still members");
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

    /// A member proposes guardians. When the threshold of members proposed the same
    /// guardians, they take effect. A different proposal replaces the pending one.
    /// Changing guardians cancels a recovery in progress.
    pub fn propose_guardians(&mut self, project_id: String, guardians: Vec<AccountId>, threshold: u8) {
        let project = self.project(&project_id);
        let caller = env::predecessor_account_id();
        require!(project.members.contains(&caller), "only members can propose guardians");
        check_guardians(&guardians, threshold, &project.members, &project.proposers);
        let proposed = Guardians { accounts: guardians, threshold };
        let mut approvals = vec![];
        if let Some(pending) = self.guardian_proposals.get(&project_id) {
            if same_guardians(&pending.guardians, &proposed) {
                require!(!pending.approvals.contains(&caller), "already approved");
                approvals = pending.approvals.clone();
            }
        }
        approvals.push(caller.clone());
        if approvals.len() >= project.threshold as usize {
            self.guardians.insert(project_id.clone(), proposed);
            self.guardian_proposals.remove(&project_id);
            self.recoveries.remove(&project_id);
            emit("guardians_set", near_sdk::serde_json::json!({ "project": project_id }));
        } else {
            self.guardian_proposals.insert(project_id.clone(), GuardianProposal { guardians: proposed, approvals });
            emit("guardians_proposed", near_sdk::serde_json::json!({ "project": project_id, "by": caller }));
        }
    }

    /// A guardian asks to replace the member list, for example after keys were lost.
    pub fn start_recovery(&mut self, project_id: String, new_members: Vec<AccountId>, new_threshold: u8) {
        let project = self.project(&project_id);
        let guardians = self.guardians_of(&project_id);
        let caller = env::predecessor_account_id();
        require!(guardians.accounts.contains(&caller), "only guardians can start a recovery");
        require!(!self.recoveries.contains_key(&project_id), "a recovery is already in progress");
        check_member_set(&new_members, &project.proposers, new_threshold);
        require!(
            guardians.accounts.iter().all(|g| !new_members.contains(g)),
            "a guardian cannot also be a member"
        );
        emit(
            "recovery_started",
            near_sdk::serde_json::json!({ "project": project_id, "by": caller, "new_members": new_members, "new_threshold": new_threshold }),
        );
        self.recoveries.insert(
            project_id,
            Recovery { new_members, new_threshold, started_by: caller.clone(), approvals: vec![caller], ready_at_ms: None },
        );
    }

    /// Another guardian approves. At the guardian threshold the seven day wait starts.
    pub fn approve_recovery(&mut self, project_id: String) {
        let guardians = self.guardians_of(&project_id);
        let caller = env::predecessor_account_id();
        require!(guardians.accounts.contains(&caller), "only guardians can approve a recovery");
        let recovery = self
            .recoveries
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("no recovery in progress"));
        require!(recovery.ready_at_ms.is_none(), "the recovery already has enough approvals");
        require!(!recovery.approvals.contains(&caller), "already approved");
        recovery.approvals.push(caller);
        if recovery.approvals.len() >= guardians.threshold as usize {
            let ready = env::block_timestamp_ms() + RECOVERY_DELAY_MS;
            recovery.ready_at_ms = Some(ready);
            emit("recovery_ready", near_sdk::serde_json::json!({ "project": project_id, "ready_at_ms": ready }));
        }
    }

    /// Any current member can stop a recovery. A member who is alive can always
    /// veto, so guardians cannot take a project over without notice.
    pub fn cancel_recovery(&mut self, project_id: String) {
        let project = self.project(&project_id);
        let caller = env::predecessor_account_id();
        require!(project.members.contains(&caller), "only members can cancel a recovery");
        require!(self.recoveries.contains_key(&project_id), "no recovery in progress");
        self.recoveries.remove(&project_id);
        emit("recovery_cancelled", near_sdk::serde_json::json!({ "project": project_id, "by": caller }));
    }

    /// Anyone can finish a recovery once the wait is over.
    pub fn finish_recovery(&mut self, project_id: String) {
        let mut project = self.project(&project_id);
        let guardians = self.guardians_of(&project_id);
        let recovery = self
            .recoveries
            .get(&project_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no recovery in progress"));
        let ready = recovery.ready_at_ms.unwrap_or_else(|| env::panic_str("the guardians have not approved yet"));
        require!(env::block_timestamp_ms() >= ready, "the recovery wait is not over");
        check_member_set(&recovery.new_members, &project.proposers, recovery.new_threshold);
        require!(
            guardians.accounts.iter().all(|g| !recovery.new_members.contains(g)),
            "a guardian cannot also be a member"
        );
        project.members = recovery.new_members.clone();
        project.threshold = recovery.new_threshold;
        self.projects.insert(project_id.clone(), project);
        self.recoveries.remove(&project_id);
        emit(
            "recovery_finished",
            near_sdk::serde_json::json!({ "project": project_id, "members": recovery.new_members, "threshold": recovery.new_threshold }),
        );
    }

    pub fn get_guardians(&self, project_id: String) -> Option<Guardians> {
        self.guardians.get(&project_id).cloned()
    }

    pub fn get_guardian_proposal(&self, project_id: String) -> Option<GuardianProposal> {
        self.guardian_proposals.get(&project_id).cloned()
    }

    pub fn get_recovery(&self, project_id: String) -> Option<Recovery> {
        self.recoveries.get(&project_id).cloned()
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
    fn guardians_of(&self, id: &str) -> Guardians {
        self.guardians
            .get(&id.to_string())
            .cloned()
            .unwrap_or_else(|| env::panic_str("this project has no guardians"))
    }

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

    // ----- guardians and recovery -----

    const WEEK_MS: u64 = 7 * DAY_MS;

    fn call_as<R>(who: &str, ms: u64, f: impl FnOnce() -> R) -> R {
        at(who, ms, 0);
        f()
    }

    fn with_guardians() -> Keyturn {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        let g = || vec![acct("g1.test"), acct("g2.test"), acct("g3.test")];
        call_as("ada.test", 2_000, || c.propose_guardians("npm:leftpad".into(), g(), 2));
        assert!(c.get_guardians("npm:leftpad".into()).is_none(), "one member is not enough");
        call_as("bob.test", 2_100, || c.propose_guardians("npm:leftpad".into(), g(), 2));
        assert_eq!(c.get_guardians("npm:leftpad".into()).unwrap().accounts.len(), 3);
        c
    }

    fn started(c: &mut Keyturn) {
        call_as("g1.test", 3_000, || {
            c.start_recovery("npm:leftpad".into(), vec![acct("dan.test"), acct("eve.test")], 2)
        });
    }

    #[test]
    fn guardians_need_the_members_quorum_to_take_effect() {
        let c = with_guardians();
        assert!(c.get_guardian_proposal("npm:leftpad".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "a guardian cannot be a member or a proposer")]
    fn a_guardian_cannot_also_be_a_member() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        call_as("ada.test", 2_000, || {
            c.propose_guardians("npm:leftpad".into(), vec![acct("bob.test"), acct("g2.test")], 2)
        });
    }

    #[test]
    #[should_panic(expected = "only members can propose guardians")]
    fn outsiders_cannot_propose_guardians() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        call_as("mallory.test", 2_000, || {
            c.propose_guardians("npm:leftpad".into(), vec![acct("m1.test"), acct("m2.test")], 2)
        });
    }

    #[test]
    fn a_different_proposal_replaces_the_pending_one() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        call_as("ada.test", 2_000, || {
            c.propose_guardians("npm:leftpad".into(), vec![acct("m1.test"), acct("m2.test")], 2)
        });
        call_as("bob.test", 2_100, || {
            c.propose_guardians("npm:leftpad".into(), vec![acct("g1.test"), acct("g2.test")], 2)
        });
        assert!(c.get_guardians("npm:leftpad".into()).is_none(), "the two proposals must not be added together");
        assert_eq!(c.get_guardian_proposal("npm:leftpad".into()).unwrap().approvals, vec![acct("bob.test")]);
    }

    #[test]
    fn recovery_replaces_the_members_after_the_wait() {
        let mut c = with_guardians();
        started(&mut c);
        call_as("g2.test", 3_100, || c.approve_recovery("npm:leftpad".into()));
        let ready = c.get_recovery("npm:leftpad".into()).unwrap().ready_at_ms.unwrap();
        assert_eq!(ready, 3_100 + WEEK_MS);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            call_as("anyone.test", 3_200, || c.finish_recovery("npm:leftpad".into()))
        }));
        assert!(early.is_err(), "the wait is public and cannot be skipped");
        call_as("anyone.test", ready, || c.finish_recovery("npm:leftpad".into()));
        let p = c.get_project("npm:leftpad".into()).unwrap();
        assert_eq!(p.members, vec![acct("dan.test"), acct("eve.test")]);
        assert_eq!(p.threshold, 2);
        assert!(c.get_recovery("npm:leftpad".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "only members can cancel a recovery")]
    fn only_a_member_can_veto() {
        let mut c = with_guardians();
        started(&mut c);
        call_as("g2.test", 3_100, || c.cancel_recovery("npm:leftpad".into()));
    }

    #[test]
    fn a_live_member_can_veto_a_recovery() {
        let mut c = with_guardians();
        started(&mut c);
        call_as("g2.test", 3_100, || c.approve_recovery("npm:leftpad".into()));
        call_as("cy.test", 4_000, || c.cancel_recovery("npm:leftpad".into()));
        assert!(c.get_recovery("npm:leftpad".into()).is_none());
        let late = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            call_as("anyone.test", 3_100 + WEEK_MS, || c.finish_recovery("npm:leftpad".into()))
        }));
        assert!(late.is_err());
        assert_eq!(c.get_project("npm:leftpad".into()).unwrap().members.len(), 3);
    }

    #[test]
    #[should_panic(expected = "only guardians can start a recovery")]
    fn members_cannot_start_a_recovery() {
        let mut c = with_guardians();
        call_as("ada.test", 3_000, || {
            c.start_recovery("npm:leftpad".into(), vec![acct("ada.test"), acct("bob.test")], 2)
        });
    }

    #[test]
    #[should_panic(expected = "the guardians have not approved yet")]
    fn one_guardian_alone_cannot_finish() {
        let mut c = with_guardians();
        started(&mut c);
        call_as("anyone.test", 3_000 + 30 * DAY_MS, || c.finish_recovery("npm:leftpad".into()));
    }

    #[test]
    #[should_panic(expected = "this project has no guardians")]
    fn a_project_without_guardians_has_no_recovery() {
        let mut c = setup(&["ada.test", "bob.test", "cy.test"], 2);
        call_as("g1.test", 3_000, || {
            c.start_recovery("npm:leftpad".into(), vec![acct("dan.test"), acct("eve.test")], 2)
        });
    }

    #[test]
    #[should_panic(expected = "a guardian cannot also be a member")]
    fn guardians_cannot_make_themselves_members() {
        let mut c = with_guardians();
        call_as("g1.test", 3_000, || {
            c.start_recovery("npm:leftpad".into(), vec![acct("g1.test"), acct("eve.test")], 2)
        });
    }

    #[test]
    fn approvals_by_removed_members_do_not_count_after_a_recovery() {
        let mut c = with_guardians();
        propose(&mut c, "1.0.0");
        call_as("ada.test", 2_500, || c.approve_release("npm:leftpad".into(), "1.0.0".into()));
        call_as("bob.test", 2_600, || c.approve_release("npm:leftpad".into(), "1.0.0".into()));
        assert_eq!(rel(&c, "1.0.0").status, Status::Pending);
        started(&mut c);
        call_as("g2.test", 3_100, || c.approve_recovery("npm:leftpad".into()));
        let after = 3_100 + WEEK_MS + 1;
        call_as("anyone.test", after, || c.finish_recovery("npm:leftpad".into()));
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            call_as("anyone.test", after + DAY_MS, || c.execute_release("npm:leftpad".into(), "1.0.0".into()))
        }));
        assert!(blocked.is_err(), "the old members are gone, so their approvals no longer count");
        assert_eq!(rel(&c, "1.0.0").status, Status::Pending);
    }
}
