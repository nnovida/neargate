//! AgentGate on-chain layer (Odra 2.7.x, Casper) — SPEC §10.
//!
//! A single contract, [`AgentGateRegistry`], provides:
//!
//! * **Service discovery** — sellers register paid HTTP services (name, price
//!   in motes, payment target account, attestor key). The public endpoint URL
//!   is **not** stored verbatim: the contract stores `gateway_base_url` and
//!   every reader computes `endpoint_url = {gateway_base_url}/svc/{id}`.
//! * **Reputation** — the AgentGate middleware (or the service owner) records
//!   one attestation per payment deploy hash after serving a paid call. Scores
//!   are `(total_calls, success_calls)` counters; the attestation list is
//!   capped at the last 100 entries per service.
//!
//! The crate is listed in `Odra.toml` as
//! `agentgate_registry::AgentGateRegistry` so cargo-odra can build
//! `wasm/AgentGateRegistry.wasm`.

#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
extern crate alloc;

pub mod registry;

pub use registry::{
    AgentGateRegistry, Attestation, AttestationRecorded, Error, PaymentOption, Service,
    ServiceRegistered, ServiceStatusChanged,
};
