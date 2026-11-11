//! NearGate registry: a pay-through service registry with payment-backed attestations.
//!
//! Buyers pay *through* the registry. `pay(service_id, nonce)` forwards exactly the price to
//! the seller's `payment_target`, keeps a small storage fee, refunds the rest and stores a
//! payment record. `record_attestation` is only accepted for a payment this contract itself
//! received, once, and never for a self-payment (payer is the service owner or the payment
//! target), so a score can only come from real transfers between distinct parties.
//!
//! The contract has no owner and no admin. The only privileged roles are per service: the
//! service owner and the service attestor.
//!
//! Every panic message starts with a stable `ERR_*` code; clients map errors by that prefix.

mod types;
pub use types::*;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, env, near};

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------------------------
// Constants (D2)
// ---------------------------------------------------------------------------------------------

/// 0.000001 NEAR. The floor for the `"near"` option only: other assets are priced in their own
/// base units (a 6-decimal token needs `amount > 0`, not 10^18 units).
pub const MIN_PRICE_YOCTO: u128 = 1_000_000_000_000_000_000;
/// 0.002 NEAR: kept by the registry on every `pay` to cover the payment record's storage.
pub const PAYMENT_STORAGE_FEE_YOCTO: u128 = 2_000_000_000_000_000_000_000;
/// 0.12 NEAR: kept by the registry on every `register_service`. It prepays the service record
/// and [`ATTESTATION_RESERVE_YOCTO`], the storage the service can later fill with attestations.
pub const REGISTRATION_DEPOSIT_YOCTO: u128 = 120_000_000_000_000_000_000_000;

pub const MAX_ATTESTATIONS: usize = 100;
pub const ACTIVITY_CAP: u64 = 200;
pub const NAME_MAX: usize = 64;
pub const DESC_MAX: usize = 280;
pub const URL_MAX: usize = 200;
pub const ACCEPTS_MAX: usize = 4;
pub const TX_HASH_MAX: usize = 64;
pub const NONCE_MAX: usize = 20;
pub const LIST_LIMIT_MAX: u64 = 50;

/// Yocto per stored byte (protocol constant `storage_amount_per_byte`; asserted against
/// `env::storage_byte_cost()` in the unit tests).
pub const STORAGE_BYTE_COST_YOCTO: u128 = 10_000_000_000_000_000_000;

/// Bytes the protocol adds to every trie record on top of its key and value
/// (`num_extra_bytes_record`).
const RECORD_OVERHEAD_BYTES: u128 = 40;
/// A `LookupMap<u64, _>` key: one prefix byte plus the Borsh `u64`.
const U64_KEY_BYTES: u128 = 1 + 8;
/// Borsh size of the largest `Attestation`: `nonce` (4-byte length + 20 digits), `payment_tx_hash`
/// (4 + 64 bytes), `success` (1) and `timestamp_ms` (8).
const MAX_ATTESTATION_BYTES: u128 = (4 + NONCE_MAX as u128) + (4 + TX_HASH_MAX as u128) + 1 + 8;
/// The `scores` record of a service: key + `(u64, u64)` value + record overhead.
const SCORE_RECORD_BYTES: u128 = RECORD_OVERHEAD_BYTES + U64_KEY_BYTES + 16;
/// The `attestations` record of a service at its cap: key + (4-byte Vec length + 100 maximal
/// entries) + record overhead.
const ATTESTATION_LIST_RECORD_BYTES: u128 =
    RECORD_OVERHEAD_BYTES + U64_KEY_BYTES + 4 + MAX_ATTESTATIONS as u128 * MAX_ATTESTATION_BYTES;
