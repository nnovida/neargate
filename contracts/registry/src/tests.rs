//! Unit tests (near-sdk `testing_env!` / `VMContextBuilder`). The sandbox flow lives in
//! `contracts/integration-tests`.

use std::panic::{AssertUnwindSafe, catch_unwind};

use near_sdk::json_types::U128;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, NearToken, testing_env};

use crate::*;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const PRICE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// Sets the call context. Storage is carried over between `testing_env!` calls.
fn ctx(predecessor: &str, deposit: u128) {
    ctx_at(predecessor, deposit, 1_700_000_000_000, 100);
}

fn ctx_at(predecessor: &str, deposit: u128, timestamp_ms: u64, height: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acct("registry.near"))
            .predecessor_account_id(acct(predecessor))
            .signer_account_id(acct(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(timestamp_ms * 1_000_000)
            .block_height(height)
            .build()
    );
}

/// A fresh contract, deployed and initialised by `registry.near`.
fn setup() -> Registry {
    ctx("registry.near", 0);
    Registry::new()
}

fn native(amount: u128) -> PaymentOption {
    PaymentOption {
        asset: "near".to_string(),
        amount: U128(amount),
        decimals: 24,
        symbol: "NEAR".to_string(),
    }
}

fn token(amount: u128) -> PaymentOption {
    PaymentOption {
        asset: "usdc.testnet".to_string(),
        amount: U128(amount),
        decimals: 6,
        symbol: "USDC".to_string(),
    }
}

/// Registers a service owned by `owner.near`, paid to `seller.near`, attested by
/// `attestor.near`. Leaves the context on `owner.near`.
fn register_with(c: &mut Registry, accepts: Vec<PaymentOption>) -> u64 {
    ctx("owner.near", REGISTRATION_DEPOSIT_YOCTO);
    c.register_service(
        "Weather API".to_string(),
        "Hourly forecasts".to_string(),
        "https://gw.example/svc/1".to_string(),
        accepts,
        acct("seller.near"),
        acct("attestor.near"),
    )
}

fn register(c: &mut Registry) -> u64 {
    register_with(c, vec![native(PRICE)])
}

fn pay_as(c: &mut Registry, payer: &str, service_id: u64, nonce: &str) {
    ctx(payer, PRICE + PAYMENT_STORAGE_FEE_YOCTO);
    c.pay(service_id, nonce.to_string());
}

fn attest_as(
    c: &mut Registry,
    caller: &str,
    service_id: u64,
    nonce: &str,
    tx_hash: &str,
    success: bool,
) {
    ctx(caller, 0);
    c.record_attestation(service_id, nonce.to_string(), tx_hash.to_string(), success);
}

/// Runs `f`, which must panic, and asserts the panic message STARTS with `code` (the TS side
/// maps errors by that prefix).
fn expect_err<R>(code: &str, f: impl FnOnce() -> R) {
    let result = catch_unwind(AssertUnwindSafe(f));
    let payload = match result {
        Ok(_) => panic!("expected {code}, but the call succeeded"),
        Err(p) => p,
    };
    let msg = payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    // The mocked VM reports `GuestPanic { panic_msg: "<message>" }`.
    assert!(
        msg.contains(&format!("panic_msg: \"{code}:")),
        "expected {code}, got: {msg}"
    );
}

