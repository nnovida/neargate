//! `SpendGuard` — on-chain x402 spend-firewall escrow.
//!
//! An agent opens a [`Policy`] and pre-funds a per-policy escrow. Before serving
//! an x402 paid call, the AgentGate middleware (the policy's `gate`) calls
//! [`SpendGuard::debit`]. Every policy rule is enforced on-chain; a violation
//! `revert`s **atomically** so the payment never settles and the escrow is
//! untouched. On success the escrowed motes move to `pay_to` in the same
//! transaction.
//!
//! Idioms mirror `agentgate-registry::registry` 1:1: `odra::prelude::*`, `U512`
//! motes via `casper_types`, 1-based ids (`register`-style counter bump),
//! `seen_*` dedup mapping, `saturating_*` counters, and a `load_*` revert helper.

use odra::casper_types::U512;
use odra::prelude::*;

/// Trust tiers are a small 0..=255 scale; a service must meet the policy's
/// `min_trust_tier` to be paid. (Source of the score is off-chain — e.g. the
/// AgentGate registry `(success/total)` ratio bucketed into tiers.)
pub type TrustTier = u8;

/// One spend policy: the agent's on-chain budget + rate + trust mandate, plus
/// the escrow balance backing it.
#[odra::odra_type]
pub struct Policy {
    /// Policy owner — the agent that opened it. May `pause`/top-up.
    pub owner: Address,
    /// The only account allowed to `debit` this policy (the AgentGate gate/middleware).
    pub gate: Address,
    /// Cumulative spend ceiling in motes. `spent` may never exceed it.
    pub budget: U512,
    /// Motes spent so far through approved debits.
    pub spent: U512,
    /// Motes currently escrowed and available to spend (topped up by `deposit`).
    pub balance: U512,
    /// Maximum motes a single `debit` may move.
    pub per_call_cap: U512,
    /// Sliding rate-window length in milliseconds.
    pub window_ms: u64,
    /// Maximum approved debits allowed within any `window_ms` window.
    pub max_calls_in_window: u32,
    /// Minimum counterparty trust tier required to be paid.
    pub min_trust_tier: TrustTier,
    /// Kill-switch: while `true`, every `debit` reverts.
    pub paused: bool,
    /// Block time (ms) at `open_policy`.
    pub created_at: u64,
}

/// Emitted on `open_policy`.
#[odra::event]
pub struct PolicyOpened {
    pub policy_id: u64,
    pub owner: Address,
    pub gate: Address,
    pub budget: U512,
    pub per_call_cap: U512,
    pub window_ms: u64,
    pub max_calls_in_window: u32,
    pub min_trust_tier: TrustTier,
}

/// Emitted on `deposit`.
#[odra::event]
pub struct Deposited {
    pub policy_id: u64,
    pub amount: U512,
    pub new_balance: U512,
}

/// Emitted on an APPROVED `debit` (the funds moved). A blocked debit reverts and
/// emits nothing — the failed deploy itself is the on-chain "blocked" signal.
#[odra::event]
pub struct DebitApproved {
    pub policy_id: u64,
    pub service_id: u64,
    pub amount: U512,
    pub pay_to: Address,
    pub payment_ref: String,
    pub remaining: U512,
}

/// Emitted on `pause`.
#[odra::event]
pub struct PolicyPaused {
    pub policy_id: u64,
    pub paused: bool,
}

/// Emitted on `withdraw` (owner reclaims unspent escrow).
#[odra::event]
pub struct Withdrawn {
    pub policy_id: u64,
    pub amount: U512,
    pub remaining: U512,
}

/// SpendGuard errors. User-error codes 1..=10.
#[odra::odra_error]
pub enum Error {
    /// Unknown `policy_id`.
    PolicyNotFound = 1,
    /// Caller is not allowed to perform this action (debit: not the gate; pause: not the owner).
    NotAuthorized = 2,
    /// Policy is paused — every debit is rejected.
    Paused = 3,
    /// Amount/deposit was zero.
    ZeroAmount = 4,
    /// Single-call amount exceeds the policy's `per_call_cap`.
    PerCallExceeded = 5,
    /// Counterparty `trust_tier` is below the policy's `min_trust_tier`.
    UntrustedService = 6,
    /// This `payment_ref` was already debited for this policy (replay guard).
    DuplicateRef = 7,
    /// Amount exceeds the escrow balance, or would push `spent` past `budget`.
    OverBudget = 8,
    /// Too many debits inside the current rate window.
    RateExceeded = 9,
    /// Invalid policy config (zero `per_call_cap` or zero `max_calls_in_window`).
    InvalidConfig = 10,
}

