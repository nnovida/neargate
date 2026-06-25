//! `AgentGateRegistry` — service discovery + payment attestation reputation.
//!
//! Storage, entrypoints, events and errors exactly per SPEC §10.
//!
//! Design notes:
//! * `gateway_base_url` is stored as-is; readers (devnet, chain client,
//!   dashboard) compute the public endpoint as `{gateway_base_url}/svc/{id}`.
//!   The contract never concatenates URLs on-chain.
//! * Money is `U512` motes (`odra::casper_types::U512` — NOT in the prelude).
//!   Minimum price is 1000 motes (1e-6 CSPR) to keep dust out of the catalog.
//! * `seen_payments` guards one attestation per `(service_id,
//!   payment_deploy_hash)` so a middleware retry (or a malicious owner) cannot
//!   double-count a payment.
//! * The attestation list is capped at the last [`MAX_ATTESTATIONS`] entries
//!   per service (oldest dropped) and stored newest-first to match the SPEC,
//!   devnet and dashboard; the `(total, success)` score counters keep the full
//!   history.
//! * Service ids are 1-based (`1..=services_count`): `register_service`
//!   increments the counter first, then assigns that value as the id. This
//!   keeps the off-chain readers (devnet, chain client, dashboard) — which all
//!   treat id `0` as "absent" — consistent with the contract.

// `odra::prelude::*` re-exports the storage primitives (`Var`, `Mapping`),
// `Address`, alloc strings/vecs and `UnwrapOrRevert`. Importing them via
// explicit `odra::Var`-style paths clashes with the `#[odra::module]` codegen,
// so rely on the prelude only (matches the Odra 2.7 examples).
use odra::prelude::*;
// `U512` (native CSPR motes type) is re-exported through `casper_types`,
// NOT the Odra prelude.
use odra::casper_types::U512;

/// Minimum service price: 1000 motes (SPEC §10 — `price >= 1000`).
pub const MIN_PRICE_MOTES: u64 = 1000;

/// Attestation list cap per service: keep only the last 100, drop the oldest.
pub const MAX_ATTESTATIONS: usize = 100;

/// On-chain record describing one registered (wrapped) service.
#[odra::odra_type]
pub struct Service {
    /// Human-readable service name (non-empty; enforced at registration).
    pub name: String,
    /// Short description shown in catalog listings.
    pub description: String,
    /// Base URL of the AgentGate middleware that fronts this service.
    /// Readers compute the public endpoint as `{gateway_base_url}/svc/{id}`.
    pub gateway_base_url: String,
    /// Price per call in motes of native CSPR (>= 1000).
    pub price: U512,
    /// Account that receives the 402 payments (the x402 `payTo`).
    pub payment_target: Address,
    /// Service owner — the registration caller. May toggle `active` and
    /// record attestations.
    pub owner: Address,
    /// Key allowed to record attestations (the AgentGate middleware signer).
    pub attestor: Address,
    /// Discovery flag — inactive services reject attestations and are
    /// filtered out by buyers.
    pub active: bool,
    /// Block time (ms) at registration.
    pub created_at: u64,
}

/// One recorded payment outcome. The list per service is capped at the last
/// [`MAX_ATTESTATIONS`] entries; `(total, success)` counters keep full history.
#[odra::odra_type]
pub struct Attestation {
    /// Deploy hash of the CSPR payment transfer this attestation settles.
    pub payment_deploy_hash: String,
    /// Whether the upstream call was served successfully.
    pub success: bool,
    /// Block time (ms) when the attestation was recorded.
    pub timestamp: u64,
}

/// Emitted on `register_service`.
#[odra::event]
pub struct ServiceRegistered {
    /// Assigned service id (1-based, == `services_count` after the call).
    pub service_id: u64,
    /// The registration caller, stored as the service owner.
    pub owner: Address,
    /// Service name.
    pub name: String,
    /// Price per call in motes.
    pub price: U512,
    /// Payment target account.
    pub payment_target: Address,
    /// Authorised attestor key.
    pub attestor: Address,
}