/// `(receiver, yocto)` of every transfer scheduled by the call that just ran.
fn transfers() -> Vec<(String, u128)> {
    use near_sdk::mock::MockAction;
    let mut out = Vec::new();
    for r in get_created_receipts() {
        for a in &r.actions {
            if let MockAction::Transfer { deposit, .. } = a {
                out.push((r.receiver_id.to_string(), deposit.as_yoctonear()));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// register_service
// ---------------------------------------------------------------------------------------------

#[test]
fn register_returns_sequential_ids() {
    let mut c = setup();
    assert_eq!(c.services_count(), 0);
    assert_eq!(register(&mut c), 1);
    assert_eq!(register(&mut c), 2);
    assert_eq!(c.services_count(), 2);

    let s = c.get_service(2).unwrap();
    assert_eq!(s.id, 2);
    assert_eq!(s.name, "Weather API");
    assert_eq!(s.owner, acct("owner.near"));
    assert_eq!(s.payment_target, acct("seller.near"));
    assert_eq!(s.attestor, acct("attestor.near"));
    assert!(s.active);
    assert_eq!(s.created_at_ms, 1_700_000_000_000);
    assert_eq!(s.accepts, vec![native(PRICE)]);
}

#[test]
fn register_rejects_empty_name() {
    let mut c = setup();
    ctx("owner.near", REGISTRATION_DEPOSIT_YOCTO);
    expect_err("ERR_EMPTY_NAME", || {
        c.register_service(
            "  ".to_string(),
            String::new(),
            String::new(),
            vec![native(PRICE)],
            acct("seller.near"),
            acct("attestor.near"),
        )
    });
    assert_eq!(c.services_count(), 0);
}

#[test]
fn register_trims_the_name() {
    let mut c = setup();
    ctx("owner.near", REGISTRATION_DEPOSIT_YOCTO);
    let id = c.register_service(
        "  Weather API \n".to_string(),
        String::new(),
        String::new(),
        vec![native(PRICE)],
        acct("seller.near"),
        acct("attestor.near"),
    );
    assert_eq!(c.get_service(id).unwrap().name, "Weather API");
}

#[test]
fn register_rejects_price_below_min() {
    let mut c = setup();
    expect_err("ERR_INVALID_PRICE", || {
        register_with(&mut c, vec![native(MIN_PRICE_YOCTO - 1)])
    });
    assert_eq!(c.services_count(), 0);
    // exactly the minimum is fine
    assert_eq!(register_with(&mut c, vec![native(MIN_PRICE_YOCTO)]), 1);
    // the minimum applies to non-native options too
    expect_err("ERR_INVALID_PRICE", || {
        register_with(&mut c, vec![native(PRICE), token(MIN_PRICE_YOCTO - 1)])
    });
}

#[test]
fn register_rejects_empty_or_oversized_accepts() {
    let mut c = setup();
    expect_err("ERR_INVALID_PRICE", || register_with(&mut c, vec![]));
    let five = vec![token(5), token(6), token(7), token(8), token(9)]
        .into_iter()
        .map(|mut o| {
            o.amount = U128(MIN_PRICE_YOCTO);
            o
        })
        .collect::<Vec<_>>();
    expect_err("ERR_INVALID_PRICE", || register_with(&mut c, five.clone()));
    // four options (one native) are the maximum
    let four = five[..3]
        .iter()
        .cloned()
        .chain([native(PRICE)])
        .collect::<Vec<_>>();
    assert_eq!(register_with(&mut c, four), 1);
}

#[test]
fn register_rejects_two_native_options() {
    let mut c = setup();
    expect_err("ERR_INVALID_PRICE", || {
        register_with(&mut c, vec![native(PRICE), native(PRICE * 2)])
    });
}

#[test]
fn register_rejects_long_fields() {
    let mut c = setup();
    let go = |c: &mut Registry, name: String, desc: String, url: String| {
        ctx("owner.near", REGISTRATION_DEPOSIT_YOCTO);
        c.register_service(
            name,
            desc,
            url,
            vec![native(PRICE)],
            acct("seller.near"),
            acct("attestor.near"),
        )
    };
    expect_err("ERR_FIELD_TOO_LONG", || {
        go(&mut c, "a".repeat(65), String::new(), String::new())
    });
    expect_err("ERR_FIELD_TOO_LONG", || {
        go(&mut c, "a".into(), "d".repeat(281), String::new())
    });
    expect_err("ERR_FIELD_TOO_LONG", || {
        go(&mut c, "a".into(), String::new(), "u".repeat(201))
    });
    // asset and symbol are bounded like a name
    let mut long_asset = native(PRICE);
    long_asset.symbol = "s".repeat(65);
    expect_err("ERR_FIELD_TOO_LONG", || {
        register_with(&mut c, vec![long_asset])
    });
    // the limits themselves are accepted
    assert_eq!(
        go(&mut c, "a".repeat(64), "d".repeat(280), "u".repeat(200)),
        1
    );
}

#[test]
fn register_requires_deposit() {
    let mut c = setup();
    ctx("owner.near", REGISTRATION_DEPOSIT_YOCTO - 1);
    expect_err("ERR_DEPOSIT_TOO_LOW", || {
        c.register_service(
            "n".to_string(),
            String::new(),
            String::new(),
            vec![native(PRICE)],
            acct("seller.near"),
            acct("attestor.near"),
        )
    });
    assert_eq!(c.services_count(), 0);
}

#[test]
fn register_keeps_the_deposit_and_refunds_the_excess() {
    let mut c = setup();
    ctx("owner.near", REGISTRATION_DEPOSIT_YOCTO + 5 * NEAR);
    c.register_service(
        "n".to_string(),
        String::new(),
        String::new(),
        vec![native(PRICE)],
        acct("seller.near"),
        acct("attestor.near"),
    );
    assert_eq!(transfers(), vec![("owner.near".to_string(), 5 * NEAR)]);

    // exactly the deposit: nothing to refund
    register(&mut c);
    assert!(transfers().is_empty());
}

// ---------------------------------------------------------------------------------------------
// pay
// ---------------------------------------------------------------------------------------------

#[test]
fn pay_records_payment_and_flags_self_pay() {
    let mut c = setup();
    let id = register(&mut c);

    ctx_at(
        "buyer.near",
        PRICE + PAYMENT_STORAGE_FEE_YOCTO,
        1_700_000_500_000,
        777,
    );
    c.pay(id, "12345".to_string());
    assert_eq!(
        c.get_payment("12345".to_string()),
        Some(PaymentView {
            nonce: "12345".to_string(),
            service_id: id,
            payer: acct("buyer.near"),
            amount: U128(PRICE),
            timestamp_ms: 1_700_000_500_000,
            block_height: 777,
            self_paid: false,
            attested: false,
        })
    );

    // the owner paying their own service, and the payment target paying it, are self-paid
    pay_as(&mut c, "owner.near", id, "2");
    assert!(c.get_payment("2".to_string()).unwrap().self_paid);
    pay_as(&mut c, "seller.near", id, "3");
    assert!(c.get_payment("3".to_string()).unwrap().self_paid);
    // the attestor is not an interested party for this flag
    pay_as(&mut c, "attestor.near", id, "4");
    assert!(!c.get_payment("4".to_string()).unwrap().self_paid);
}

#[test]
fn pay_forwards_exact_price_and_refunds_excess() {
    let mut c = setup();
    let id = register(&mut c);

    ctx("buyer.near", PRICE + PAYMENT_STORAGE_FEE_YOCTO + 3 * NEAR);
    c.pay(id, "1".to_string());
    assert_eq!(
        transfers(),
        vec![
            ("seller.near".to_string(), PRICE),
            ("buyer.near".to_string(), 3 * NEAR)
        ]
    );

    // exactly price + fee: forward only, no refund transfer
    pay_as(&mut c, "buyer.near", id, "2");
    assert_eq!(transfers(), vec![("seller.near".to_string(), PRICE)]);
}

#[test]
fn pay_rejects_low_deposit() {
    let mut c = setup();
    let id = register(&mut c);
    ctx("buyer.near", PRICE + PAYMENT_STORAGE_FEE_YOCTO - 1);
    expect_err("ERR_DEPOSIT_TOO_LOW", || c.pay(id, "1".to_string()));
    assert_eq!(c.get_payment("1".to_string()), None);
}

#[test]
fn pay_rejects_reused_nonce() {
    let mut c = setup();
    let id = register(&mut c);
    pay_as(&mut c, "buyer.near", id, "42");
    ctx("other.near", PRICE + PAYMENT_STORAGE_FEE_YOCTO);
    expect_err("ERR_NONCE_USED", || c.pay(id, "42".to_string()));
    // the first payer's record is untouched
    assert_eq!(
        c.get_payment("42".to_string()).unwrap().payer,
        acct("buyer.near")
    );
}

#[test]
fn pay_rejects_bad_nonce() {
    let mut c = setup();
    let id = register(&mut c);
    ctx("buyer.near", PRICE + PAYMENT_STORAGE_FEE_YOCTO);
    for bad in ["", "12a", "1 2", "-1", "123456789012345678901"] {
        expect_err("ERR_INVALID_NONCE", || c.pay(id, bad.to_string()));
    }
    // 20 digits is the maximum
    c.pay(id, "12345678901234567890".to_string());
    assert!(c.get_payment("12345678901234567890".to_string()).is_some());
}

#[test]
fn pay_rejects_inactive_and_unknown() {
    let mut c = setup();
    let id = register(&mut c);
    ctx("owner.near", 0);
    c.set_active(id, false);

    ctx("buyer.near", PRICE + PAYMENT_STORAGE_FEE_YOCTO);
    expect_err("ERR_SERVICE_INACTIVE", || c.pay(id, "1".to_string()));
    expect_err("ERR_SERVICE_NOT_FOUND", || c.pay(99, "1".to_string()));
    expect_err("ERR_SERVICE_NOT_FOUND", || c.pay(0, "1".to_string()));

    ctx("owner.near", 0);
    c.set_active(id, true);
    pay_as(&mut c, "buyer.near", id, "1");
}

#[test]
fn pay_rejects_service_without_native_option() {
    let mut c = setup();
    let id = register_with(&mut c, vec![token(MIN_PRICE_YOCTO)]);
    ctx("buyer.near", 10 * NEAR);
    expect_err("ERR_NO_NATIVE_PRICE", || c.pay(id, "1".to_string()));
}

#[test]
fn pay_uses_the_native_option_among_several() {
    let mut c = setup();
    let id = register_with(&mut c, vec![token(MIN_PRICE_YOCTO), native(PRICE * 3)]);
    ctx("buyer.near", PRICE * 3 + PAYMENT_STORAGE_FEE_YOCTO);
    c.pay(id, "1".to_string());
    assert_eq!(
        c.get_payment("1".to_string()).unwrap().amount,
        U128(PRICE * 3)
    );
    assert_eq!(transfers(), vec![("seller.near".to_string(), PRICE * 3)]);
}

// ---------------------------------------------------------------------------------------------
// record_attestation
// ---------------------------------------------------------------------------------------------

#[test]
fn attest_by_attestor_and_owner_ok_stranger_rejected() {
    let mut c = setup();
    let id = register(&mut c);
    pay_as(&mut c, "buyer.near", id, "1");
    pay_as(&mut c, "buyer.near", id, "2");
    pay_as(&mut c, "buyer.near", id, "3");

    attest_as(&mut c, "attestor.near", id, "1", "hash1", true);
    attest_as(&mut c, "owner.near", id, "2", "hash2", true);

    ctx("stranger.near", 0);
    expect_err("ERR_NOT_AUTHORIZED", || {
        c.record_attestation(id, "3".to_string(), "hash3".to_string(), true)
    });
    // the payer is not authorised either
    ctx("buyer.near", 0);
    expect_err("ERR_NOT_AUTHORIZED", || {
        c.record_attestation(id, "3".to_string(), "hash3".to_string(), true)
    });
    assert!(!c.get_payment("3".to_string()).unwrap().attested);
    assert_eq!(c.get_score(id).total_calls, 2);
}

#[test]
fn attest_rejects_unknown_service_and_inactive_service() {
    let mut c = setup();
    let id = register(&mut c);
    pay_as(&mut c, "buyer.near", id, "1");

    ctx("attestor.near", 0);
    expect_err("ERR_SERVICE_NOT_FOUND", || {
        c.record_attestation(99, "1".to_string(), "h".to_string(), true)
    });

    ctx("owner.near", 0);
    c.set_active(id, false);
    ctx("attestor.near", 0);
    expect_err("ERR_SERVICE_INACTIVE", || {
        c.record_attestation(id, "1".to_string(), "h".to_string(), true)
    });
}

#[test]
fn attest_rejects_unknown_wrong_service_double() {
    let mut c = setup();
    let a = register(&mut c);
    let b = register(&mut c);
    pay_as(&mut c, "buyer.near", a, "1");

    ctx("attestor.near", 0);
    expect_err("ERR_PAYMENT_NOT_FOUND", || {
        c.record_attestation(a, "404".to_string(), "h".to_string(), true)
    });
    expect_err("ERR_PAYMENT_WRONG_SERVICE", || {
        c.record_attestation(b, "1".to_string(), "h".to_string(), true)
    });

    attest_as(&mut c, "attestor.near", a, "1", "h", true);
    ctx("attestor.near", 0);
    expect_err("ERR_ALREADY_ATTESTED", || {
        c.record_attestation(a, "1".to_string(), "h".to_string(), true)
    });
    assert_eq!(
        c.get_score(a),
        ScoreView {
            total_calls: 1,
            success_calls: 1
        }
    );
}

#[test]
fn self_paid_payment_cannot_be_attested() {
    let mut c = setup();
    let id = register(&mut c);
    pay_as(&mut c, "owner.near", id, "1");
    pay_as(&mut c, "seller.near", id, "2");
    for nonce in ["1", "2"] {
        ctx("attestor.near", 0);
        expect_err("ERR_SELF_PAYMENT", || {
            c.record_attestation(id, nonce.to_string(), "h".to_string(), true)
        });
        ctx("owner.near", 0);
        expect_err("ERR_SELF_PAYMENT", || {
            c.record_attestation(id, nonce.to_string(), "h".to_string(), true)
        });
    }
    assert_eq!(
        c.get_score(id),
        ScoreView {
            total_calls: 0,
            success_calls: 0
        }
    );
    assert!(c.get_attestations(id).is_empty());
}

#[test]
fn attest_rejects_long_tx_hash() {
    let mut c = setup();
    let id = register(&mut c);
    pay_as(&mut c, "buyer.near", id, "1");
    ctx("attestor.near", 0);
    expect_err("ERR_FIELD_TOO_LONG", || {
        c.record_attestation(id, "1".to_string(), "h".repeat(65), true)
    });
    assert!(!c.get_payment("1".to_string()).unwrap().attested);
    // 64 chars is fine
    c.record_attestation(id, "1".to_string(), "h".repeat(64), true);
    assert!(c.get_payment("1".to_string()).unwrap().attested);
}

#[test]
fn score_counts_total_and_success() {
    let mut c = setup();
    let id = register(&mut c);
    for (nonce, success) in [("1", true), ("2", false), ("3", true)] {
        pay_as(&mut c, "buyer.near", id, nonce);
        attest_as(&mut c, "attestor.near", id, nonce, "h", success);
    }
    assert_eq!(
        c.get_score(id),
        ScoreView {
            total_calls: 3,
            success_calls: 2
        }
    );
}

#[test]
fn attestations_capped_newest_first() {
    let mut c = setup();
    let id = register(&mut c);
    for n in 1..=101u32 {
        let nonce = n.to_string();
        pay_as(&mut c, "buyer.near", id, &nonce);
        ctx_at(
            "attestor.near",
            0,
            1_700_000_000_000 + u64::from(n),
            100 + u64::from(n),
        );
        c.record_attestation(id, nonce.clone(), format!("tx{n}"), n % 2 == 1);
    }
    let list = c.get_attestations(id);
    assert_eq!(list.len(), 100);
    assert_eq!(list[0].nonce, "101");
    assert_eq!(list[0].payment_tx_hash, "tx101");
    assert_eq!(list[0].timestamp_ms, 1_700_000_000_101);
    assert!(list[0].success);
    assert_eq!(list[99].nonce, "2"); // "1" fell off the end
    // the score counts every attestation, not just the retained ones
    assert_eq!(
        c.get_score(id),
        ScoreView {
            total_calls: 101,
            success_calls: 51
        }
    );
}

// ---------------------------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------------------------

#[test]
fn activity_ring_newest_first_and_capped() {
    let mut c = setup();
    let id = register(&mut c);
    for n in 1..=205u32 {
        pay_as(&mut c, "buyer.near", id, &n.to_string());
    }
    let all = c.get_recent_activity(500);
    assert_eq!(all.len(), 200);
    assert!(all.iter().all(|a| a.kind == ActivityKind::Payment));
    assert_eq!(all[0].nonce.as_deref(), Some("205"));
    assert_eq!(all[1].nonce.as_deref(), Some("204"));
    assert_eq!(all[199].nonce.as_deref(), Some("6"));
    assert_eq!(c.get_recent_activity(3).len(), 3);
    assert_eq!(c.get_recent_activity(0).len(), 0);
}

#[test]
fn activity_mixes_the_three_kinds() {
    let mut c = setup();
    ctx_at(
        "owner.near",
        REGISTRATION_DEPOSIT_YOCTO,
        1_700_000_001_000,
        11,
    );
    let id = c.register_service(
        "n".to_string(),
        String::new(),
        String::new(),
        vec![native(PRICE)],
        acct("seller.near"),
        acct("attestor.near"),
    );
    ctx_at(
        "buyer.near",
        PRICE + PAYMENT_STORAGE_FEE_YOCTO,
        1_700_000_002_000,
        12,
    );
    c.pay(id, "7".to_string());
    ctx_at("attestor.near", 0, 1_700_000_003_000, 13);
    c.record_attestation(id, "7".to_string(), "txhash".to_string(), false);

    let a = c.get_recent_activity(10);
    assert_eq!(a.len(), 3);
    assert_eq!(
        a[0],
        ActivityView {
            kind: ActivityKind::Attestation,
            service_id: id,
            account: acct("attestor.near"),
            amount: None,
            success: Some(false),
            nonce: Some("7".to_string()),
            payment_tx_hash: Some("txhash".to_string()),
            timestamp_ms: 1_700_000_003_000,
            block_height: 13,
        }
    );
    assert_eq!(
        a[1],
        ActivityView {
            kind: ActivityKind::Payment,
            service_id: id,
            account: acct("buyer.near"),
            amount: Some(U128(PRICE)),
            success: None,
            nonce: Some("7".to_string()),
            payment_tx_hash: None,
            timestamp_ms: 1_700_000_002_000,
            block_height: 12,
        }
    );
    assert_eq!(
        a[2],
        ActivityView {
            kind: ActivityKind::ServiceRegistered,
            service_id: id,
            account: acct("owner.near"),
            amount: None,
            success: None,
            nonce: None,
            payment_tx_hash: None,
            timestamp_ms: 1_700_000_001_000,
            block_height: 11,
        }
    );
}

// ---------------------------------------------------------------------------------------------
// owner controls and views
// ---------------------------------------------------------------------------------------------

#[test]
fn set_active_and_set_attestor_owner_only() {
    let mut c = setup();
    let id = register(&mut c);

    // the attestor and strangers cannot touch either setting
    for who in ["attestor.near", "stranger.near", "seller.near"] {
        ctx(who, 0);
        expect_err("ERR_NOT_AUTHORIZED", || c.set_active(id, false));
        expect_err("ERR_NOT_AUTHORIZED", || {
            c.set_attestor(id, acct("stranger.near"))
        });
    }
    assert!(c.get_service(id).unwrap().active);
    assert_eq!(c.get_service(id).unwrap().attestor, acct("attestor.near"));

    ctx("owner.near", 0);
    c.set_active(id, false);
    assert!(!c.get_service(id).unwrap().active);
    c.set_attestor(id, acct("attestor2.near"));
    assert_eq!(c.get_service(id).unwrap().attestor, acct("attestor2.near"));
    expect_err("ERR_SERVICE_NOT_FOUND", || c.set_active(99, true));
    expect_err("ERR_SERVICE_NOT_FOUND", || {
        c.set_attestor(99, acct("a.near"))
    });

    // the rotated attestor takes over; the old one is out
    ctx("owner.near", 0);
    c.set_active(id, true);
    pay_as(&mut c, "buyer.near", id, "1");
    ctx("attestor.near", 0);
    expect_err("ERR_NOT_AUTHORIZED", || {
        c.record_attestation(id, "1".to_string(), "h".to_string(), true)
    });
    attest_as(&mut c, "attestor2.near", id, "1", "h", true);
}

#[test]
fn list_services_paginates() {
    let mut c = setup();
    for _ in 0..3 {
        register(&mut c);
    }
    let ids = |v: Vec<ServiceView>| v.into_iter().map(|s| s.id).collect::<Vec<_>>();
    ctx("anyone.near", 0);
    assert_eq!(ids(c.list_services(2, 2)), vec![2, 3]);
    assert_eq!(ids(c.list_services(1, 10)), vec![1, 2, 3]);
    assert_eq!(ids(c.list_services(0, 10)), vec![1, 2, 3]); // ids are 1-based; 0 starts at 1
    assert_eq!(ids(c.list_services(3, 10)), vec![3]);
    assert!(c.list_services(4, 10).is_empty());
    assert!(c.list_services(1, 0).is_empty());

    for _ in 3..60 {
        register(&mut c);
    }
    assert_eq!(c.services_count(), 60);
    let page = c.list_services(1, 100);
    assert_eq!(page.len(), 50); // limit clamped to 50
    assert_eq!(page[0].id, 1);
    assert_eq!(page[49].id, 50);
    assert_eq!(ids(c.list_services(51, 100)), (51..=60).collect::<Vec<_>>());
}

#[test]
fn views_for_unknown_ids_are_empty() {
    let c = setup();
    assert_eq!(c.get_service(1), None);
    assert_eq!(
        c.get_score(1),
        ScoreView {
            total_calls: 0,
            success_calls: 0
        }
    );
    assert!(c.get_attestations(1).is_empty());
    assert_eq!(c.get_payment("1".to_string()), None);
    assert!(c.get_recent_activity(10).is_empty());
    assert!(c.list_services(1, 10).is_empty());
}

// ---------------------------------------------------------------------------------------------
// storage accounting
// ---------------------------------------------------------------------------------------------

const IMPLICIT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 chars

fn storage_bytes() -> u64 {
    near_sdk::env::storage_usage()
}

#[test]
fn pay_storage_fits_the_fee_with_the_longest_inputs() {
    let mut c = setup();
    let id = register(&mut c);
    let fee_bytes = u64::try_from(
        PAYMENT_STORAGE_FEE_YOCTO / near_sdk::env::storage_byte_cost().as_yoctonear(),
    )
    .unwrap();
    assert_eq!(fee_bytes, 200);

    // Every ring slot in turn: first pass fills the placeholders, second pass overwrites
    // payment entries. The payer is a 64-char implicit account and the nonce has 20 digits.
    let mut worst = 0u64;
    for i in 0..450u32 {
        let nonce = format!("{:020}", 10u128.pow(19) + u128::from(i));
        ctx(IMPLICIT, PRICE + PAYMENT_STORAGE_FEE_YOCTO);
        let before = storage_bytes();
        c.pay(id, nonce);
        let delta = storage_bytes().saturating_sub(before);
        worst = worst.max(delta);
    }
    println!("worst-case pay storage: {worst} bytes (budget {fee_bytes})");
    assert!(
        worst <= fee_bytes,
        "pay grew storage by {worst} bytes, fee covers {fee_bytes}"
    );
}

#[test]
fn storage_guard_rejects_cost_above_budget() {
    check_storage(PAYMENT_STORAGE_FEE_YOCTO, PAYMENT_STORAGE_FEE_YOCTO);
    expect_err("ERR_STORAGE_EXCEEDED", || {
        check_storage(PAYMENT_STORAGE_FEE_YOCTO + 1, PAYMENT_STORAGE_FEE_YOCTO)
    });
}

#[test]
fn register_storage_fits_the_deposit_with_the_longest_inputs() {
    let mut c = setup();
    let accepts: Vec<PaymentOption> = (0..4)
        .map(|i| PaymentOption {
            asset: if i == 0 {
                "near".to_string()
            } else {
                format!("{}{i}", "t".repeat(60))
            },
            amount: U128(PRICE),
            decimals: 24,
            symbol: "s".repeat(64),
        })
        .collect();
    ctx(IMPLICIT, REGISTRATION_DEPOSIT_YOCTO);
    let before = storage_bytes();
    c.register_service(
        "n".repeat(64),
        "d".repeat(280),
        "u".repeat(200),
        accepts,
        acct(IMPLICIT),
        acct(IMPLICIT),
    );
    let bytes = storage_bytes() - before;
    let yocto = u128::from(bytes) * near_sdk::env::storage_byte_cost().as_yoctonear();
    println!("worst-case register storage: {bytes} bytes = {yocto} yocto");
    assert!(yocto <= REGISTRATION_DEPOSIT_YOCTO);
}

// ---------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------

fn events() -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str(j).unwrap())
        .collect()
}

#[test]
fn events_are_nep297_json() {
    let mut c = setup();
    let id = register(&mut c);
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["standard"], "neargate");
    assert_eq!(e[0]["version"], "1.0.0");
    assert_eq!(e[0]["event"], "service_registered");
    assert_eq!(e[0]["data"]["service_id"], id);
    assert_eq!(e[0]["data"]["owner"], "owner.near");

    ctx("buyer.near", PRICE + PAYMENT_STORAGE_FEE_YOCTO);
    c.pay(id, "5".to_string());
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "payment");
    assert_eq!(e[0]["data"]["nonce"], "5");
    assert_eq!(e[0]["data"]["payer"], "buyer.near");
    assert_eq!(e[0]["data"]["amount"], PRICE.to_string());
    assert_eq!(e[0]["data"]["self_paid"], false);

    ctx("attestor.near", 0);
    c.record_attestation(id, "5".to_string(), "tx".to_string(), true);
    let e = events();
    assert_eq!(e[0]["event"], "attestation");
    assert_eq!(e[0]["data"]["payment_tx_hash"], "tx");
    assert_eq!(e[0]["data"]["success"], true);

    ctx("owner.near", 0);
    c.set_active(id, false);
    assert_eq!(events()[0]["event"], "service_status");
    assert_eq!(events()[0]["data"]["active"], false);
    c.set_attestor(id, acct("new.near"));
    let e = events();
    assert_eq!(e[e.len() - 1]["event"], "attestor_changed");
    assert_eq!(e[e.len() - 1]["data"]["attestor"], "new.near");
}

#[test]
fn views_serialize_to_the_documented_json() {
    let mut c = setup();
    let id = register(&mut c);
    pay_as(&mut c, "buyer.near", id, "9");
    let s = near_sdk::serde_json::to_value(c.get_service(id)).unwrap();
    assert_eq!(s["accepts"][0]["amount"], PRICE.to_string()); // U128 is a decimal string
    assert_eq!(s["accepts"][0]["asset"], "near");
    assert_eq!(s["created_at_ms"], 1_700_000_000_000u64);
    let p = near_sdk::serde_json::to_value(c.get_payment("9".to_string())).unwrap();
    assert_eq!(p["amount"], PRICE.to_string());
    assert_eq!(p["self_paid"], false);
    let a = near_sdk::serde_json::to_value(c.get_recent_activity(1)).unwrap();
    assert_eq!(a[0]["kind"], "payment");
    assert!(a[0]["success"].is_null());
}
