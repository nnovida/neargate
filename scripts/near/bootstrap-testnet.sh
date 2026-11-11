#!/usr/bin/env bash
# scripts/near/bootstrap-testnet.sh — create the four NearGate accounts on NEAR testnet.
#
#   <prefix>-registry.testnet   the registry contract account (npm run near:deploy deploys onto it)
#   <prefix>-seller.testnet     owns and registers services
#   <prefix>-gateway.testnet    signs attestations; registered as each service's attestor
#   <prefix>-buyer.testnet      pays for calls
#
# Each account is created by the near-cli-rs faucet sponsor with a fresh ed25519 key. The key is
# saved in the legacy keychain, ~/.near-credentials/testnet/<account>.json, which is where the
# NearGate tooling looks for it. No key is ever printed, and none leaves your machine.
#
# Idempotent: an account that already exists is skipped (a read-only JSON-RPC view_account).
# Run it again after a partial failure.
#
# Environment:
#   NEARGATE_PREFIX  account prefix (default neargate-<MMDD>, e.g. neargate-1111)
#   NEAR_RPC_URL     RPC used for the existence checks (default https://rpc.testnet.near.org)
#   DRY_RUN=1        print every command instead of running it; nothing is sent, and the
#                    network is not contacted at all (not even the existence check)
set -euo pipefail

PREFIX="${NEARGATE_PREFIX:-neargate-$(date +%m%d)}"
RPC_URL="${NEAR_RPC_URL:-https://rpc.testnet.near.org}"
DRY_RUN="${DRY_RUN:-0}"
NETWORK=testnet
ROLES=(registry seller gateway buyer)

say() { printf '%s\n' "$*"; }
die() { printf 'bootstrap-testnet: %s\n' "$*" >&2; exit 1; }

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

# account_exists ID: read-only JSON-RPC view_account. 0 = exists, 1 = does not; dies when the
# RPC cannot be reached or answers something unexpected.
account_exists() {
  local id=$1 reply
  reply=$(curl -fsS --max-time 20 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"neargate\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$id\"}}" \
    "$RPC_URL") || die "could not reach $RPC_URL to check $id"
  case $reply in
    *'"code_hash"'*) return 0 ;;
    *UNKNOWN_ACCOUNT* | *'does not exist'*) return 1 ;;
    *) die "unexpected answer from $RPC_URL for $id: ${reply:0:200}" ;;
  esac
}

# A new account takes a block or two to show up at the RPC.
wait_for_account() {
  local id=$1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if account_exists "$id"; then return 0; fi
    sleep 2
  done
  die "$id was created but the RPC does not show it yet; run this script again (it skips what exists)"
}

[[ $PREFIX =~ ^[a-z0-9]+([_-][a-z0-9]+)*$ ]] \
  || die "prefix '$PREFIX' is not valid in a NEAR account id (lowercase letters and digits, single - or _ between them)"
[ "${#PREFIX}" -le 46 ] || die "prefix '$PREFIX' is too long (at most 46 characters)"

if [ "$DRY_RUN" = 1 ]; then
  say "bootstrap-testnet: DRY_RUN=1, prefix=$PREFIX, network=$NETWORK. Nothing is sent and the network is not contacted."
else
  command -v near > /dev/null 2>&1 || die "near-cli-rs ('near') not found on PATH"
  command -v curl > /dev/null 2>&1 || die "curl not found on PATH"
  say "bootstrap-testnet: prefix=$PREFIX, network=$NETWORK, rpc=$RPC_URL"
fi

for role in "${ROLES[@]}"; do
  id="$PREFIX-$role.$NETWORK"
  say ""
  say "== $id"
  create=(near account create-account sponsor-by-faucet-service "$id" autogenerate-new-keypair
    --signature-scheme ed25519 save-to-legacy-keychain network-config "$NETWORK" create)
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would check whether $id exists (read-only JSON-RPC view_account at $RPC_URL); if it does not:"
    run "${create[@]}"
  elif account_exists "$id"; then
    say "skip: $id already exists"
  else
    run "${create[@]}"
    wait_for_account "$id"
    say "created: $id (key saved to ~/.near-credentials/$NETWORK/$id.json)"
  fi
done

say ""
say "Accounts and balances:"
for role in "${ROLES[@]}"; do
  id="$PREFIX-$role.$NETWORK"
  say "  $role: $id"
  run near tokens "$id" view-near-balance network-config "$NETWORK" now || say "  (balance not available right now)"
done

say ""
say "Add these to .env (account ids only; the keys stay in ~/.near-credentials/$NETWORK/):"
say "  REGISTRY_CONTRACT_ID=$PREFIX-registry.$NETWORK"
say "  GATEWAY_ACCOUNT_ID=$PREFIX-gateway.$NETWORK"
say "  SELLER_ACCOUNT_ID=$PREFIX-seller.$NETWORK"
say "  BUYER_ACCOUNT_ID=$PREFIX-buyer.$NETWORK"
say "Next: npm run near:deploy   (export NEARGATE_PREFIX=$PREFIX first if you run it on another day)"