/// Emitted on `record_attestation`.
#[odra::event]
pub struct AttestationRecorded {
    /// Service the attestation belongs to.
    pub service_id: u64,
    /// Deploy hash of the settled payment.
    pub payment_deploy_hash: String,
    /// Outcome of the paid call.
    pub success: bool,
    /// Total calls recorded for the service after this attestation.
    pub total_calls: u64,
    /// Successful calls recorded for the service after this attestation.
    pub success_calls: u64,
}

/// Emitted on `set_active`.
#[odra::event]
pub struct ServiceStatusChanged {
    /// Service whose flag changed.
    pub service_id: u64,
    /// New `active` value.
    pub active: bool,
}

/// Emitted on `set_attestor`.
#[odra::event]
pub struct ServiceAttestorChanged {
    /// Service whose attestor key changed.
    pub service_id: u64,
    /// The new authorised attestor.
    pub attestor: Address,
}

/// Registry errors (SPEC §10).
///
/// Note: SPEC names the legacy `odra::execution_error!` macro; in Odra 2.x the
/// equivalent (and only) mechanism is `#[odra::odra_error]` — same enum, same
/// variants, user-error codes 1..=6.
#[odra::odra_error]
pub enum Error {
    /// Caller is not allowed to perform this action.
    NotAuthorized = 1,
    /// Unknown `service_id`.
    ServiceNotFound = 2,
    /// Service exists but `active == false`.
    ServiceInactive = 3,
    /// `payment_deploy_hash` already attested for this service.
    DuplicateAttestation = 4,
    /// `price` below the 1000-motes minimum.
    InvalidPrice = 5,
    /// Service name is empty (or whitespace-only).
    EmptyName = 6,
}

/// AgentGate service registry + reputation ledger.
#[odra::module(
    events = [ServiceRegistered, AttestationRecorded, ServiceStatusChanged, ServiceAttestorChanged],
    errors = Error
)]
pub struct AgentGateRegistry {
    /// Number of registered services; equals the id of the most recently
    /// registered service (ids are 1-based, `1..=services_count`).
    services_count: Var<u64>,
    /// service_id -> service record.
    services: Mapping<u64, Service>,
    /// service_id -> (total_calls, success_calls).
    scores: Mapping<u64, (u64, u64)>,
    /// (service_id, payment_deploy_hash) -> attested? Duplicate guard.
    seen_payments: Mapping<(u64, String), bool>,
    /// service_id -> last `MAX_ATTESTATIONS` attestations (newest first).
    attestations: Mapping<u64, Vec<Attestation>>,
}

#[odra::module]
impl AgentGateRegistry {
    /// Register a new service. The caller becomes the owner. Returns the
    /// assigned 1-based service id.
    ///
    /// Reverts with [`Error::EmptyName`] if `name` is empty/whitespace-only,
    /// or [`Error::InvalidPrice`] if `price < 1000` motes.
    /// Emits [`ServiceRegistered`].
    pub fn register_service(
        &mut self,
        name: String,
        description: String,
        gateway_base_url: String,
        price: U512,
        payment_target: Address,
        attestor: Address,
    ) -> u64 {
        if name.trim().is_empty() {
            self.env().revert(Error::EmptyName);
        }
        if price < U512::from(MIN_PRICE_MOTES) {
            self.env().revert(Error::InvalidPrice);
        }

        // 1-based ids: bump the counter first, then assign it as the id. The
        // counter therefore always equals the latest id, and id 0 is reserved
        // for "absent" by every off-chain reader.
        let service_id = self.services_count.get_or_default() + 1;
        let owner = self.env().caller();
        let created_at = self.env().get_block_time();

        // Emit with clones so the originals can move into the stored record.
        self.env().emit_event(ServiceRegistered {
            service_id,
            owner,
            name: name.clone(),
            price,
            payment_target,
            attestor,
        });

        self.services.set(
            &service_id,
            Service {
                name,
                description,
                gateway_base_url,
                price,
                payment_target,
                owner,
                attestor,
                active: true,
                created_at,
            },
        );
        self.services_count.set(service_id);

        service_id
    }

