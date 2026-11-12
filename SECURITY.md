# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main` of this repository (NearGate, NEAR testnet) | ✅ |
| older snapshots | ❌ |

The supported on-chain contract is the `neargate-registry` deployment on NEAR
testnet named in the README's "Deployed on NEAR testnet" section.

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

Preferred: use GitHub's private vulnerability reporting on this repository
(the **Security** tab → **Report a vulnerability**).

Alternatively, email **contributors@agentgate.invalid** with:

- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested fix, if you have one.

You can expect an acknowledgement within **72 hours** and a status update as
the fix progresses. Please give us a reasonable window to remediate before any
public disclosure.

## Scope notes

- The gateway never holds user private keys. It sees payment *proofs*:
  transaction hashes, or, on the gasless rail, a buyer's signed
  `pay_from_escrow` delegate, which it can only relay as signed. Its own
  account key (attestations and relays) and every other signing key live
  outside the repository.
- Testnet NEAR has no monetary value, but vulnerabilities in the payment
  verification path (invoice nonce, payment and transaction matching, delegate
  checks, attestation binding) are still treated as high severity.
- Known limits, such as front-running of `tx` proofs and the blast radius of a
  leaked agent key, are listed in the README's "Limits and trust model".