/// AgentGate x402 spend-firewall: per-policy escrow + on-chain spend enforcement.
#[odra::module(
    events = [PolicyOpened, Deposited, DebitApproved, PolicyPaused, Withdrawn],
    errors = Error
)]
pub struct SpendGuard {
    /// Number of policies opened; equals the id of the most recent one
    /// (ids are 1-based, `1..=policies_count`).
    policies_count: Var<u64>,
    /// policy_id -> policy record.
    policies: Mapping<u64, Policy>,
    /// (policy_id, payment_ref) -> debited? Replay guard.
    seen_refs: Mapping<(u64, String), bool>,
    /// policy_id -> approved-debit timestamps inside the live rate window (pruned on debit).
    call_times: Mapping<u64, Vec<u64>>,
}

#[odra::module]
impl SpendGuard {
    /// Open a spend policy. Caller becomes the owner. Returns the 1-based id.
    ///
    /// Reverts [`Error::InvalidConfig`] if `per_call_cap == 0`,
    /// `max_calls_in_window == 0`, `budget == 0`, or `per_call_cap > budget`
    /// (a policy that could accept deposits but never debit). Emits [`PolicyOpened`].
    pub fn open_policy(
        &mut self,
        gate: Address,
        budget: U512,
        per_call_cap: U512,
        window_ms: u64,
        max_calls_in_window: u32,
        min_trust_tier: TrustTier,
    ) -> u64 {
        if per_call_cap.is_zero()
            || max_calls_in_window == 0
            || budget.is_zero()
            || per_call_cap > budget
        {
            self.env().revert(Error::InvalidConfig);
        }

        let policy_id = self.policies_count.get_or_default() + 1;
        let owner = self.env().caller();
        let created_at = self.env().get_block_time();

        self.env().emit_event(PolicyOpened {
            policy_id,
            owner,
            gate,
            budget,
            per_call_cap,
            window_ms,
            max_calls_in_window,
            min_trust_tier,
        });

        self.policies.set(
            &policy_id,
            Policy {
                owner,
                gate,
                budget,
                spent: U512::zero(),
                balance: U512::zero(),
                per_call_cap,
                window_ms,
                max_calls_in_window,
                min_trust_tier,
                paused: false,
                created_at,
            },
        );
        self.policies_count.set(policy_id);

        policy_id
    }

    /// Top up a policy's escrow with the attached CSPR. Anyone may fund.
    ///
    /// Reverts [`Error::PolicyNotFound`] / [`Error::ZeroAmount`]. Emits [`Deposited`].
    #[odra(payable)]
    pub fn deposit(&mut self, policy_id: u64) {
        let mut policy = self.load_policy(policy_id);
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }

        let new_balance = policy.balance.saturating_add(amount);
        policy.balance = new_balance;
        self.policies.set(&policy_id, policy);