    /// Record the outcome of one paid call, identified by the payment's
    /// deploy hash. Caller must be the service's attestor or owner.
    ///
    /// Reverts with [`Error::ServiceNotFound`] for unknown ids,
    /// [`Error::NotAuthorized`] for strangers, [`Error::ServiceInactive`] if
    /// the service is paused, and [`Error::DuplicateAttestation`] if this
    /// `payment_deploy_hash` was already attested for this service.
    /// Bumps the `(total, success)` score, appends to the capped attestation
    /// list and emits [`AttestationRecorded`].
    pub fn record_attestation(
        &mut self,
        service_id: u64,
        payment_deploy_hash: String,
        success: bool,
    ) {
        let service = self.load_service(service_id);

        let caller = self.env().caller();
        if caller != service.attestor && caller != service.owner {
            self.env().revert(Error::NotAuthorized);
        }
        if !service.active {
            self.env().revert(Error::ServiceInactive);
        }

        let payment_key = (service_id, payment_deploy_hash.clone());
        if self.seen_payments.get(&payment_key).unwrap_or(false) {
            self.env().revert(Error::DuplicateAttestation);
        }
        self.seen_payments.set(&payment_key, true);

        // Saturating so a (practically unreachable) u64 overflow pins at MAX
        // instead of panicking/wrapping and bricking the service's score.
        let (total, succeeded) = self.scores.get(&service_id).unwrap_or((0, 0));
        let total_calls = total.saturating_add(1);
        let success_calls = succeeded.saturating_add(u64::from(success));
        self.scores.set(&service_id, (total_calls, success_calls));

        // Newest-first: prepend, then drop the oldest beyond the cap (the tail).
        // Matches the SPEC, devnet and dashboard ordering.
        let mut list = self.attestations.get(&service_id).unwrap_or_default();
        list.insert(
            0,
            Attestation {
                payment_deploy_hash: payment_deploy_hash.clone(),
                success,
                timestamp: self.env().get_block_time(),
            },
        );
        list.truncate(MAX_ATTESTATIONS);
        self.attestations.set(&service_id, list);

        self.env().emit_event(AttestationRecorded {
            service_id,
            payment_deploy_hash,
            success,
            total_calls,
            success_calls,
        });
    }

    /// Toggle a service's `active` flag. Owner only.
    ///
    /// Reverts with [`Error::ServiceNotFound`] for unknown ids and
    /// [`Error::NotAuthorized`] for non-owners (the attestor may NOT toggle).
    /// Emits [`ServiceStatusChanged`].
    pub fn set_active(&mut self, service_id: u64, active: bool) {
        let mut service = self.load_service(service_id);

        if self.env().caller() != service.owner {
            self.env().revert(Error::NotAuthorized);
        }

        service.active = active;
        self.services.set(&service_id, service);

        self.env().emit_event(ServiceStatusChanged { service_id, active });
    }

    /// Rotate a service's authorised attestor key. Owner only. Lets an owner
    /// replace a compromised/rotated middleware signer without re-registering the
    /// service (which would mint a new id and reset its score) and without having
    /// to disable it via `set_active`.
    ///
    /// Reverts with [`Error::ServiceNotFound`] for unknown ids and
    /// [`Error::NotAuthorized`] for non-owners. Emits [`ServiceAttestorChanged`].
    pub fn set_attestor(&mut self, service_id: u64, attestor: Address) {
        let mut service = self.load_service(service_id);

        if self.env().caller() != service.owner {
            self.env().revert(Error::NotAuthorized);
        }

        service.attestor = attestor;
        self.services.set(&service_id, service);

        self.env().emit_event(ServiceAttestorChanged { service_id, attestor });
    }

    /// Fetch a service record. `None` if the id was never registered.
    pub fn get_service(&self, service_id: u64) -> Option<Service> {
        self.services.get(&service_id)
    }

    /// `(total_calls, success_calls)` for a service. `(0, 0)` if the service
    /// is unknown or has no attestations yet.
    pub fn get_score(&self, service_id: u64) -> (u64, u64) {
        self.scores.get(&service_id).unwrap_or((0, 0))
    }

    /// Number of registered services. Ids are `1..=services_count()`.
    pub fn services_count(&self) -> u64 {
        self.services_count.get_or_default()
    }

    /// The last (up to) 100 attestations for a service, newest first.
    /// Empty for unknown services.
    pub fn get_attestations(&self, service_id: u64) -> Vec<Attestation> {
        self.attestations.get(&service_id).unwrap_or_default()
    }
}

