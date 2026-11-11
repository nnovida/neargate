#!/usr/bin/env bash
# scripts/near/deploy-registry.sh — build the neargate-registry contract and deploy it to testnet.
#
#   1. cargo near build non-reproducible-wasm   (in contracts/registry)
#   2. near contract deploy <registry> use-file <wasm> with-init-call new json-args '{}' …
#   3. near contract call-function as-read-only <registry> services_count …   (expect 0)
#
# The deploy is signed by the registry account's own key, which npm run near:bootstrap saved in
# ~/.near-credentials/testnet/. `new` takes no arguments and sets no admin: the contract has no
# owner. Refuses to deploy onto an account that already holds a contract (a second `new` would
# fail anyway) unless FORCE_REDEPLOY=1, which deploys the code only, WITHOUT `new`, keeping the
# state. That is an upgrade: it only works when the new code reads the old state layout.
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
NETWORK=testnet
NO_CODE_HASH=11111111111111111111111111111111

say() { printf '%s\n' "$*"; }
die() { printf 'deploy-registry: %s\n' "$*" >&2; exit 1; }

# show ARG...: the arguments as a shell-pasteable command line.
show() {
  local a
  for a in "$@"; do
    if [[ $a =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
      printf '%s ' "$a"
    elif [[ $a != *\'* ]]; then
      printf "'%s' " "$a"
    else
      printf '%q ' "$a"
    fi
  done
}

# run CMD...: print the command; run it unless DRY_RUN=1.
run() {
  local line
  line=$(show "$@")
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "${line% }"; else printf '+ %s\n' "${line% }"; fi
  [ "$DRY_RUN" = 1 ] || "$@"
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

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# view_account ID: read-only JSON-RPC view_account; prints the reply, "missing" when the account
# does not exist. Dies when the RPC cannot be reached or answers something unexpected.
view_account() {
  local id=$1 reply
  reply=$(curl -fsS --max-time 20 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"neargate\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$id\"}}" \
    "$RPC_URL") || die "could not reach $RPC_URL to check $id"
  case $reply in
    *'"code_hash"'*) printf '%s' "$reply" ;;
    *UNKNOWN_ACCOUNT* | *'does not exist'*) printf 'missing' ;;
    *) die "unexpected answer from $RPC_URL for $id: ${reply:0:200}" ;;
  esac
}

[[ $REGISTRY =~ ^[a-z0-9._-]+\.testnet$ && ${#REGISTRY} -le 64 ]] \
  || die "'$REGISTRY' is not a testnet account id (set REGISTRY_CONTRACT_ID or NEARGATE_PREFIX)"
[[ $MIN_BALANCE_NEAR =~ ^[0-9]+$ ]] || die "MIN_REGISTRY_BALANCE_NEAR must be a whole number of NEAR"

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
init_args=(with-init-call new json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR')
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] would check, read-only via JSON-RPC view_account at $RPC_URL:"
  say "[dry-run]   $REGISTRY exists (else: run npm run near:bootstrap)"
  say "[dry-run]   it holds at least $MIN_BALANCE_NEAR NEAR"
  say "[dry-run]   it has no contract yet (else refuse; FORCE_REDEPLOY=1 deploys the code without \`new\`)"
else
  command -v near > /dev/null 2>&1 || die "near-cli-rs ('near') not found on PATH"
  command -v curl > /dev/null 2>&1 || die "curl not found on PATH"
  [ -n "${NEARGATE_REGISTRY_WASM:-}" ] || command -v cargo > /dev/null 2>&1 || die "cargo not found on PATH (needed to build the wasm)"
  state=$(view_account "$REGISTRY")
  [ "$state" != missing ] || die "$REGISTRY does not exist: run npm run near:bootstrap first (or set REGISTRY_CONTRACT_ID / NEARGATE_PREFIX)"
  amount=$(printf '%s' "$state" | sed -n 's/.*"amount":"\([0-9]*\)".*/\1/p')
  code_hash=$(printf '%s' "$state" | sed -n 's/.*"code_hash":"\([^"]*\)".*/\1/p')
  [ -n "$amount" ] && [ -n "$code_hash" ] || die "could not read the balance and code hash of $REGISTRY"
  yocto_ge "$amount" "${MIN_BALANCE_NEAR}000000000000000000000000" \
    || die "$REGISTRY holds $amount yoctoNEAR, under the $MIN_BALANCE_NEAR NEAR the registry needs. Top it up from a funded testnet account, or lower MIN_REGISTRY_BALANCE_NEAR."
  if [ "$code_hash" != "$NO_CODE_HASH" ]; then
    [ "$FORCE_REDEPLOY" = 1 ] \
      || die "$REGISTRY already holds a contract (code hash $code_hash) and a second \`new\` would fail. Set FORCE_REDEPLOY=1 to deploy the code over it WITHOUT \`new\` (keeps the state), or use a fresh account."
    say "FORCE_REDEPLOY=1: $REGISTRY holds a contract; deploying the code only, without \`new\` (state is kept)."
    init_args=(without-init-call)
  fi
fi

# -- 1. build ----------------------------------------------------------------------------------
if [ -z "${NEARGATE_REGISTRY_WASM:-}" ]; then
  say ""
  say "== build (contracts/registry)"
  (cd "$ROOT/contracts/registry" && run cargo near build non-reproducible-wasm)
fi
if [ "$DRY_RUN" != 1 ]; then
  [ -f "$WASM" ] || die "wasm not found at $WASM (the build writes it there; or set NEARGATE_REGISTRY_WASM)"
  say "wasm: $(wc -c < "$WASM" | tr -d ' ') bytes, sha256 $(sha256_of "$WASM")"
fi

# -- 2. deploy ---------------------------------------------------------------------------------
say ""
say "== deploy"
run near contract deploy "$REGISTRY" use-file "$WASM" "${init_args[@]}" \
  network-config "$NETWORK" sign-with-legacy-keychain send

# -- 3. check ----------------------------------------------------------------------------------
say ""
say "== services_count (expect 0 on a fresh deploy)"
run near contract call-function as-read-only "$REGISTRY" services_count json-args '{}' \
  network-config "$NETWORK" now

say ""
say "registry: https://testnet.nearblocks.io/address/$REGISTRY"
say "Next: set REGISTRY_CONTRACT_ID=$REGISTRY in .env (npm run near:seed and npm run smoke:live read it)."
