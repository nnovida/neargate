# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `@neargate/cli` latest (0.1.x) | ✅ |
| older pre-release snapshots | ❌ |

The on-chain registry contract currently supported is the Casper Testnet
package `hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9`.

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

Preferred: use GitHub's private vulnerability reporting —
[Report a vulnerability](https://example.invalid/AgentGate/security/advisories/new).

Alternatively, email **contributors@agentgate.invalid** with:

- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested fix, if you have one.

You can expect an acknowledgement within **72 hours** and a status update as
the fix progresses. Please give us a reasonable window to remediate before any
public disclosure.

## Scope notes

- The gateway only ever sees payment *proofs* (transaction hashes); it never
  holds user private keys. Signing keys for the demo deployment live outside
  the repository.
- Testnet CSPR has no monetary value, but vulnerabilities in the payment
  verification path (invoice nonce, transfer matching, attestation binding)
  are still treated as high severity.