impl AgentGateRegistry {
    /// Internal: read a service or revert with [`Error::ServiceNotFound`].
    fn load_service(&self, service_id: u64) -> Service {
        self.services
            .get(&service_id)
            .unwrap_or_revert_with(&self.env(), Error::ServiceNotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    /// Test fixture: account indices.
    const OWNER: usize = 0; // default caller in OdraVM
    const ATTESTOR: usize = 1;
    const STRANGER: usize = 2;
    const PAYMENT_TARGET: usize = 3;

    fn setup() -> (HostEnv, AgentGateRegistryHostRef) {
        let env = odra_test::env();
        let registry = AgentGateRegistry::deploy(&env, NoArgs);
        (env, registry)
    }

    /// Register a default service (caller = current env caller) and return its id.
    fn register(env: &HostEnv, registry: &mut AgentGateRegistryHostRef) -> u64 {
        registry.register_service(
            "USD/IDR + Gold Oracle".to_string(),
            "RWA feed: USD/IDR rate and gold spot with confidence".to_string(),
            "http://localhost:4021".to_string(),
            U512::from(500_000_000u64), // 0.5 CSPR
            env.get_account(PAYMENT_TARGET),
            env.get_account(ATTESTOR),
        )
    }

    // ───────────────────────── registration ─────────────────────────

    #[test]
    fn register_and_get_happy_path() {
        let (env, mut registry) = setup();
        env.advance_block_time(5_000);

        let id = register(&env, &mut registry);
        assert_eq!(id, 1); // ids are 1-based

        let service = registry.get_service(id).expect("service must exist");
        assert_eq!(service.name, "USD/IDR + Gold Oracle");
        assert_eq!(
            service.description,
            "RWA feed: USD/IDR rate and gold spot with confidence"
        );
        // Base URL stored verbatim — readers compute `{base}/svc/{id}`.
        assert_eq!(service.gateway_base_url, "http://localhost:4021");
        assert_eq!(service.price, U512::from(500_000_000u64));
        assert_eq!(service.payment_target, env.get_account(PAYMENT_TARGET));
        assert_eq!(service.owner, env.get_account(OWNER)); // caller becomes owner
        assert_eq!(service.attestor, env.get_account(ATTESTOR));
        assert!(service.active); // active on registration
        assert_eq!(service.created_at, 5_000); // block time at registration

        assert!(env.emitted_event(
            &registry,
            ServiceRegistered {
                service_id: 1,
                owner: env.get_account(OWNER),
                name: "USD/IDR + Gold Oracle".to_string(),
                price: U512::from(500_000_000u64),
                payment_target: env.get_account(PAYMENT_TARGET),
                attestor: env.get_account(ATTESTOR),
            }
        ));
    }

    #[test]
    fn services_count_increments_with_sequential_ids() {
        let (env, mut registry) = setup();
        assert_eq!(registry.services_count(), 0);

        assert_eq!(register(&env, &mut registry), 1);
        assert_eq!(register(&env, &mut registry), 2);
        assert_eq!(register(&env, &mut registry), 3);

        assert_eq!(registry.services_count(), 3);
    }

    #[test]
    fn empty_or_whitespace_name_reverts() {
        let (env, mut registry) = setup();

        for bad_name in ["", "   "] {
            assert_eq!(
                registry
                    .try_register_service(
                        bad_name.to_string(),
                        "desc".to_string(),
                        "http://localhost:4021".to_string(),
                        U512::from(MIN_PRICE_MOTES),
                        env.get_account(PAYMENT_TARGET),
                        env.get_account(ATTESTOR),
                    )
                    .unwrap_err(),
                Error::EmptyName.into(),
                "name {bad_name:?} must revert"
            );
        }
        assert_eq!(registry.services_count(), 0);
    }

    #[test]
    fn price_below_minimum_reverts_and_minimum_is_accepted() {
        let (env, mut registry) = setup();

        // 999 motes — below the 1000-motes floor.
        assert_eq!(
            registry
                .try_register_service(
                    "Cheap".to_string(),
                    "desc".to_string(),
                    "http://localhost:4021".to_string(),
                    U512::from(MIN_PRICE_MOTES - 1),
                    env.get_account(PAYMENT_TARGET),
                    env.get_account(ATTESTOR),
                )
                .unwrap_err(),
            Error::InvalidPrice.into()
        );

        // Exactly 1000 motes is valid (boundary).
        let id = registry.register_service(
            "Min price".to_string(),
            "desc".to_string(),
            "http://localhost:4021".to_string(),
            U512::from(MIN_PRICE_MOTES),
            env.get_account(PAYMENT_TARGET),
            env.get_account(ATTESTOR),
        );
        assert_eq!(registry.get_service(id).unwrap().price, U512::from(1000u64));
    }

    // ───────────────────────── read defaults ─────────────────────────

    #[test]
    fn unknown_service_reads_return_defaults() {
        let (_env, registry) = setup();

        assert!(registry.get_service(99).is_none());
        assert_eq!(registry.get_score(99), (0, 0));
        assert!(registry.get_attestations(99).is_empty());
    }

    // ───────────────────────── attestations: auth ─────────────────────────

    #[test]
    fn owner_can_record_attestation() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);
        env.advance_block_time(1_000);

        // Caller is still the owner (account 0).
        registry.record_attestation(id, "deploy-hash-1".to_string(), true);

        assert_eq!(registry.get_score(id), (1, 1));
        let list = registry.get_attestations(id);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].payment_deploy_hash, "deploy-hash-1");
        assert!(list[0].success);
        assert_eq!(list[0].timestamp, 1_000);

        assert!(env.emitted_event(
            &registry,
            AttestationRecorded {
                service_id: id,
                payment_deploy_hash: "deploy-hash-1".to_string(),
                success: true,
                total_calls: 1,
                success_calls: 1,
            }
        ));
    }

    #[test]
    fn attestor_can_record_attestation() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        env.set_caller(env.get_account(ATTESTOR));
        registry.record_attestation(id, "deploy-hash-1".to_string(), false);

        assert_eq!(registry.get_score(id), (1, 0));
    }

    #[test]
    fn stranger_cannot_record_attestation() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        env.set_caller(env.get_account(STRANGER));
        assert_eq!(
            registry
                .try_record_attestation(id, "deploy-hash-1".to_string(), true)
                .unwrap_err(),
            Error::NotAuthorized.into()
        );
        assert_eq!(registry.get_score(id), (0, 0)); // nothing recorded
        assert!(registry.get_attestations(id).is_empty());
    }

    #[test]
    fn attesting_unknown_service_reverts() {
        let (_env, mut registry) = setup();
        assert_eq!(
            registry
                .try_record_attestation(42, "deploy-hash-1".to_string(), true)
                .unwrap_err(),
            Error::ServiceNotFound.into()
        );
    }

    // ──────────────────── attestations: duplicate guard ────────────────────

    #[test]
    fn duplicate_payment_deploy_hash_reverts() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        registry.record_attestation(id, "deploy-hash-1".to_string(), true);

        // Same hash again — even with a different outcome — must revert.
        assert_eq!(
            registry
                .try_record_attestation(id, "deploy-hash-1".to_string(), false)
                .unwrap_err(),
            Error::DuplicateAttestation.into()
        );
        assert_eq!(registry.get_score(id), (1, 1)); // unchanged
        assert_eq!(registry.get_attestations(id).len(), 1);
    }

    #[test]
    fn same_payment_hash_is_allowed_on_different_services() {
        let (env, mut registry) = setup();
        let id_a = register(&env, &mut registry);
        let id_b = register(&env, &mut registry);

        // The duplicate guard is scoped per service.
        registry.record_attestation(id_a, "deploy-hash-1".to_string(), true);
        registry.record_attestation(id_b, "deploy-hash-1".to_string(), true);

        assert_eq!(registry.get_score(id_a), (1, 1));
        assert_eq!(registry.get_score(id_b), (1, 1));
    }

    // ─────────────────── attestations: active flag ───────────────────

    #[test]
    fn inactive_service_rejects_attestations_until_reactivated() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        registry.set_active(id, false);
        assert_eq!(
            registry
                .try_record_attestation(id, "deploy-hash-1".to_string(), true)
                .unwrap_err(),
            Error::ServiceInactive.into()
        );

        registry.set_active(id, true);
        registry.record_attestation(id, "deploy-hash-1".to_string(), true);
        assert_eq!(registry.get_score(id), (1, 1));
    }

    // ───────────────────────── score math ─────────────────────────

    #[test]
    fn score_counts_totals_and_successes() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        for (i, success) in [true, false, true, true, false].iter().enumerate() {
            registry.record_attestation(id, format!("deploy-hash-{i}"), *success);
        }

        assert_eq!(registry.get_score(id), (5, 3));
        assert_eq!(registry.get_attestations(id).len(), 5);
    }

    // ───────────────────────── cap behaviour ─────────────────────────

    #[test]
    fn attestation_list_caps_at_last_100_dropping_oldest() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        for i in 0..105u64 {
            registry.record_attestation(id, format!("deploy-hash-{i}"), i % 2 == 0);
        }

        let list = registry.get_attestations(id);
        assert_eq!(list.len(), MAX_ATTESTATIONS); // capped at 100
        // Oldest five (0..=4) dropped; list is newest-first.
        assert_eq!(list[0].payment_deploy_hash, "deploy-hash-104"); // newest
        assert_eq!(list[99].payment_deploy_hash, "deploy-hash-5"); // oldest kept
        // Score counters keep the FULL history (105 calls, 53 even-indexed successes).
        assert_eq!(registry.get_score(id), (105, 53));
    }

    // ───────────────────────── set_active auth ─────────────────────────

    #[test]
    fn owner_can_toggle_active_and_event_is_emitted() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        registry.set_active(id, false);
        assert!(!registry.get_service(id).unwrap().active);
        assert!(env.emitted_event(
            &registry,
            ServiceStatusChanged {
                service_id: id,
                active: false,
            }
        ));

        registry.set_active(id, true);
        assert!(registry.get_service(id).unwrap().active);
    }

    #[test]
    fn non_owner_cannot_toggle_active() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);

        // The attestor is NOT allowed to toggle — owner only.
        for account in [ATTESTOR, STRANGER] {
            env.set_caller(env.get_account(account));
            assert_eq!(
                registry.try_set_active(id, false).unwrap_err(),
                Error::NotAuthorized.into()
            );
        }
        assert!(registry.get_service(id).unwrap().active); // unchanged
    }

    #[test]
    fn toggling_unknown_service_reverts() {
        let (_env, mut registry) = setup();
        assert_eq!(
            registry.try_set_active(7, false).unwrap_err(),
            Error::ServiceNotFound.into()
        );
    }

    // ───────────────────────── set_attestor auth ─────────────────────────

    #[test]
    fn owner_can_rotate_attestor_and_event_is_emitted() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);
        let new_attestor = env.get_account(STRANGER);

        registry.set_attestor(id, new_attestor);
        assert_eq!(registry.get_service(id).unwrap().attestor, new_attestor);
        assert!(env.emitted_event(
            &registry,
            ServiceAttestorChanged { service_id: id, attestor: new_attestor }
        ));

        // The rotated-in key can now attest; the old attestor can no longer.
        env.set_caller(new_attestor);
        registry.record_attestation(id, "pay-rotated".to_string(), true);
        env.set_caller(env.get_account(ATTESTOR));
        assert_eq!(
            registry.try_record_attestation(id, "pay-old".to_string(), true).unwrap_err(),
            Error::NotAuthorized.into()
        );
    }

    #[test]
    fn non_owner_cannot_rotate_attestor() {
        let (env, mut registry) = setup();
        let id = register(&env, &mut registry);
        for account in [ATTESTOR, STRANGER] {
            env.set_caller(env.get_account(account));
            assert_eq!(
                registry.try_set_attestor(id, env.get_account(STRANGER)).unwrap_err(),
                Error::NotAuthorized.into()
            );
        }
        assert_eq!(registry.get_service(id).unwrap().attestor, env.get_account(ATTESTOR));
    }

    #[test]
    fn rotating_attestor_on_unknown_service_reverts() {
        let (env, mut registry) = setup();
        assert_eq!(
            registry.try_set_attestor(7, env.get_account(ATTESTOR)).unwrap_err(),
            Error::ServiceNotFound.into()
        );
    }
}
