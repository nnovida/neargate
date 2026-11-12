#!/usr/bin/env bash
# scripts/near/deploy-registry.sh — build the neargate-registry contract and deploy it to testnet.
#
#   1. cargo near build non-reproducible-wasm   (in contracts/registry, with $HOME remapped to
#      /build; a wasm that still embeds a path under $HOME is refused)
#   2. near contract deploy <registry> use-file <wasm> with-init-call new json-args '{}' …
#   3. near contract call-function as-read-only <registry> services_count …
#      and the same view read through JSON-RPC: it must be 0 on a fresh deploy, or this fails
#
# The deploy is signed by the registry account's own key, which npm run near:bootstrap saved in
# ~/.near-credentials/testnet/. `new` takes no arguments and sets no admin: the contract has no
# owner. Refuses to deploy onto an account that already holds a contract (a second `new` would
# fail anyway) unless FORCE_REDEPLOY=1, which deploys the code only, WITHOUT `new`, keeping the
# state. That is an upgrade: it only works when the new code reads the old state layout, and the
# services_count it then prints is the existing one.
#
# Environment:
#   REGISTRY_CONTRACT_ID  the registry account (else <NEARGATE_PREFIX>-registry.testnet)
#   NEARGATE_PREFIX       as in bootstrap-testnet.sh (default neargate-<MMDD>)
#   NEARGATE_REGISTRY_WASM  deploy this prebuilt wasm and skip the build
#   MIN_REGISTRY_BALANCE_NEAR  whole NEAR the account must hold first (default 3: the code locks
#                           about 1.8 NEAR and the activity ring up to 0.5 NEAR more)
#   FORCE_REDEPLOY=1      see above
#   NEAR_RPC_URL          RPC for the read-only checks (default https://rpc.testnet.near.org)
#   DRY_RUN=1             print every command instead of running it; nothing is built or sent,
#                         and the network is not contacted at all
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY="${REGISTRY_CONTRACT_ID:-${NEARGATE_PREFIX:-neargate-$(date +%m%d)}-registry.testnet}"
RPC_URL="${NEAR_RPC_URL:-https://rpc.testnet.near.org}"
DRY_RUN="${DRY_RUN:-0}"
FORCE_REDEPLOY="${FORCE_REDEPLOY:-0}"
MIN_BALANCE_NEAR="${MIN_REGISTRY_BALANCE_NEAR:-3}"
BUILT_WASM="$ROOT/contracts/target/near/neargate_registry/neargate_registry.wasm"
WASM="${NEARGATE_REGISTRY_WASM:-$BUILT_WASM}"
# The wasm keeps the source path of every panic location. Remapping the builder's home directory
# to /build keeps the local user name out of the code published on-chain; -C link-arg=-s is what
# cargo-near passes by default, kept because --env RUSTFLAGS replaces it.
WASM_RUSTFLAGS="-C link-arg=-s --remap-path-prefix=$HOME=/build"
NETWORK=testnet
NO_CODE_HASH=11111111111111111111111111111111

SCRIPT_NAME=deploy-registry
# shellcheck source=scripts/near/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# yocto_ge A B: A >= B for non-negative decimal integers (no leading zeros), any length.
yocto_ge() {
  local a=$1 b=$2
  if [ "${#a}" -ne "${#b}" ]; then
    [ "${#a}" -gt "${#b}" ] && return 0
    return 1
  fi
  [ "$a" = "$b" ] && return 0
  [[ $a > $b ]] && return 0
  return 1
}

