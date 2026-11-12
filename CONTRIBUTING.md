# Contributing to NearGate

Thanks for your interest in improving NearGate! Contributions of all kinds are
welcome: bug reports, docs fixes, tests and features.

## Getting set up

Requirements: **Node.js >= 22.22.2** (near-api-js 7.4.0 needs it). Rust and
cargo-near are needed only if you touch the contract (see `contracts/README.md`).

```bash
git clone <REPO_URL> neargate-app
cd neargate-app
npm install
npm run demo        # one-shot offline demo: six lines, exits 0
```

The repo is an npm workspace monorepo:

- `packages/*`: TypeScript packages (gateway middleware, chain client, client, CLI, buyer agent, shared, devnet, oracle)
- `dashboard/`: the Next.js dashboard
- `contracts/registry`: `neargate-registry`, the NEAR contract (Rust, near-sdk)

The CLI runs from the repo: `npm run neargate -- <command>` (for example
`npm run neargate -- list --mode mock` against `npm run dev`).

## Before you open a PR

Run the full local verification:

```bash
npm test            # vitest: package units, e2e flows on the mock chain, the dashboard, the README and copy guards
npm run typecheck   # all workspaces + root
npm run demo        # must still print its six lines
```

If you changed the contract, build its wasm and run its tests from `contracts/`
(the sandbox tests deploy the wasm; `contracts/README.md` has the toolchain):

```bash
cd contracts/registry && cargo near build non-reproducible-wasm && cd ..
cargo test
```

## Pull request flow

1. Fork and create a topic branch from `main`.
2. Keep changes focused; add or update tests for behavior changes.
3. Make sure CI is green (`.github/workflows/ci.yml` runs the typecheck, the tests, the dashboard build, the demo and the contract tests).
4. Open a PR against `main` and fill in the PR template.

## Reporting bugs & requesting features

Use the issue templates. For security vulnerabilities, **do not open a public
issue**; see [SECURITY.md](SECURITY.md).

## Docs

How it works, the NEAR features used, the deployment and the limits are in the
[README](README.md). The full protocol, CLI, contract and security reference
is the dashboard's `/docs` section (sources under `dashboard/app/docs/`); the
contract's ABI and storage accounting are in `contracts/README.md`.