/// Everything `record_attestation` can store for one service, in bytes:
/// score `40 + 9 + 16 = 65`, plus list `40 + 9 + 4 + 100 * 101 = 10_153`, in total 10_218.
pub const ATTESTATION_RESERVE_BYTES: u128 = SCORE_RECORD_BYTES + ATTESTATION_LIST_RECORD_BYTES;
/// [`ATTESTATION_RESERVE_BYTES`] in yocto: `10_218 * 10^19 = 1.0218 * 10^23` (0.10218 NEAR).
///
/// `record_attestation` is not payable and has no storage check, so a service's attestation
/// storage must be paid up front. `register_service` therefore requires the measured cost of the
/// registration plus this reserve to fit inside [`REGISTRATION_DEPOSIT_YOCTO`]. The attestation
/// list is capped at [`MAX_ATTESTATIONS`] entries and every field in it is bounded in bytes, so a
/// service can never store more than this, however it is used. The other 1_782 bytes of the
/// deposit cover the registration itself: at most 1_466 bytes with every field at its maximum,
/// counting its activity-ring entry.
pub const ATTESTATION_RESERVE_YOCTO: u128 = ATTESTATION_RESERVE_BYTES * STORAGE_BYTE_COST_YOCTO;

// The deposit must leave room for a service record on top of the reserve.
const _: () = assert!(ATTESTATION_RESERVE_YOCTO < REGISTRATION_DEPOSIT_YOCTO);

/// The `asset` string of the one option `pay` can settle.
pub const NATIVE_ASSET: &str = "near";

// ---------------------------------------------------------------------------------------------
// Events (NEP-297)
// ---------------------------------------------------------------------------------------------

#[near(event_json(standard = "neargate"))]
pub enum NearGateEvent {
    #[event_version("1.0.0")]
    ServiceRegistered {
        service_id: u64,
        owner: AccountId,
        name: String,
        payment_target: AccountId,
        attestor: AccountId,
    },
    #[event_version("1.0.0")]
    Payment {
        service_id: u64,
        nonce: String,
        payer: AccountId,
        amount: U128,
        self_paid: bool,
    },
    #[event_version("1.0.0")]
    Attestation {
        service_id: u64,
        nonce: String,
        payment_tx_hash: String,
        success: bool,
        caller: AccountId,
    },
    #[event_version("1.0.0")]
    ServiceStatus { service_id: u64, active: bool },
    #[event_version("1.0.0")]
    AttestorChanged {
        service_id: u64,
        attestor: AccountId,
    },
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Services,
    Scores,
    Payments,
    Attestations,
    Activity,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    /// Number of registered services; also the id of the newest one (ids are 1-based).
    services_count: u64,
    services: LookupMap<u64, Service>,
    /// `(total_calls, success_calls)`; absent until a service's first attestation.
    scores: LookupMap<u64, (u64, u64)>,
    /// Keyed by nonce. Never deleted: that is what makes a nonce single-use.
    payments: LookupMap<String, Payment>,
    /// Newest first, at most `MAX_ATTESTATIONS` per service.
    attestations: LookupMap<u64, Vec<Attestation>>,
    /// Ring buffer of the last `ACTIVITY_CAP` events; slot = `activity_head % ACTIVITY_CAP`.
    activity: LookupMap<u64, ActivityEntry>,
    /// Number of events ever written.
    activity_head: u64,
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// `require!` without its debug-build `assert!` path, so unit tests see exactly the panic
/// message (and its `ERR_*` prefix) that the wasm build produces.
macro_rules! ensure {
    ($cond:expr, $message:expr $(,)?) => {
        if !$cond {
            env::panic_str(&$message);
        }
    };
}

fn is_valid_nonce(nonce: &str) -> bool {
    (1..=NONCE_MAX).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_digit())
}

/// Limits are in bytes (UTF-8), not characters: storage is paid per byte, and a character can
/// take four.
fn check_len(field: &str, value: &str, max: usize) {
    if value.len() > max {
        env::panic_str(&format!(
            "ERR_FIELD_TOO_LONG: {field} is longer than {max} bytes"
        ));
    }
}