# read_services_count: the registry's services_count view through JSON-RPC call_function; prints
# the decimal count, or fails. The reply carries the view's JSON output as an array of bytes
# ("0" is [48]); a registry that is not there yet answers an error object instead.
read_services_count() {
  local reply bytes count
  reply=$(rpc_query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$REGISTRY\",\"method_name\":\"services_count\",\"args_base64\":\"e30=\"}") || return 1
  bytes=$(printf '%s' "$reply" | sed -n 's/.*"result":\[\([0-9,]*\)\].*/\1/p')
  [ -n "$bytes" ] || return 1
  count=$(printf '%s' "$bytes" | awk -F, '{ for (i = 1; i <= NF; i++) printf "%c", $i }')
  [[ $count =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$count"
}

# deploy [INIT_ARG...]: the deploy command with the given init arguments.
deploy() {
  run near contract deploy "$REGISTRY" use-file "$WASM" "$@" network-config "$NETWORK" sign-with-legacy-keychain send
}

[[ $REGISTRY =~ ^[a-z0-9._-]+\.testnet$ && ${#REGISTRY} -le 64 ]] \
  || die "'$REGISTRY' is not a testnet account id (set REGISTRY_CONTRACT_ID or NEARGATE_PREFIX)"
[[ $MIN_BALANCE_NEAR =~ ^[0-9]+$ ]] || die "MIN_REGISTRY_BALANCE_NEAR must be a whole number of NEAR"

INIT_ARGS=(with-init-call new json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR')
UPGRADE=0

# -- the plan ------------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "deploy-registry: DRY_RUN=1. Nothing is built or sent, and the network is not contacted."
else
  say "deploy-registry: rpc=$RPC_URL"
fi
say "registry: $REGISTRY ($NETWORK)"
if [ -n "${NEARGATE_REGISTRY_WASM:-}" ]; then
  say "wasm:     $WASM (prebuilt, build skipped)"
else
  say "wasm:     $WASM (built below)"
fi

# -- preconditions (read-only) ---------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] would check, read-only via JSON-RPC view_account at $RPC_URL:"
  say "[dry-run]   $REGISTRY exists (else: run npm run near:bootstrap)"
  say "[dry-run]   it holds at least $MIN_BALANCE_NEAR NEAR"
  say "[dry-run]   it has no contract yet (else refuse; FORCE_REDEPLOY=1 deploys the code without \`new\`)"
else
  command -v near > /dev/null 2>&1 || die "near-cli-rs ('near') not found on PATH"
  command -v curl > /dev/null 2>&1 || die "curl not found on PATH"
  [ -n "${NEARGATE_REGISTRY_WASM:-}" ] || command -v cargo > /dev/null 2>&1 || die "cargo not found on PATH (needed to build the wasm)"
  view_account "$REGISTRY"
  [ "$ACCOUNT_STATE" != missing ] || die "$REGISTRY does not exist: run npm run near:bootstrap first (or set REGISTRY_CONTRACT_ID / NEARGATE_PREFIX)"
  amount=$(printf '%s' "$ACCOUNT_STATE" | sed -n 's/.*"amount":"\([0-9]*\)".*/\1/p')
  code_hash=$(printf '%s' "$ACCOUNT_STATE" | sed -n 's/.*"code_hash":"\([^"]*\)".*/\1/p')
  [ -n "$amount" ] && [ -n "$code_hash" ] || die "could not read the balance and code hash of $REGISTRY"
  yocto_ge "$amount" "${MIN_BALANCE_NEAR}000000000000000000000000" \
    || die "$REGISTRY holds $amount yoctoNEAR, under the $MIN_BALANCE_NEAR NEAR the registry needs. Top it up from a funded testnet account, or lower MIN_REGISTRY_BALANCE_NEAR."
  if [ "$code_hash" != "$NO_CODE_HASH" ]; then
    [ "$FORCE_REDEPLOY" = 1 ] \
      || die "$REGISTRY already holds a contract (code hash $code_hash) and a second \`new\` would fail. Set FORCE_REDEPLOY=1 to deploy the code over it WITHOUT \`new\` (keeps the state), or use a fresh account."
    say "FORCE_REDEPLOY=1: $REGISTRY holds a contract; deploying the code only, without \`new\` (state is kept)."
    INIT_ARGS=(without-init-call)
    UPGRADE=1
  fi
fi

# -- 1. build ----------------------------------------------------------------------------------
if [ -z "${NEARGATE_REGISTRY_WASM:-}" ]; then
  say ""
  say "== build (contracts/registry)"
  (cd "$ROOT/contracts/registry" && run cargo near build non-reproducible-wasm --env "RUSTFLAGS=$WASM_RUSTFLAGS")
fi
if [ "$DRY_RUN" != 1 ]; then
  [ -f "$WASM" ] || die "wasm not found at $WASM (the build writes it there; or set NEARGATE_REGISTRY_WASM)"
  if [ -n "${HOME:-}" ] && [ "$HOME" != / ] && grep -aqF "$HOME/" "$WASM"; then
    die "$WASM embeds paths under $HOME; refusing to publish them on-chain. Build it with: cargo near build non-reproducible-wasm --env 'RUSTFLAGS=$WASM_RUSTFLAGS'"
  fi
  say "wasm: $(wc -c < "$WASM" | tr -d ' ') bytes, sha256 $(sha256_of "$WASM")"
fi

# -- 2. deploy ---------------------------------------------------------------------------------
say ""
say "== deploy"
if [ "$DRY_RUN" = 1 ] && [ "$FORCE_REDEPLOY" = 1 ]; then
  # Which one runs depends on the account's code hash, which a dry run does not read.
  say "[dry-run] FORCE_REDEPLOY=1: the init call is chosen at run time from the on-chain code hash. Either:"
  say "[dry-run] (a) no contract on $REGISTRY yet, a fresh deploy:"
  deploy "${INIT_ARGS[@]}"
  say "[dry-run] (b) a contract already there, a code-only upgrade that keeps its state:"
  deploy without-init-call
else
  deploy "${INIT_ARGS[@]}"
fi

# -- 3. check ----------------------------------------------------------------------------------
say ""
if [ "$UPGRADE" = 1 ]; then
  say "== services_count (an upgrade keeps the existing services: this is the current count)"
else
  say "== services_count (must be 0 on a fresh deploy)"
fi
run near contract call-function as-read-only "$REGISTRY" services_count json-args '{}' \
  network-config "$NETWORK" now
if [ "$DRY_RUN" = 1 ]; then
  if [ "$FORCE_REDEPLOY" = 1 ]; then
    say "[dry-run] then read services_count through JSON-RPC call_function: print it after an upgrade (b), fail unless it is 0 after a fresh deploy (a)"
  else
    say "[dry-run] then read services_count through JSON-RPC call_function and fail unless it is 0"
  fi
else
  count=
  for _ in 1 2 3 4 5; do
    count=$(read_services_count) && break
    count=
    sleep 2
  done
  [ -n "$count" ] || die "deployed, but could not read services_count from $RPC_URL: read it with the near command above before going on"
  if [ "$UPGRADE" = 1 ]; then
    say "services_count: $count (current)"
  elif [ "$count" = 0 ]; then
    say "services_count: 0 (as expected on a fresh deploy)"
  else
    die "services_count is $count on a fresh deploy, expected 0: $REGISTRY holds state this deploy did not create. Do not use it; start from a fresh account."
  fi
fi

say ""
say "registry: https://testnet.nearblocks.io/address/$REGISTRY"
say "Next: set REGISTRY_CONTRACT_ID=$REGISTRY in .env (npm run near:seed and npm run smoke:live read it)."