        self.env().emit_event(Deposited {
            policy_id,
            amount,
            new_balance,
        });
    }

    /// The firewall. The policy `gate` requests a spend; this enforces every
    /// rule and, only if ALL pass, moves `amount` motes from the escrow to
    /// `pay_to` atomically. Any violation reverts and nothing moves.
    ///
    /// Revert order: [`PolicyNotFound`] → [`NotAuthorized`] (caller != gate) →
    /// [`Paused`] → [`ZeroAmount`] → [`PerCallExceeded`] → [`UntrustedService`]
    /// → [`DuplicateRef`] → [`OverBudget`] (balance or budget) → [`RateExceeded`].
    /// On success: transfer, decrement balance, bump `spent`, mark the ref,
    /// record the timestamp, emit [`DebitApproved`].
    pub fn debit(
        &mut self,
        policy_id: u64,
        service_id: u64,
        amount: U512,
        pay_to: Address,
        payment_ref: String,
        trust_tier: TrustTier,
    ) {
        let mut policy = self.load_policy(policy_id);

        if self.env().caller() != policy.gate {
            self.env().revert(Error::NotAuthorized);
        }
        if policy.paused {
            self.env().revert(Error::Paused);
        }
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if amount > policy.per_call_cap {
            self.env().revert(Error::PerCallExceeded);
        }
        if trust_tier < policy.min_trust_tier {
            self.env().revert(Error::UntrustedService);
        }

        let ref_key = (policy_id, payment_ref.clone());
        if self.seen_refs.get(&ref_key).unwrap_or(false) {
            self.env().revert(Error::DuplicateRef);
        }

        // Budget: must fit the escrow AND the cumulative cap.
        let new_spent = policy.spent.saturating_add(amount);
        if amount > policy.balance || new_spent > policy.budget {
            self.env().revert(Error::OverBudget);
        }

        // Rate window: prune timestamps older than the window, then check the cap.
        // Age check (`now - t < window`) is underflow-safe and correct at block
        // time 0, unlike a `t > now - window` cutoff which saturates to 0.
        let now = self.env().get_block_time();
        let mut times = self.call_times.get(&policy_id).unwrap_or_default();
        times.retain(|&t| now.saturating_sub(t) < policy.window_ms);
        if times.len() as u64 >= u64::from(policy.max_calls_in_window) {
            self.env().revert(Error::RateExceeded);
        }

        // ── all checks passed: settle atomically ──
        // Checks-effects-interactions: write all state BEFORE the external
        // transfer. (A transfer revert still rolls back every write, so this is
        // defense-in-depth — the contract no longer relies on the backend
        // forbidding a callback from `pay_to`.)
        let remaining = policy.balance.saturating_sub(amount);
        policy.balance = remaining;
        policy.spent = new_spent;
        self.policies.set(&policy_id, policy);

        self.seen_refs.set(&ref_key, true);
        times.push(now);
        self.call_times.set(&policy_id, times);

        self.env().transfer_tokens(&pay_to, &amount);

        self.env().emit_event(DebitApproved {
            policy_id,
            service_id,
            amount,
            pay_to,
            payment_ref,
            remaining,
        });
    }

    /// Withdraw unspent escrow back to the policy owner. Owner only. Without this
    /// an over-funded, wound-down, or paused policy would lock its remaining CSPR
    /// in the contract forever. Works regardless of `paused` so it doubles as the
    /// recovery path after the kill-switch is flipped.
    ///
    /// Reverts [`Error::PolicyNotFound`] / [`Error::NotAuthorized`] /
    /// [`Error::ZeroAmount`] / [`Error::OverBudget`] (amount > balance).
    /// Emits [`Withdrawn`].
    pub fn withdraw(&mut self, policy_id: u64, amount: U512) {
        let mut policy = self.load_policy(policy_id);
        if self.env().caller() != policy.owner {
            self.env().revert(Error::NotAuthorized);
        }
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if amount > policy.balance {
            self.env().revert(Error::OverBudget);
        }

        // Checks-effects-interactions: decrement before the transfer.
        let remaining = policy.balance.saturating_sub(amount);
        let owner = policy.owner;
        policy.balance = remaining;
        self.policies.set(&policy_id, policy);

        self.env().transfer_tokens(&owner, &amount);

        self.env().emit_event(Withdrawn {
            policy_id,
            amount,
            remaining,
        });
    }

    /// Pause / unpause a policy. Owner only.
    ///
    /// Reverts [`Error::PolicyNotFound`] / [`Error::NotAuthorized`]. Emits [`PolicyPaused`].
    pub fn pause(&mut self, policy_id: u64, paused: bool) {
        let mut policy = self.load_policy(policy_id);
        if self.env().caller() != policy.owner {
            self.env().revert(Error::NotAuthorized);
        }
        policy.paused = paused;
        self.policies.set(&policy_id, policy);

        self.env().emit_event(PolicyPaused { policy_id, paused });
    }

    /// Fetch a policy. `None` if never opened.
    pub fn get_policy(&self, policy_id: u64) -> Option<Policy> {
        self.policies.get(&policy_id)
    }

    /// Escrow motes currently available for a policy (`0` if unknown).
    pub fn get_remaining(&self, policy_id: u64) -> U512 {
        self.policies
            .get(&policy_id)
            .map(|p| p.balance)
            .unwrap_or_default()
    }

    /// Number of policies opened. Ids are `1..=policies_count()`.
    pub fn policies_count(&self) -> u64 {
        self.policies_count.get_or_default()
    }
}