fn validate_accepts(accepts: &[PaymentOption]) {
    ensure!(
        !accepts.is_empty() && accepts.len() <= ACCEPTS_MAX,
        "ERR_INVALID_PRICE: accepts must hold between 1 and 4 options"
    );
    let mut natives = 0;
    for option in accepts {
        if option.asset == NATIVE_ASSET {
            natives += 1;
            ensure!(
                option.amount.0 >= MIN_PRICE_YOCTO,
                "ERR_INVALID_PRICE: the near amount must be at least 1000000000000000000 yocto"
            );
        } else {
            ensure!(
                option.amount.0 > 0,
                "ERR_INVALID_PRICE: the amount must be greater than zero"
            );
        }
        check_len("accepts.asset", &option.asset, NAME_MAX);
        check_len("accepts.symbol", &option.symbol, NAME_MAX);
    }
    ensure!(
        natives <= 1,
        "ERR_INVALID_PRICE: at most one option may use asset \"near\""
    );
}

/// Panics `ERR_STORAGE_EXCEEDED` when a call's measured storage cost is above its budget.
pub(crate) fn check_storage(cost_yocto: u128, budget_yocto: u128) {
    if cost_yocto > budget_yocto {
        env::panic_str(&format!(
            "ERR_STORAGE_EXCEEDED: the call needs {cost_yocto} yocto of storage, \
             the budget is {budget_yocto}"
        ));
    }
}

fn refund(to: &AccountId, attached: u128, kept: u128) {
    let excess = attached.saturating_sub(kept);
    if excess > 0 {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(excess))
            .detach();
    }
}

impl Registry {
    fn service(&self, service_id: u64) -> &Service {
        self.services
            .get(&service_id)
            .unwrap_or_else(|| env::panic_str("ERR_SERVICE_NOT_FOUND: no such service"))
    }

    fn owned_service_mut(&mut self, service_id: u64) -> &mut Service {
        let caller = env::predecessor_account_id();
        let service = self
            .services
            .get_mut(&service_id)
            .unwrap_or_else(|| env::panic_str("ERR_SERVICE_NOT_FOUND: no such service"));
        ensure!(
            service.owner == caller,
            "ERR_NOT_AUTHORIZED: only the service owner may do this"
        );
        service
    }

    fn push_activity(&mut self, entry: ActivityEntry) {
        let slot = self.activity_head % ACTIVITY_CAP;
        self.activity.set(slot, Some(entry));
        self.activity_head += 1;
    }

    /// Writes every cached change to storage. Dropping the contract does the same at the end
    /// of each call; doing it explicitly lets a call measure its own storage use, and keeps
    /// unit tests (which reuse one instance across calls) faithful to a real execution.
    fn flush_all(&mut self) {
        self.services.flush();
        self.scores.flush();
        self.payments.flush();
        self.attestations.flush();
        self.activity.flush();
    }

    /// Flushes, then returns the storage those writes added since `usage_before`, in yocto.
    /// A call that shrinks storage (a ring slot overwritten by a smaller entry) counts as zero.
    fn storage_cost_since(&mut self, usage_before: u64) -> u128 {
        self.flush_all();
        let grown = env::storage_usage().saturating_sub(usage_before);
        u128::from(grown) * env::storage_byte_cost().as_yoctonear()
    }

