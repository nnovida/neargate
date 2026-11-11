//! Stored structs and JSON views of the NearGate registry.
//!
//! Stored types are Borsh-only; views are JSON-only (snake_case, `U128` amounts as decimal
//! strings). The two never share a type, so a storage change cannot leak into the ABI.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

// ---------------------------------------------------------------------------------------------
// Shared input/output type
// ---------------------------------------------------------------------------------------------

/// One way to pay for a service. `asset == "near"` is the native option the registry's `pay`
/// settles; any other asset is advertised only (at most four options per service).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentOption {
    pub asset: String,
    pub amount: U128,
    pub decimals: u8,
    pub symbol: String,
}

// ---------------------------------------------------------------------------------------------
// Stored
// ---------------------------------------------------------------------------------------------

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Service {
    pub name: String,
    pub description: String,
    pub gateway_base_url: String,
    pub accepts: Vec<PaymentOption>,
    pub payment_target: AccountId,
    pub owner: AccountId,
    pub attestor: AccountId,
    pub active: bool,
    pub created_at_ms: u64,
}

/// A payment the registry itself received. Keyed by nonce; never deleted (replay protection).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub service_id: u64,
    pub payer: AccountId,
    pub amount: u128,
    pub timestamp_ms: u64,
    pub block_height: u64,
    pub self_paid: bool,
    pub attested: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub nonce: String,
    pub payment_tx_hash: String,
    pub success: bool,
    pub timestamp_ms: u64,
}

/// One slot of the activity ring buffer.
///
/// `Payment` stores only the nonce: the payer, amount, timestamp and block height already live
/// in the payment record, and repeating them would push one `pay` past its storage fee.
/// `Empty` is a placeholder that `new()` writes into every slot, so a ring write replaces a
/// record instead of creating one (see `Registry::new`).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub enum ActivityEntry {
    Empty,
    ServiceRegistered {
        service_id: u64,
        account: AccountId,
        timestamp_ms: u64,
        block_height: u64,
    },
    Payment {
        nonce: String,
    },
    Attestation {
        service_id: u64,
        account: AccountId,
        success: bool,
        nonce: String,
        payment_tx_hash: String,
        timestamp_ms: u64,
        block_height: u64,
    },
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceView {
    pub id: u64,
    pub name: String,
    pub description: String,
    pub gateway_base_url: String,
    pub accepts: Vec<PaymentOption>,
    pub payment_target: AccountId,
    pub owner: AccountId,
    pub attestor: AccountId,
    pub active: bool,
    pub created_at_ms: u64,
}

impl ServiceView {
    pub fn new(id: u64, s: &Service) -> Self {
        Self {
            id,
            name: s.name.clone(),
            description: s.description.clone(),
            gateway_base_url: s.gateway_base_url.clone(),
            accepts: s.accepts.clone(),
            payment_target: s.payment_target.clone(),
            owner: s.owner.clone(),
            attestor: s.attestor.clone(),
            active: s.active,
            created_at_ms: s.created_at_ms,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScoreView {
    pub total_calls: u64,
    pub success_calls: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationView {
    pub nonce: String,
    pub payment_tx_hash: String,
    pub success: bool,
    pub timestamp_ms: u64,
}

impl From<&Attestation> for AttestationView {
    fn from(a: &Attestation) -> Self {
        Self {
            nonce: a.nonce.clone(),
            payment_tx_hash: a.payment_tx_hash.clone(),
            success: a.success,
            timestamp_ms: a.timestamp_ms,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentView {
    pub nonce: String,
    pub service_id: u64,
    pub payer: AccountId,
    pub amount: U128,
    pub timestamp_ms: u64,
    pub block_height: u64,
    pub self_paid: bool,
    pub attested: bool,
}

impl PaymentView {
    pub fn new(nonce: &str, p: &Payment) -> Self {
        Self {
            nonce: nonce.to_string(),
            service_id: p.service_id,
            payer: p.payer.clone(),
            amount: U128(p.amount),
            timestamp_ms: p.timestamp_ms,
            block_height: p.block_height,
            self_paid: p.self_paid,
            attested: p.attested,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    ServiceRegistered,
    Payment,
    Attestation,
}

/// `account` is the owner for `service_registered`, the payer for `payment` and the caller
/// (attestor or owner) for `attestation`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityView {
    pub kind: ActivityKind,
    pub service_id: u64,
    pub account: AccountId,
    pub amount: Option<U128>,
    pub success: Option<bool>,
    pub nonce: Option<String>,
    pub payment_tx_hash: Option<String>,
    pub timestamp_ms: u64,
    pub block_height: u64,
}