impl SpendGuard {
    /// Internal: read a policy or revert [`Error::PolicyNotFound`].
    fn load_policy(&self, policy_id: u64) -> Policy {
        self.policies
            .get(&policy_id)
            .unwrap_or_revert_with(&self.env(), Error::PolicyNotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `HostRef` provides `with_tokens` (attach CSPR to a payable call); `Deployer`
    // provides `::deploy`. Both are traits and must be in scope.
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};

    const OWNER: usize = 0; // default caller in OdraVM
    const GATE: usize = 1;
    const PAY_TO: usize = 2;
    const STRANGER: usize = 3;

    fn setup() -> (HostEnv, SpendGuardHostRef) {
        let env = odra_test::env();
        let guard = SpendGuard::deploy(&env, NoArgs);
        (env, guard)
    }

    /// Open a default policy: gate=GATE, budget=10 CSPR, per_call_cap=1 CSPR,
    /// window=60s, max 5 calls/window, min_trust=1. Caller (OWNER) is the owner.
    fn open(env: &HostEnv, guard: &mut SpendGuardHostRef) -> u64 {
        guard.open_policy(
            env.get_account(GATE),
            U512::from(10_000_000_000u64), // budget 10 CSPR
            U512::from(1_000_000_000u64),  // per-call cap 1 CSPR
            60_000,                        // 60s window
            5,                             // max 5 calls/window
            1,                             // min trust tier 1
        )
    }

    fn cspr(n: u64) -> U512 {
        U512::from(n) * U512::from(1_000_000_000u64)
    }

    /// As the gate, fund then approve-debit `amount` motes to PAY_TO.
    fn debit_as_gate(
        env: &HostEnv,
        guard: &mut SpendGuardHostRef,
        id: u64,
        amount: U512,
        reference: &str,
        trust: TrustTier,
    ) {
        env.set_caller(env.get_account(GATE));
        guard.debit(id, 1, amount, env.get_account(PAY_TO), reference.to_string(), trust);
        env.set_caller(env.get_account(OWNER));
    }

    // ───────────────────────── open_policy ─────────────────────────

    #[test]
    fn open_policy_happy_path() {
        let (env, mut guard) = setup();
        env.advance_block_time(7_000);

        let id = open(&env, &mut guard);
        assert_eq!(id, 1);
        assert_eq!(guard.policies_count(), 1);

        let p = guard.get_policy(id).expect("policy exists");
        assert_eq!(p.owner, env.get_account(OWNER));
        assert_eq!(p.gate, env.get_account(GATE));
        assert_eq!(p.budget, U512::from(10_000_000_000u64));
        assert_eq!(p.spent, U512::zero());
        assert_eq!(p.balance, U512::zero());
        assert_eq!(p.per_call_cap, U512::from(1_000_000_000u64));
        assert_eq!(p.window_ms, 60_000);
        assert_eq!(p.max_calls_in_window, 5);
        assert_eq!(p.min_trust_tier, 1);
        assert!(!p.paused);
        assert_eq!(p.created_at, 7_000);

        assert!(env.emitted_event(
            &guard,
            PolicyOpened {
                policy_id: 1,
                owner: env.get_account(OWNER),
                gate: env.get_account(GATE),
                budget: U512::from(10_000_000_000u64),
                per_call_cap: U512::from(1_000_000_000u64),
                window_ms: 60_000,
                max_calls_in_window: 5,
                min_trust_tier: 1,
            }
        ));
    }

    #[test]
    fn open_policy_ids_are_sequential() {
        let (env, mut guard) = setup();
        assert_eq!(open(&env, &mut guard), 1);
        assert_eq!(open(&env, &mut guard), 2);
        assert_eq!(open(&env, &mut guard), 3);
        assert_eq!(guard.policies_count(), 3);
    }

    #[test]
    fn open_policy_invalid_config_reverts() {
        let (env, mut guard) = setup();
        // zero per_call_cap
        assert_eq!(
            guard
                .try_open_policy(env.get_account(GATE), cspr(1), U512::zero(), 1000, 5, 0)
                .unwrap_err(),
            Error::InvalidConfig.into()
        );
        // zero max_calls_in_window
        assert_eq!(
            guard
                .try_open_policy(env.get_account(GATE), cspr(1), cspr(1), 1000, 0, 0)
                .unwrap_err(),
            Error::InvalidConfig.into()
        );
        assert_eq!(guard.policies_count(), 0);
    }

    // ───────────────────────── deposit ─────────────────────────

    #[test]
    fn deposit_increases_balance_and_emits() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);