    fn activity_view(&self, entry: &ActivityEntry) -> Option<ActivityView> {
        match entry {
            ActivityEntry::Empty => None,
            ActivityEntry::ServiceRegistered {
                service_id,
                account,
                timestamp_ms,
                block_height,
            } => Some(ActivityView {
                kind: ActivityKind::ServiceRegistered,
                service_id: *service_id,
                account: account.clone(),
                amount: None,
                success: None,
                nonce: None,
                payment_tx_hash: None,
                timestamp_ms: *timestamp_ms,
                block_height: *block_height,
            }),
            ActivityEntry::Payment { nonce } => {
                let p = self.payments.get(nonce)?;
                Some(ActivityView {
                    kind: ActivityKind::Payment,
                    service_id: p.service_id,
                    account: p.payer.clone(),
                    amount: Some(U128(p.amount)),
                    success: None,
                    nonce: Some(nonce.clone()),
                    payment_tx_hash: None,
                    timestamp_ms: p.timestamp_ms,
                    block_height: p.block_height,
                })
            }
            ActivityEntry::Attestation {
                service_id,
                account,
                success,
                nonce,
                payment_tx_hash,
                timestamp_ms,
                block_height,
            } => Some(ActivityView {
                kind: ActivityKind::Attestation,
                service_id: *service_id,
                account: account.clone(),
                amount: None,
                success: Some(*success),
                nonce: Some(nonce.clone()),
                payment_tx_hash: Some(payment_tx_hash.clone()),
                timestamp_ms: *timestamp_ms,
                block_height: *block_height,
            }),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------

#[near]
impl Registry {
    /// One-time init. It takes no arguments, so there is nothing to front-run, and it sets no
    /// admin: the registry has no owner.
    ///
    /// Every activity slot is pre-written with a one-byte placeholder. The contract account
    /// pays for those records here, once, so a later `pay` replaces a slot instead of creating
    /// a record and its cost stays inside `PAYMENT_STORAGE_FEE_YOCTO` for any account id.
    #[init]
    pub fn new() -> Self {
        let mut activity = LookupMap::new(StorageKey::Activity);
        for slot in 0..ACTIVITY_CAP {
            activity.set(slot, Some(ActivityEntry::Empty));
        }
        activity.flush();
        Self {
            services_count: 0,
            services: LookupMap::new(StorageKey::Services),
            scores: LookupMap::new(StorageKey::Scores),
            payments: LookupMap::new(StorageKey::Payments),
            attestations: LookupMap::new(StorageKey::Attestations),
            activity,
            activity_head: 0,
        }
    }

    // -----------------------------------------------------------------------------------------
    // Change methods
    // -----------------------------------------------------------------------------------------

    /// Registers a service owned by the caller and returns its id (1-based).
    ///
    /// The registry keeps `REGISTRATION_DEPOSIT_YOCTO` and refunds anything above it. The deposit
    /// prepays the service record and `ATTESTATION_RESERVE_YOCTO`; the call panics
    /// `ERR_STORAGE_EXCEEDED` if those together would not fit.
    #[payable]
    pub fn register_service(
        &mut self,
        name: String,
        description: String,
        gateway_base_url: String,
        accepts: Vec<PaymentOption>,
        payment_target: AccountId,
        attestor: AccountId,
    ) -> u64 {
        let usage_before = env::storage_usage();

        let name = name.trim().to_string();
        ensure!(
            !name.is_empty(),
            "ERR_EMPTY_NAME: the service name must not be blank"
        );
        check_len("name", &name, NAME_MAX);
        check_len("description", &description, DESC_MAX);
        check_len("gateway_base_url", &gateway_base_url, URL_MAX);
        validate_accepts(&accepts);

        let attached = env::attached_deposit().as_yoctonear();
        ensure!(
            attached >= REGISTRATION_DEPOSIT_YOCTO,
            "ERR_DEPOSIT_TOO_LOW: attach at least 120000000000000000000000 yocto (0.12 NEAR)"
        );

        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let id = self.services_count + 1;
        self.services_count = id;
        self.services.set(
            id,
            Some(Service {
                name: name.clone(),
                description,
                gateway_base_url,
                accepts,
                payment_target: payment_target.clone(),
                owner: owner.clone(),
                attestor: attestor.clone(),
                active: true,
                created_at_ms: now,
            }),
        );
        self.push_activity(ActivityEntry::ServiceRegistered {
            service_id: id,
            account: owner.clone(),
            timestamp_ms: now,
            block_height: env::block_height(),
        });

        // The registration's own storage plus the reserve for everything the service can later
        // store through `record_attestation` (which is not payable) must fit in the deposit.
        check_storage(
            self.storage_cost_since(usage_before) + ATTESTATION_RESERVE_YOCTO,
            REGISTRATION_DEPOSIT_YOCTO,
        );
        refund(&owner, attached, REGISTRATION_DEPOSIT_YOCTO);
        NearGateEvent::ServiceRegistered {
            service_id: id,
            owner,
            name,
            payment_target,
            attestor,
        }
        .emit();
        id
    }

    /// Pays for one call of a service. The attached deposit must cover the service's native
    /// price plus `PAYMENT_STORAGE_FEE_YOCTO`. The price goes to the service's
    /// `payment_target`, the fee stays here, the rest returns to the caller.
    ///
    /// `nonce` is single-use across the whole registry: 1 to 20 decimal digits.
    #[payable]
    pub fn pay(&mut self, service_id: u64, nonce: String) {
        let usage_before = env::storage_usage();

        let (price, target, owner) = {
            let service = self.service(service_id);
            ensure!(
                service.active,
                "ERR_SERVICE_INACTIVE: the service is switched off"
            );
            let price = service
                .accepts
                .iter()
                .find(|o| o.asset == NATIVE_ASSET)
                .map(|o| o.amount.0)
                .unwrap_or_else(|| env::panic_str("ERR_NO_NATIVE_PRICE: no \"near\" option"));
            (price, service.payment_target.clone(), service.owner.clone())
        };

        let attached = env::attached_deposit().as_yoctonear();
        let required = price.saturating_add(PAYMENT_STORAGE_FEE_YOCTO);
        ensure!(
            attached >= required,
            format!("ERR_DEPOSIT_TOO_LOW: attach at least {required} yocto (price + storage fee)")
        );
        ensure!(
            is_valid_nonce(&nonce),
            "ERR_INVALID_NONCE: the nonce must be 1 to 20 decimal digits"
        );
        ensure!(
            !self.payments.contains_key(&nonce),
            "ERR_NONCE_USED: nonce already paid"
        );

        let payer = env::predecessor_account_id();
        let self_paid = payer == owner || payer == target;
        self.payments.set(
            nonce.clone(),
            Some(Payment {
                service_id,
                payer: payer.clone(),
                amount: price,
                timestamp_ms: env::block_timestamp_ms(),
                block_height: env::block_height(),
                self_paid,
                attested: false,
            }),
        );
        self.push_activity(ActivityEntry::Payment {
            nonce: nonce.clone(),
        });

        check_storage(
            self.storage_cost_since(usage_before),
            PAYMENT_STORAGE_FEE_YOCTO,
        );
        Promise::new(target)
            .transfer(NearToken::from_yoctonear(price))
            .detach();
        refund(&payer, attached, required);
        NearGateEvent::Payment {
            service_id,
            nonce,
            payer,
            amount: U128(price),
            self_paid,
        }
        .emit();
    }

    /// Records the outcome of the service call that followed a payment. Only the service's
    /// attestor or owner may call it, once per payment, and never for a self-payment.
    ///
    /// `payment_tx_hash` is the transaction that paid (informational, at most 64 bytes).
    pub fn record_attestation(
        &mut self,
        service_id: u64,
        nonce: String,
        payment_tx_hash: String,
        success: bool,
    ) {
        let caller = env::predecessor_account_id();
        {
            let service = self.service(service_id);
            ensure!(
                caller == service.attestor || caller == service.owner,
                "ERR_NOT_AUTHORIZED: only the attestor or the owner may attest"
            );
            ensure!(
                service.active,
                "ERR_SERVICE_INACTIVE: the service is switched off"
            );
        }
        check_len("payment_tx_hash", &payment_tx_hash, TX_HASH_MAX);

        let payment = self
            .payments
            .get_mut(&nonce)
            .unwrap_or_else(|| env::panic_str("ERR_PAYMENT_NOT_FOUND: no payment with this nonce"));
        ensure!(
            payment.service_id == service_id,
            "ERR_PAYMENT_WRONG_SERVICE: the payment belongs to another service"
        );
        ensure!(
            !payment.attested,
            "ERR_ALREADY_ATTESTED: this payment is already attested"
        );
        ensure!(
            !payment.self_paid,
            "ERR_SELF_PAYMENT: the owner or payment target paid; it cannot be attested"
        );
        payment.attested = true;

        let now = env::block_timestamp_ms();
        let (total, ok) = self.scores.get(&service_id).copied().unwrap_or((0, 0));
        self.scores
            .set(service_id, Some((total + 1, ok + u64::from(success))));

        let attestation = Attestation {
            nonce: nonce.clone(),
            payment_tx_hash: payment_tx_hash.clone(),
            success,
            timestamp_ms: now,
        };
        match self.attestations.get_mut(&service_id) {
            Some(list) => {
                list.insert(0, attestation);
                list.truncate(MAX_ATTESTATIONS);
            }
            None => self.attestations.set(service_id, Some(vec![attestation])),
        }
        self.push_activity(ActivityEntry::Attestation {
            service_id,
            account: caller.clone(),
            success,
            nonce: nonce.clone(),
            payment_tx_hash: payment_tx_hash.clone(),
            timestamp_ms: now,
            block_height: env::block_height(),
        });
        self.flush_all();
        NearGateEvent::Attestation {
            service_id,
            nonce,
            payment_tx_hash,
            success,
            caller,
        }
        .emit();
    }

    /// Owner only. An inactive service accepts no new payments or attestations.
    pub fn set_active(&mut self, service_id: u64, active: bool) {
        self.owned_service_mut(service_id).active = active;
        self.flush_all();
        NearGateEvent::ServiceStatus { service_id, active }.emit();
    }

    /// Owner only. Replaces the account that may record attestations (the owner always may).
    /// Its storage growth (at most 60 bytes, a short account id swapped for a 64-byte one) is
    /// inside the registration deposit: even a service registered with every field at its maximum
    /// leaves 316 of the 12_000 deposit bytes unused.
    pub fn set_attestor(&mut self, service_id: u64, attestor: AccountId) {
        self.owned_service_mut(service_id).attestor = attestor.clone();
        self.flush_all();
        NearGateEvent::AttestorChanged {
            service_id,
            attestor,
        }
        .emit();
    }

    // -----------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------

    pub fn get_service(&self, service_id: u64) -> Option<ServiceView> {
        self.services
            .get(&service_id)
            .map(|s| ServiceView::new(service_id, s))
    }

    /// Services with ids `from_index..` ascending (ids are 1-based; `from_index` 0 starts at 1).
    /// `limit` is clamped to `LIST_LIMIT_MAX`.
    pub fn list_services(&self, from_index: u64, limit: u64) -> Vec<ServiceView> {
        let start = from_index.max(1);
        let end = start
            .saturating_add(limit.min(LIST_LIMIT_MAX))
            .min(self.services_count + 1);
        (start..end)
            .filter_map(|id| self.services.get(&id).map(|s| ServiceView::new(id, s)))
            .collect()
    }

    pub fn services_count(&self) -> u64 {
        self.services_count
    }

    pub fn get_score(&self, service_id: u64) -> ScoreView {
        let (total_calls, success_calls) = self.scores.get(&service_id).copied().unwrap_or((0, 0));
        ScoreView {
            total_calls,
            success_calls,
        }
    }

    /// Newest first, at most `MAX_ATTESTATIONS`.
    pub fn get_attestations(&self, service_id: u64) -> Vec<AttestationView> {
        self.attestations
            .get(&service_id)
            .map(|list| list.iter().map(AttestationView::from).collect())
            .unwrap_or_default()
    }

    pub fn get_payment(&self, nonce: String) -> Option<PaymentView> {
        self.payments
            .get(&nonce)
            .map(|p| PaymentView::new(&nonce, p))
    }

    /// Newest first. `limit` is clamped to `ACTIVITY_CAP`.
    pub fn get_recent_activity(&self, limit: u64) -> Vec<ActivityView> {
        let n = limit.min(ACTIVITY_CAP).min(self.activity_head);
        (0..n)
            .filter_map(|i| {
                let slot = (self.activity_head - 1 - i) % ACTIVITY_CAP;
                self.activity
                    .get(&slot)
                    .and_then(|entry| self.activity_view(entry))
            })
            .collect()
    }
}
