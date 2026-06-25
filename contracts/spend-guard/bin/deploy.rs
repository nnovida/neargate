//! Livenet (testnet/mainnet) deploy CLI for `SpendGuard`.
//!
//! Build & run (requires the `livenet` feature and the `ODRA_CASPER_LIVENET_*`
//! environment variables — node address, secret-key path, chain name):
//!
//! ```bash
//! cargo run --bin spend_guard_deploy --features livenet --release -- deploy
//! ```

use odra::host::{HostEnv, NoArgs};
use odra_cli::{
    deploy::{DeployScript, Error},
    DeployedContractsContainer, DeployerExt, OdraCli,
};
use spend_guard::SpendGuard;

/// Deploys the `SpendGuard` (no constructor args) and records it in the
/// `resources/deployed_contracts.toml` container so subsequent CLI calls can
/// load it instead of re-deploying.
pub struct SpendGuardDeployScript;

impl DeployScript for SpendGuardDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), Error> {
        // ~300 CSPR install budget is the Odra-recommended starting point;
        // unspent gas is refunded under Casper 2.0 pricing.
        let _guard = SpendGuard::load_or_deploy(env, NoArgs, container, 300_000_000_000u64)?;
        Ok(())
    }
}

/// Main function to run the CLI tool.
pub fn main() {
    OdraCli::new()
        .about("Deploy & interact with the SpendGuard contract")
        .deploy(SpendGuardDeployScript)
        .contract::<SpendGuard>()
        .build()
        .run();
}
