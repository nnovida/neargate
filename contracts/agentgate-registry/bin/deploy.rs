//! Livenet (testnet/mainnet) deploy CLI for `AgentGateRegistry`.
//!
//! **Documented, NOT executed in CI** — deployment is out of scope for the
//! qualification build (SPEC §10 / §13). See `contracts/README.md` for the
//! full runbook (env vars, key setup, gas notes, how to find the contract
//! package hash afterwards).
//!
//! Build & run (requires the `livenet` feature and the `ODRA_CASPER_LIVENET_*`
//! environment variables):
//!
//! ```bash
//! cargo run --bin agentgate_registry_deploy --features livenet --release -- deploy
//! ```

use agentgate_registry::AgentGateRegistry;
use odra::host::{HostEnv, NoArgs};
use odra_cli::{
    deploy::{DeployScript, Error},
    DeployedContractsContainer, DeployerExt, OdraCli,
};

/// Deploys the `AgentGateRegistry` (no constructor args) and records it in the
/// `resources/deployed_contracts.toml` container so subsequent CLI calls can
/// load it instead of re-deploying.
pub struct RegistryDeployScript;

impl DeployScript for RegistryDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), Error> {
        // ⚠️ verify against deployed contract: ~300 CSPR install budget is the
        // Odra-recommended starting point; check the actual cost on testnet
        // and tune down (unspent gas is refunded under Casper 2.0 pricing).
        let _registry =
            AgentGateRegistry::load_or_deploy(env, NoArgs, container, 300_000_000_000u64)?;
        Ok(())
    }
}

/// Main function to run the CLI tool.
pub fn main() {
    OdraCli::new()
        .about("Deploy & interact with the AgentGateRegistry contract")
        .deploy(RegistryDeployScript)
        .contract::<AgentGateRegistry>()
        .build()
        .run();
}
