//! Sandbox tests for `neargate-registry` (near-workspaces + near-sandbox).
//!
//! Build the wasm first, then run:
//!   cd contracts/registry && cargo near build non-reproducible-wasm
//!   cd .. && cargo test -p integration-tests -- --nocapture
//!
//! `NEARGATE_REGISTRY_WASM` overrides the wasm path. `NEAR_SANDBOX_BIN_PATH` points at an
//! already-downloaded `near-sandbox` binary (otherwise near-workspaces downloads one).

use anyhow::{Result, anyhow, ensure};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, Contract};
use serde_json::{Value, json};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const PRICE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
const FEE: u128 = 2_000_000_000_000_000_000_000; // 0.002 NEAR
const ESCROW_FEE: u128 = 2_000_000_000_000_000_000_000; // 0.002 NEAR, kept by the first deposit
const REGISTRATION_DEPOSIT: u128 = 120_000_000_000_000_000_000_000; // 0.12 NEAR
const BYTE_COST: u128 = 10_000_000_000_000_000_000; // 10^19 yocto per byte
/// Storage a service can later fill through `record_attestation`: the score record
/// (40 + 9 + 16) plus a full list of 100 maximal attestations (40 + 9 + 4 + 100 * 101).
const ATTESTATION_RESERVE_BYTES: u128 = 65 + 10_153;
const CALL_GAS: Gas = Gas::from_tgas(30);

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