        guard.with_tokens(cspr(3)).deposit(id);
        assert_eq!(guard.get_remaining(id), cspr(3));

        guard.with_tokens(cspr(2)).deposit(id);
        assert_eq!(guard.get_remaining(id), cspr(5));

        assert!(env.emitted_event(
            &guard,
            Deposited { policy_id: id, amount: cspr(2), new_balance: cspr(5) }
        ));
    }

    #[test]
    fn deposit_zero_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        assert_eq!(
            guard.with_tokens(U512::zero()).try_deposit(id).unwrap_err(),
            Error::ZeroAmount.into()
        );
    }

    #[test]
    fn deposit_unknown_policy_reverts() {
        let (_env, guard) = setup();
        assert_eq!(
            guard.with_tokens(cspr(1)).try_deposit(99).unwrap_err(),
            Error::PolicyNotFound.into()
        );
    }

    // ───────────────────────── debit: happy path ─────────────────────────

    #[test]
    fn debit_approved_moves_funds_and_updates_state() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(5)).deposit(id);

        let pay_to = env.get_account(PAY_TO);
        let before = env.balance_of(&pay_to);

        env.set_caller(env.get_account(GATE));
        guard.debit(id, 42, cspr(1), pay_to, "ref-1".to_string(), 2);

        // funds actually moved to the seller
        assert_eq!(env.balance_of(&pay_to), before + cspr(1));
        // escrow + accounting updated
        assert_eq!(guard.get_remaining(id), cspr(4));
        let p = guard.get_policy(id).unwrap();
        assert_eq!(p.spent, cspr(1));
        assert_eq!(p.balance, cspr(4));

        assert!(env.emitted_event(
            &guard,
            DebitApproved {
                policy_id: id,
                service_id: 42,
                amount: cspr(1),
                pay_to,
                payment_ref: "ref-1".to_string(),
                remaining: cspr(4),
            }
        ));
    }

    // ───────────────────────── debit: revert matrix ─────────────────────────

    #[test]
    fn debit_unknown_policy_reverts() {
        let (env, mut guard) = setup();
        env.set_caller(env.get_account(GATE));
        assert_eq!(
            guard
                .try_debit(99, 1, cspr(1), env.get_account(PAY_TO), "r".to_string(), 5)
                .unwrap_err(),
            Error::PolicyNotFound.into()
        );
    }

    #[test]
    fn debit_by_non_gate_reverts_not_authorized() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(5)).deposit(id);

        // OWNER (the default caller) is NOT the gate.
        for who in [OWNER, STRANGER] {
            env.set_caller(env.get_account(who));
            assert_eq!(
                guard
                    .try_debit(id, 1, cspr(1), env.get_account(PAY_TO), "r".to_string(), 5)
                    .unwrap_err(),
                Error::NotAuthorized.into()
            );
        }
    }

    #[test]
    fn debit_on_paused_policy_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(5)).deposit(id);

        guard.pause(id, true); // owner pauses
        env.set_caller(env.get_account(GATE));
        assert_eq!(
            guard
                .try_debit(id, 1, cspr(1), env.get_account(PAY_TO), "r".to_string(), 5)
                .unwrap_err(),
            Error::Paused.into()
        );
    }

    #[test]
    fn debit_over_per_call_cap_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(10)).deposit(id);

        env.set_caller(env.get_account(GATE));
        // per_call_cap is 1 CSPR; ask for 2.
        assert_eq!(
            guard
                .try_debit(id, 1, cspr(2), env.get_account(PAY_TO), "r".to_string(), 5)
                .unwrap_err(),
            Error::PerCallExceeded.into()
        );
    }

    #[test]
    fn debit_below_min_trust_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(5)).deposit(id);

        env.set_caller(env.get_account(GATE));
        // min_trust_tier is 1; supply 0.
        assert_eq!(
            guard
                .try_debit(id, 1, cspr(1), env.get_account(PAY_TO), "r".to_string(), 0)
                .unwrap_err(),
            Error::UntrustedService.into()
        );
    }

    #[test]
    fn debit_duplicate_ref_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(5)).deposit(id);

        debit_as_gate(&env, &mut guard, id, cspr(1), "dup", 2);

        env.set_caller(env.get_account(GATE));
        assert_eq!(
            guard
                .try_debit(id, 1, cspr(1), env.get_account(PAY_TO), "dup".to_string(), 2)
                .unwrap_err(),
            Error::DuplicateRef.into()
        );
        // unchanged after the second (failed) attempt
        assert_eq!(guard.get_remaining(id), cspr(4));
    }

    #[test]
    fn debit_over_escrow_balance_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(1)).deposit(id); // only 1 CSPR escrowed (cap is 1)

        env.set_caller(env.get_account(GATE));
        // amount within per-call cap but exceeds the 1 CSPR balance? Use exactly cap
        // after spending it once so balance hits 0.
        guard.debit(id, 1, cspr(1), env.get_account(PAY_TO), "a".to_string(), 2);
        assert_eq!(
            guard
                .try_debit(id, 1, cspr(1), env.get_account(PAY_TO), "b".to_string(), 2)
                .unwrap_err(),
            Error::OverBudget.into()
        );
    }

    #[test]
    fn debit_over_cumulative_budget_reverts() {
        let (env, mut guard) = setup();
        // budget 2 CSPR, per_call_cap 1 CSPR, generous escrow.
        let id = guard.open_policy(
            env.get_account(GATE),
            cspr(2),
            cspr(1),
            60_000,
            100,
            0,
        );
        guard.with_tokens(cspr(10)).deposit(id);

        env.set_caller(env.get_account(GATE));
        guard.debit(id, 1, cspr(1), env.get_account(PAY_TO), "c1".to_string(), 0);
        guard.debit(id, 1, cspr(1), env.get_account(PAY_TO), "c2".to_string(), 0);
        // spent == budget == 2; a third call pushes spent past budget though escrow is fine.
        assert_eq!(
            guard
                .try_debit(id, 1, cspr(1), env.get_account(PAY_TO), "c3".to_string(), 0)
                .unwrap_err(),
            Error::OverBudget.into()
        );
    }

    // ───────────────────────── rate window ─────────────────────────

    #[test]
    fn debit_rate_limit_trips_then_resets_after_window() {
        let (env, mut guard) = setup();
        // 2 calls / 10s window, big budget & cap.
        let id = guard.open_policy(env.get_account(GATE), cspr(100), cspr(1), 10_000, 2, 0);
        guard.with_tokens(cspr(50)).deposit(id);
        env.set_caller(env.get_account(GATE));

        guard.debit(id, 1, cspr(1), env.get_account(PAY_TO), "w1".to_string(), 0);
        guard.debit(id, 1, cspr(1), env.get_account(PAY_TO), "w2".to_string(), 0);
        // third within the same window → RateExceeded
        assert_eq!(
            guard
                .try_debit(id, 1, cspr(1), env.get_account(PAY_TO), "w3".to_string(), 0)
                .unwrap_err(),
            Error::RateExceeded.into()
        );

        // advance past the window → allowed again
        env.advance_block_time(10_001);
        guard.debit(id, 1, cspr(1), env.get_account(PAY_TO), "w4".to_string(), 0);
        assert_eq!(guard.get_policy(id).unwrap().spent, cspr(3));
    }

    // ───────────────────────── pause auth ─────────────────────────

    #[test]
    fn only_owner_can_pause() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);

        // gate and stranger cannot pause — owner only.
        for who in [GATE, STRANGER] {
            env.set_caller(env.get_account(who));
            assert_eq!(guard.try_pause(id, true).unwrap_err(), Error::NotAuthorized.into());
        }
        assert!(!guard.get_policy(id).unwrap().paused);

        env.set_caller(env.get_account(OWNER));
        guard.pause(id, true);
        assert!(guard.get_policy(id).unwrap().paused);
        assert!(env.emitted_event(&guard, PolicyPaused { policy_id: id, paused: true }));

        guard.pause(id, false);
        assert!(!guard.get_policy(id).unwrap().paused);
    }

    #[test]
    fn pause_unknown_policy_reverts() {
        let (_env, mut guard) = setup();
        assert_eq!(guard.try_pause(7, true).unwrap_err(), Error::PolicyNotFound.into());
    }

    // ───────────────────────── open_policy: more invalid configs ─────────────────────────

    #[test]
    fn open_policy_zero_budget_reverts() {
        let (env, mut guard) = setup();
        assert_eq!(
            guard
                .try_open_policy(env.get_account(GATE), U512::zero(), cspr(1), 1000, 5, 0)
                .unwrap_err(),
            Error::InvalidConfig.into()
        );
        assert_eq!(guard.policies_count(), 0);
    }

    #[test]
    fn open_policy_per_call_cap_above_budget_reverts() {
        let (env, mut guard) = setup();
        // per_call_cap (2) > budget (1) is nonsensical.
        assert_eq!(
            guard
                .try_open_policy(env.get_account(GATE), cspr(1), cspr(2), 1000, 5, 0)
                .unwrap_err(),
            Error::InvalidConfig.into()
        );
        assert_eq!(guard.policies_count(), 0);
    }

    // ───────────────────────── withdraw ─────────────────────────

    #[test]
    fn withdraw_returns_escrow_to_owner() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(5)).deposit(id);

        let owner = env.get_account(OWNER);
        let before = env.balance_of(&owner);

        guard.withdraw(id, cspr(2)); // OWNER is the default caller
        assert_eq!(env.balance_of(&owner), before + cspr(2));
        assert_eq!(guard.get_remaining(id), cspr(3));
        assert!(env.emitted_event(
            &guard,
            Withdrawn { policy_id: id, amount: cspr(2), remaining: cspr(3) }
        ));
    }

    #[test]
    fn withdraw_by_non_owner_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(5)).deposit(id);
        for who in [GATE, STRANGER] {
            env.set_caller(env.get_account(who));
            assert_eq!(guard.try_withdraw(id, cspr(1)).unwrap_err(), Error::NotAuthorized.into());
        }
        assert_eq!(guard.get_remaining(id), cspr(5));
    }

    #[test]
    fn withdraw_over_balance_reverts() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(1)).deposit(id);
        assert_eq!(guard.try_withdraw(id, cspr(2)).unwrap_err(), Error::OverBudget.into());
        assert_eq!(guard.try_withdraw(id, U512::zero()).unwrap_err(), Error::ZeroAmount.into());
    }

    #[test]
    fn withdraw_works_after_pause_so_funds_are_never_locked() {
        let (env, mut guard) = setup();
        let id = open(&env, &mut guard);
        guard.with_tokens(cspr(4)).deposit(id);
        guard.pause(id, true); // kill-switch on
        guard.withdraw(id, cspr(4)); // owner can still reclaim
        assert_eq!(guard.get_remaining(id), U512::zero());
    }

    // ───────────────────────── reads ─────────────────────────

    #[test]
    fn unknown_reads_return_defaults() {
        let (_env, guard) = setup();
        assert!(guard.get_policy(123).is_none());
        assert_eq!(guard.get_remaining(123), U512::zero());
        assert_eq!(guard.policies_count(), 0);
    }
}
