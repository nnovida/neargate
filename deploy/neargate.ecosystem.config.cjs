// PM2 process definitions for the NearGate public deploy. Usage, from the repo root:
//
//   npm run build                                          # the dashboard bundle (next build)
//   pm2 start deploy/neargate.ecosystem.config.cjs         # both apps
//   pm2 start deploy/neargate.ecosystem.config.cjs --only neargate-gateway
//   pm2 save                                               # persist across reboot
//   pm2 logs neargate-gateway
//
// neargate-gateway   -> the live x402 gateway on :3012 (npm run dev:live; scripts/live.ts loads
//                       the root .env itself)
// neargate-dashboard -> next start on :3011 (read-only: it needs no key and no admin token)
//
// Run `pm2 start` from a shell whose `node -v` meets the "engines" range in package.json: pm2 puts
// the directory of the node that evaluates this file first on the apps' PATH.
//
// Environment. pm2 does not read .env. The gateway loads the root .env on its own. The dashboard
// is `next start` in dashboard/, where Next would look for dashboard/.env* instead, so this file
// copies the dashboard's four chain settings from the root .env into its env block. Only those four:
// the admin token, account ids and keys in the same file never reach the dashboard process. A value
// already exported in the shell wins over the file, as it does for the gateway.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const NODE_BIN = path.dirname(process.execPath);
const PATH = `${NODE_BIN}${path.delimiter}${process.env.PATH || ''}`;

// What the dashboard's server code reads (dashboard/lib/server/chain.ts -> loadConfig).
const DASHBOARD_CHAIN_SETTINGS = ['NEAR_NETWORK', 'NEAR_RPC_URL', 'NEAR_EXPLORER_URL', 'REGISTRY_CONTRACT_ID'];

/** `KEY=VALUE` lines of the repo's root .env, quotes stripped, as the repo's own .env loader reads them. */
function readRootDotenv() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const value = match[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    values[match[1]] = quoted === null ? value : quoted[2];
  }
  return values;
}

const dotenv = readRootDotenv();
const dashboardChainEnv = {};
for (const key of DASHBOARD_CHAIN_SETTINGS) {
  const fromFile = dotenv[key];
  if (process.env[key] === undefined && fromFile !== undefined && fromFile !== '') {
    dashboardChainEnv[key] = fromFile;
  }
}

module.exports = {
  apps: [
    {
      name: 'neargate-gateway',
      cwd: REPO,
      script: 'npm',
      args: 'run dev:live',
      interpreter: 'none',
      autorestart: true,
      // Exactly ONE gateway instance. Receipts and rate limits live in this process's memory, so a
      // second instance (or pm2 cluster mode) would split them: a buyer's receipt lookup could land
      // on a process that never saw the call.
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PATH,
        // The public deploy always runs against NEAR, whatever the .env copied from .env.example says.
        AGENTGATE_MODE: 'live',
        MIDDLEWARE_PORT: '3012',
        // One reverse-proxy hop (cloudflared, or any proxy) sits in front: trust its X-Forwarded-For.
        TRUST_PROXY: '1',
        // Persist issued invoices across restarts (a buyer who paid on-chain is not lost if the
        // gateway bounces).
        INVOICE_STORE_PATH: path.join(REPO, 'data', 'gateway-invoices.json'),
        // Persist pending attestations across restarts: a served and paid call whose attestation did
        // not confirm before a bounce is replayed on boot, so the trust ledger is never under-counted.
        ATTESTATION_QUEUE_PATH: path.join(REPO, 'data', 'gateway-attestations.json'),
      },
    },
    {
      name: 'neargate-dashboard',
      cwd: path.join(REPO, 'dashboard'),
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      autorestart: true,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PATH,
        PORT: '3011',
        AGENTGATE_MODE: 'live',
        ...dashboardChainEnv,
      },
    },
  ],
};
