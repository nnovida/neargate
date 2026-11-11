#!/usr/bin/env bash
# NearGate MCP smoke helper — drive the `neargate mcp` server over stdio and pretty-print.
#
# Only the read tools are driven here, so no key is needed. The CLI defaults to live
# mode on NEAR testnet: point it at the registry with REGISTRY_CONTRACT_ID (and
# NEAR_RPC_URL / NEAR_NETWORK if needed), or use the offline mock stack:
#   npm run dev:seed      # in another shell
#   MCP_CMD="npx tsx packages/cli/src/bin.ts mcp --mode mock" scripts/mcp.sh list
#
#   scripts/mcp.sh tools          # list the MCP tools
#   scripts/mcp.sh list           # on-chain service catalog
#   scripts/mcp.sh service 5      # one service's full detail + trust score
#   scripts/mcp.sh invoice 5      # the HTTP 402 invoice: price + storage fee in NEAR (no payment)
#
# Requirements: Node >= 22.22.2. jq is optional — with it the output is
# pretty-printed and unwrapped; without it you get the raw JSON-RPC frames.
#
# Server command resolution (first match wins):
#   1. $MCP_CMD if set          e.g. MCP_CMD="node packages/cli/dist/bin.js mcp"
#   2. the local build if present (packages/cli/dist/bin.js)
#   3. the CLI source through tsx (npx tsx packages/cli/src/bin.ts mcp)
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_BIN="$REPO_ROOT/packages/cli/dist/bin.js"
SOURCE_BIN="$REPO_ROOT/packages/cli/src/bin.ts"
MCP_WAIT="${MCP_WAIT:-8}"   # seconds to hold stdin open for the async on-chain read

if [ -n "${MCP_CMD:-}" ]; then
  :                                            # explicit override
elif [ -f "$LOCAL_BIN" ]; then
  MCP_CMD="node $LOCAL_BIN mcp"                # local build (fast, exact)
else
  MCP_CMD="$REPO_ROOT/node_modules/.bin/tsx $SOURCE_BIN mcp" # CLI source (needs `npm install`)
fi

usage() {
  cat >&2 <<'EOF'
usage: scripts/mcp.sh <command>
  tools            list the available MCP tools
  list             on-chain service catalog
  service <id>     one service's full detail
  invoice <id>     the HTTP 402 invoice for a service (no payment)

env: MCP_CMD (override server command), MCP_WAIT (stdin hold seconds, default 8)
EOF
  exit 1
}

[ $# -ge 1 ] || usage
cmd="$1"; id="${2:-}"

case "$cmd" in
  tools)
    req='{"jsonrpc":"2.0","id":2,"method":"tools/list"}' ;;
  list)
    req='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"neargate_list_services","arguments":{}}}' ;;
  service)
    [ -n "$id" ] || { echo "error: 'service' needs an <id>" >&2; usage; }
    req="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"neargate_get_service\",\"arguments\":{\"id\":$id}}}" ;;
  invoice)
    [ -n "$id" ] || { echo "error: 'invoice' needs an <id>" >&2; usage; }
    req="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"neargate_get_invoice\",\"arguments\":{\"id\":$id}}}" ;;
  -h|--help) usage ;;
  *) echo "error: unknown command '$cmd'" >&2; usage ;;
esac

if command -v jq >/dev/null 2>&1; then
  render() {
    jq 'select(.id==2)
        | if .error then {error: .error.message}
          elif (.result.isError // false) then {tool_error: .result.content[0].text}
          elif .result.tools then {tools: [.result.tools[].name]}
          else (.result.content[0].text | fromjson) end'
  }
else
  echo "note: jq not found — printing raw JSON-RPC (install jq for pretty output)" >&2
  render() { cat; }
fi

# The MCP stdio transport reads newline-delimited JSON-RPC. Send initialize +
# initialized, then the request; the trailing sleep keeps stdin open long enough
# for the async on-chain read to answer before EOF closes the server.
( printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp.sh","version":"0.0.0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    "$req" ; \
  sleep "$MCP_WAIT" ) \
| $MCP_CMD 2>/dev/null \
| render
