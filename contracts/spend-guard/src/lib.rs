//! AgentGate x402 **SpendGuard** — on-chain spend-firewall escrow (Odra 2.7.x, Casper).
//!
//! The missing safety primitive for agentic payments. Casper x402 makes per-call
//! payments gasless and frictionless via a sponsored Facilitator — which is
//! exactly what makes a looping, LLM-driven buyer agent dangerous: a buggy,
//! runaway, or prompt-injected agent can drain a budget across hundreds of
//! micro-payments with no atomic, attacker-proof stop.
//!
//! [`SpendGuard`] is that stop. An agent opens a [`Policy`] (budget, per-call
//! cap, rate window, minimum counterparty trust tier) and pre-funds a per-policy
//! escrow with [`SpendGuard::deposit`]. Before serving an x402 paid call, the
//! AgentGate middleware calls [`SpendGuard::debit`] — which **atomically reverts**
//! on any policy violation, so the payment never settles. It is the seatbelt the
//! agent wears, enforced on-chain, not an off-chain budget check that a compromised
//! agent can bypass.
//!
//! The crate is listed in `Odra.toml` as `spend_guard::SpendGuard` so cargo-odra
//! can build `wasm/SpendGuard.wasm`.

#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
extern crate alloc;

pub mod spend_guard;

pub use spend_guard::{
    DebitApproved, Deposited, Error, Policy, PolicyOpened, PolicyPaused, SpendGuard,
};