fn wasm() -> Result<Vec<u8>> {
    let path = std::env::var("NEARGATE_REGISTRY_WASM").unwrap_or_else(|_| {
        format!(
            "{}/../target/near/neargate_registry/neargate_registry.wasm",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    std::fs::read(&path).map_err(|_| {
        anyhow!(
            "registry wasm not found at {path}. Build it first with \
             `cd contracts/registry && cargo near build non-reproducible-wasm` \
             (or point NEARGATE_REGISTRY_WASM at a built file)"
        )
    })
}

struct Env {
    registry: Contract,
    owner: Account,
    seller: Account,
    attestor: Account,
    buyer: Account,
}

async fn setup() -> Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker.dev_deploy(&wasm()?).await?;
    let init = registry.call("new").max_gas().transact().await?;
    println!(
        "[setup] new() burnt {} Tgas",
        init.total_gas_burnt.as_tgas()
    );
    ensure!(
        init.is_success(),
        "new() failed: {:?}",
        init.into_result().err()
    );

    let root = worker.root_account()?;
    let mut accounts = Vec::new();
    for name in ["owner", "seller", "attestor", "buyer"] {
        accounts.push(
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(20))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let mut it = accounts.into_iter();
    Ok(Env {
        registry,
        owner: it.next().unwrap(),
        seller: it.next().unwrap(),
        attestor: it.next().unwrap(),
        buyer: it.next().unwrap(),
    })
}

fn register_args(env: &Env) -> Value {
    json!({
        "name": "Weather API",
        "description": "Hourly forecasts",
        "gateway_base_url": "https://gateway.example.com",
        "accepts": [{"asset": "near", "amount": PRICE.to_string(), "decimals": 24, "symbol": "NEAR"}],
        "payment_target": env.seller.id(),
        "attestor": env.attestor.id(),
    })
}

async fn register(env: &Env) -> Result<u64> {
    let res = env
        .owner
        .call(env.registry.id(), "register_service")
        .args_json(register_args(env))
        .deposit(yocto(REGISTRATION_DEPOSIT))
        .gas(CALL_GAS)
        .transact()
        .await?;
    ensure!(
        res.is_success(),
        "register_service failed: {:?}",
        res.into_result().err()
    );
    Ok(res.json::<u64>()?)
}

async fn pay(
    env: &Env,
    payer: &Account,
    service_id: u64,
    nonce: &str,
    attached: u128,
) -> Result<ExecutionFinalResult> {
    Ok(payer
        .call(env.registry.id(), "pay")
        .args_json(json!({"service_id": service_id, "nonce": nonce}))
        .deposit(yocto(attached))
        .gas(CALL_GAS)
        .transact()
        .await?)
}

async fn view(env: &Env, method: &str, args: Value) -> Result<Value> {
    Ok(env.registry.view(method).args_json(args).await?.json()?)
}

async fn balance(account: &Account) -> Result<u128> {
    Ok(account.view_account().await?.balance.as_yoctonear())
}

async fn storage_usage(env: &Env) -> Result<u64> {
    Ok(env.registry.view_account().await?.storage_usage)
}

async fn escrow_of(env: &Env, account: &Account) -> Result<u128> {
    let balance = view(env, "escrow_of", json!({"account_id": account.id()})).await?;
    let balance = balance
        .as_str()
        .ok_or_else(|| anyhow!("escrow_of returned {balance}, not a string"))?;
    Ok(balance.parse()?)
}

async fn deposit_escrow(env: &Env, account: &Account, attached: u128) -> Result<()> {
    let res = account
        .call(env.registry.id(), "deposit_escrow")
        .deposit(yocto(attached))
        .gas(CALL_GAS)
        .transact()
        .await?;
    ensure!(
        res.is_success(),
        "deposit_escrow failed: {:?}",
        res.into_result().err()
    );
    Ok(())
}

/// The error of a transaction NEAR refused to execute (an invalid transaction never reaches the
/// contract, so near-workspaces returns an `Err` instead of a failed outcome).
fn refused(sent: near_workspaces::Result<ExecutionFinalResult>) -> Result<String> {
    match sent {
        Ok(res) => Err(anyhow!(
            "NEAR accepted the transaction: {:?}",
            res.into_result()
        )),
        Err(err) => Ok(format!("{err:?}")),
    }
}

#[tokio::test]
async fn pay_refunds_excess_and_forwards_exact_price() -> Result<()> {
    let env = setup().await?;
    let id = register(&env).await?;

    let seller_before = balance(&env.seller).await?;
    let buyer_before = balance(&env.buyer).await?;
    let registry_before = env.registry.view_account().await?.balance.as_yoctonear();
    let res = pay(
        &env,
        &env.buyer,
        id,
        "1001",
        1_000_000_000_000_000_000_000_000,
    )
    .await?; // 1 NEAR
    ensure!(
        res.is_success(),
        "pay failed: {:?}",
        res.into_result().err()
    );
    let seller_after = balance(&env.seller).await?;
    let buyer_after = balance(&env.buyer).await?;

    // The seller receives exactly the price; the registry keeps exactly the fee.
    assert_eq!(seller_after - seller_before, PRICE);
    let registry_after = env.registry.view_account().await?.balance.as_yoctonear();
    assert_eq!(registry_after - registry_before, FEE);

    // The buyer is out price + fee + gas; the other ~0.99 NEAR came back.
    let spent = buyer_before - buyer_after;
    let gas_cap = NearToken::from_millinear(10).as_yoctonear();
    println!(
        "[pay] buyer spent {spent} yocto (price {PRICE} + fee {FEE} + gas {})",
        spent - PRICE - FEE
    );
    assert!(
        spent >= PRICE + FEE,
        "buyer spent {spent}, less than price + fee"
    );
    assert!(
        spent <= PRICE + FEE + gas_cap,
        "buyer spent {spent}, more than price + fee + 0.01 NEAR"
    );
    Ok(())
}

#[tokio::test]
async fn pay_storage_cost_is_covered_by_fee() -> Result<()> {
    let env = setup().await?;
    let id = register(&env).await?;

    let before = storage_usage(&env).await?;
    let res = pay(&env, &env.buyer, id, "123456789012345", PRICE + FEE).await?;
    ensure!(
        res.is_success(),
        "pay failed: {:?}",
        res.into_result().err()
    );
    let after = storage_usage(&env).await?;

    let grown = after - before;
    let cost = u128::from(grown) * BYTE_COST;
    println!("[pay] storage grew by {grown} bytes = {cost} yocto (fee {FEE})");
    assert!(cost <= FEE, "pay storage cost {cost} exceeds the {FEE} fee");

    // The next pay writes the next ring slot: same bound.
    let before = storage_usage(&env).await?;
    let res = pay(&env, &env.buyer, id, "123456789012346", PRICE + FEE).await?;
    ensure!(
        res.is_success(),
        "pay failed: {:?}",
        res.into_result().err()
    );
    let grown = storage_usage(&env).await? - before;
    println!("[pay] second pay grew storage by {grown} bytes");
    assert!(u128::from(grown) * BYTE_COST <= FEE);
    Ok(())
}

#[tokio::test]
async fn full_flow_register_pay_attest() -> Result<()> {
    let env = setup().await?;

    // register: the registry keeps 0.1 NEAR and the storage must fit inside it
    let usage_before = storage_usage(&env).await?;
    let balance_before = env.registry.view_account().await?.balance.as_yoctonear();
    let id = register(&env).await?;
    assert_eq!(id, 1);
    let grown = storage_usage(&env).await? - usage_before;
    let cost = u128::from(grown) * BYTE_COST;
    println!(
        "[register] storage grew by {grown} bytes = {cost} yocto; with the attestation reserve {} of {REGISTRATION_DEPOSIT}",
        cost + ATTESTATION_RESERVE_BYTES * BYTE_COST
    );
    assert!(cost + ATTESTATION_RESERVE_BYTES * BYTE_COST <= REGISTRATION_DEPOSIT);
    let kept = env.registry.view_account().await?.balance.as_yoctonear() - balance_before;
    assert_eq!(kept, REGISTRATION_DEPOSIT);

    let service = view(&env, "get_service", json!({"service_id": id})).await?;
    assert_eq!(service["name"], "Weather API");
    assert_eq!(service["owner"], env.owner.id().as_str());
    assert_eq!(service["accepts"][0]["amount"], PRICE.to_string());
    assert_eq!(service["active"], true);
    assert_eq!(view(&env, "services_count", json!({})).await?, 1);

    // pay
    let nonce = "424242";
    let paid = pay(&env, &env.buyer, id, nonce, PRICE + FEE).await?;
    ensure!(
        paid.is_success(),
        "pay failed: {:?}",
        paid.clone().into_result().err()
    );
    let tx_hash = paid.outcome().transaction_hash.to_string();
    let payment = view(&env, "get_payment", json!({"nonce": nonce})).await?;
    assert_eq!(payment["payer"], env.buyer.id().as_str());
    assert_eq!(payment["amount"], PRICE.to_string());
    assert_eq!(payment["self_paid"], false);
    assert_eq!(payment["attested"], false);

    // the same nonce cannot be paid twice
    let again = pay(&env, &env.buyer, id, nonce, PRICE + FEE).await?;
    assert!(again.is_failure());
    assert!(format!("{:?}", again.into_result().unwrap_err()).contains("ERR_NONCE_USED"));

    // attest
    let attested = env
        .attestor
        .call(env.registry.id(), "record_attestation")
        .args_json(json!({
            "service_id": id,
            "nonce": nonce,
            "payment_tx_hash": tx_hash,
            "success": true,
        }))
        .gas(CALL_GAS)
        .transact()
        .await?;
    ensure!(
        attested.is_success(),
        "attestation failed: {:?}",
        attested.into_result().err()
    );

    let score = view(&env, "get_score", json!({"service_id": id})).await?;
    assert_eq!(score, json!({"total_calls": 1, "success_calls": 1}));
    let payment = view(&env, "get_payment", json!({"nonce": nonce})).await?;
    assert_eq!(payment["attested"], true);
    let list = view(&env, "get_attestations", json!({"service_id": id})).await?;
    assert_eq!(list[0]["nonce"], nonce);
    assert_eq!(list[0]["payment_tx_hash"], tx_hash.as_str());
    assert_eq!(list[0]["success"], true);

    // the payment cannot be attested a second time
    let twice = env
        .attestor
        .call(env.registry.id(), "record_attestation")
        .args_json(
            json!({"service_id": id, "nonce": nonce, "payment_tx_hash": "x", "success": true}),
        )
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert!(format!("{:?}", twice.into_result().unwrap_err()).contains("ERR_ALREADY_ATTESTED"));

    // activity: attestation, payment, registration, newest first
    let activity = view(&env, "get_recent_activity", json!({"limit": 10})).await?;
    let kinds: Vec<&str> = activity
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["attestation", "payment", "service_registered"]);
    assert_eq!(activity[1]["account"], env.buyer.id().as_str());
    assert_eq!(activity[1]["amount"], PRICE.to_string());
    Ok(())
}

#[tokio::test]
async fn self_paid_payment_cannot_be_attested_onchain() -> Result<()> {
    let env = setup().await?;
    let id = register(&env).await?;

    // the owner pays their own service
    let paid = pay(&env, &env.owner, id, "777", PRICE + FEE).await?;
    ensure!(
        paid.is_success(),
        "pay failed: {:?}",
        paid.into_result().err()
    );
    let payment = view(&env, "get_payment", json!({"nonce": "777"})).await?;
    assert_eq!(payment["self_paid"], true);

    let res = env
        .attestor
        .call(env.registry.id(), "record_attestation")
        .args_json(
            json!({"service_id": id, "nonce": "777", "payment_tx_hash": "x", "success": true}),
        )
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert!(res.is_failure());
    let err = format!("{:?}", res.into_result().unwrap_err());
    assert!(err.contains("ERR_SELF_PAYMENT"), "unexpected error: {err}");

    let score = view(&env, "get_score", json!({"service_id": id})).await?;
    assert_eq!(score, json!({"total_calls": 0, "success_calls": 0}));
    Ok(())
}

/// The buyer funds an escrow and gives its agent a function-call key that may only call
/// `pay_from_escrow` on the registry. That key pays. It cannot withdraw: NEAR refuses the
/// transaction before it reaches the registry. The buyer's full-access key can.
#[tokio::test]
async fn agent_function_call_key_pays_from_escrow_only() -> Result<()> {
    let env = setup().await?;
    let id = register(&env).await?;

    // The buyer deposits 1 NEAR; the first deposit keeps the 0.002 NEAR storage fee.
    let usage_before = storage_usage(&env).await?;
    deposit_escrow(&env, &env.buyer, NEAR).await?;
    let grown = storage_usage(&env).await? - usage_before;
    let cost = u128::from(grown) * BYTE_COST;
    println!("[deposit_escrow] storage grew by {grown} bytes = {cost} yocto (fee {ESCROW_FEE})");
    assert!(cost <= ESCROW_FEE, "escrow entry {cost} exceeds its fee");
    assert_eq!(escrow_of(&env, &env.buyer).await?, NEAR - ESCROW_FEE);

    // The buyer adds the agent's key: function calls to the registry's pay_from_escrow only.
    let agent_key = SecretKey::from_random(KeyType::ED25519);
    let res = env
        .buyer
        .batch(env.buyer.id())
        .add_key(
            agent_key.public_key(),
            AccessKey::function_call_access(
                env.registry.id(),
                &["pay_from_escrow"],
                Some(NearToken::from_millinear(250)),
            ),
        )
        .transact()
        .await?;
    ensure!(
        res.is_success(),
        "add_key failed: {:?}",
        res.into_result().err()
    );
    let mut agent = env.buyer.clone();
    agent.set_secret_key(agent_key);

    // With that key, pay_from_escrow (no deposit) pays the seller from the buyer's escrow.
    let seller_before = balance(&env.seller).await?;
    let res = agent
        .call(env.registry.id(), "pay_from_escrow")
        .args_json(json!({"service_id": id, "nonce": "5001"}))
        .gas(CALL_GAS)
        .transact()
        .await?;
    ensure!(
        res.is_success(),
        "pay_from_escrow failed: {:?}",
        res.into_result().err()
    );
    assert_eq!(balance(&env.seller).await? - seller_before, PRICE);
    let payment = view(&env, "get_payment", json!({"nonce": "5001"})).await?;
    assert_eq!(payment["payer"], env.buyer.id().as_str());
    assert_eq!(payment["amount"], PRICE.to_string());
    let escrow = escrow_of(&env, &env.buyer).await?;
    assert_eq!(escrow, NEAR - ESCROW_FEE - PRICE - FEE);

    // With that key, withdraw_escrow is refused. The 1 yocto it needs is a deposit, which a
    // function-call key may not attach...
    let err = refused(
        agent
            .call(env.registry.id(), "withdraw_escrow")
            .args_json(json!({"amount": escrow.to_string()}))
            .deposit(yocto(1))
            .gas(CALL_GAS)
            .transact()
            .await,
    )?;
    println!("[agent withdraw, 1 yocto] refused: {err}");
    assert!(
        err.contains("DepositWithFunctionCall"),
        "unexpected error: {err}"
    );
    // ...and without it, the method is not one the key may call.
    let err = refused(
        agent
            .call(env.registry.id(), "withdraw_escrow")
            .args_json(json!({"amount": escrow.to_string()}))
            .gas(CALL_GAS)
            .transact()
            .await,
    )?;
    println!("[agent withdraw, no deposit] refused: {err}");
    assert!(
        err.contains("MethodNameMismatch"),
        "unexpected error: {err}"
    );
    assert_eq!(escrow_of(&env, &env.buyer).await?, escrow);

    // With the full-access key, withdraw_escrow succeeds: the balance rises by the amount minus gas.
    let amount = NEAR / 2;
    let before = balance(&env.buyer).await?;
    let res = env
        .buyer
        .call(env.registry.id(), "withdraw_escrow")
        .args_json(json!({"amount": amount.to_string()}))
        .deposit(yocto(1))
        .gas(CALL_GAS)
        .transact()
        .await?;
    ensure!(
        res.is_success(),
        "withdraw_escrow failed: {:?}",
        res.clone().into_result().err()
    );
    ensure!(
        res.receipt_failures().is_empty(),
        "a withdraw receipt failed: {:?}",
        res.receipt_failures()
    );
    for outcome in res.receipt_outcomes() {
        println!(
            "[withdraw_escrow] receipt on {} burnt {} Ggas",
            outcome.executor_id,
            outcome.gas_burnt.as_ggas()
        );
    }
    // The callback's unused gas is refunded a block after it runs, which `transact()` does not
    // wait for (until then the balance is short by that prepaid gas), so poll for it.
    let gas_cap = NearToken::from_millinear(10).as_yoctonear();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let rise = loop {
        let rise = i128::try_from(balance(&env.buyer).await?)? - i128::try_from(before)?;
        if rise > i128::try_from(amount - gas_cap)? || std::time::Instant::now() > deadline {
            break rise;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };
    let burnt: u128 = res
        .outcomes()
        .iter()
        .map(|o| o.tokens_burnt.as_yoctonear())
        .sum();
    println!("[withdraw_escrow] balance rose by {rise} yocto: amount {amount} - burnt {burnt} - 1");
    assert!(
        rise < i128::try_from(amount)? && rise > i128::try_from(amount - gas_cap)?,
        "balance rose by {rise}, expected {amount} minus at most 0.01 NEAR of gas"
    );
    assert_eq!(escrow_of(&env, &env.buyer).await?, escrow - amount);
    Ok(())
}

/// The re-credit callback would mint escrow if anyone could call it: only the registry may.
#[tokio::test]
async fn escrow_recredit_callback_is_private() -> Result<()> {
    let env = setup().await?;
    deposit_escrow(&env, &env.buyer, NEAR / 10).await?;
    let before = escrow_of(&env, &env.buyer).await?;

    let res = env
        .buyer
        .call(env.registry.id(), "on_escrow_withdraw")
        .args_json(json!({"account_id": env.buyer.id(), "amount": NEAR.to_string()}))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert!(res.is_failure());
    let err = format!("{:?}", res.into_result().unwrap_err());
    assert!(
        err.contains("Method on_escrow_withdraw is private"),
        "unexpected error: {err}"
    );
    assert_eq!(escrow_of(&env, &env.buyer).await?, before);
    Ok(())
}
