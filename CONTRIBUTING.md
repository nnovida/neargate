# Contributing to AgentGate

Thanks for your interest in improving AgentGate! Contributions of all kinds are
welcome — bug reports, docs fixes, tests, and features.

## Getting set up

Requirements: **Node.js >= 22** (and Rust + [Odra](https://odra.dev) only if you
touch the smart contracts).

```bash
git clone https://example.invalid/AgentGate.git
cd AgentGate
npm install
npm run demo        # one-shot offline demo — should exit 0
```

The repo is an npm workspace monorepo:

- `packages/*` — TypeScript packages (middleware, chain client, CLI, SDK, buyer agent, shared)
- `dashboard/` — Next.js dashboard
- `contracts/agentgate-registry` — the Odra/Rust registry contract deployed on Casper Testnet

## Before you open a PR

Run the full local verification:

```bash
npm test            # vitest suite (unit + e2e loop)
npm run typecheck   # all workspaces + root
```

If you changed the contract, also run its tests from `contracts/agentgate-registry`
(see `contracts/README.md` for the Odra toolchain setup).

## Pull request flow

1. Fork and create a topic branch from `main`.
2. Keep changes focused; add or update tests for behavior changes.
3. Make sure CI is green (`.github/workflows/ci.yml` runs tests + typecheck).
4. Open a PR against `main` and fill in the PR template.

## Reporting bugs & requesting features

Use the issue templates. For security vulnerabilities, **do not open a public
issue** — see [SECURITY.md](SECURITY.md).

## Docs

Architecture and protocol details live in `docs/` (`ARCHITECTURE.md`, `SPEC.md`).
The live deployment details (contract package hash, sample transactions) are in
the README's "Deployed addresses" section.
