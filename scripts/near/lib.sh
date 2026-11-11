#!/usr/bin/env bash
# scripts/near/lib.sh — helpers shared by bootstrap-testnet.sh and deploy-registry.sh.
# Sourced by them, never run on its own. The sourcing script sets, before calling anything here:
#
#   SCRIPT_NAME  the prefix of its error messages
#   DRY_RUN      1 = run() prints the command instead of executing it
#   RPC_URL      the JSON-RPC endpoint of the read-only checks
#
# and has already done `set -euo pipefail`.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'lib.sh is sourced by the other scripts in this directory; it is not run on its own.\n' >&2
  exit 1
fi

say() { printf '%s\n' "$*"; }
die() { printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

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

# rpc_query PARAMS_JSON: one read-only JSON-RPC `query`; prints the reply. Fails (curl's status)
# when the RPC cannot be reached, so call it as `reply=$(rpc_query …) || die …`.
rpc_query() {
  curl -fsS --max-time 20 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"neargate\",\"method\":\"query\",\"params\":$1}" \
    "$RPC_URL"
}

# view_account ID: a read-only JSON-RPC view_account. Sets ACCOUNT_STATE to the reply for an
# account that exists, or to "missing" for one that does not. Dies when the RPC cannot be reached
# or answers something else.
ACCOUNT_STATE=
view_account() {
  local id=$1 reply
  reply=$(rpc_query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$id\"}") \
    || die "could not reach $RPC_URL to check $id"
  case $reply in
    *'"code_hash"'*) ACCOUNT_STATE=$reply ;;
    *UNKNOWN_ACCOUNT* | *'does not exist'*) ACCOUNT_STATE=missing ;;
    *) die "unexpected answer from $RPC_URL for $id: ${reply:0:200}" ;;
  esac
}

# account_exists ID: 0 = exists, 1 = does not.
account_exists() {
  view_account "$1"
  [ "$ACCOUNT_STATE" != missing ]
}
