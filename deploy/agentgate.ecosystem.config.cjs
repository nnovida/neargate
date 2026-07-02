// PM2 process definitions for the AgentGate public deploy (matches this box's
// existing PM2 setup). Usage:
//
//   pm2 start deploy/agentgate.ecosystem.config.cjs        # both apps
//   pm2 start deploy/agentgate.ecosystem.config.cjs --only agentgate-gateway
//   pm2 save                                               # persist across reboot
//   pm2 logs agentgate-gateway
//
// gateway  → live 402 middleware on :4021 (reads root .env via scripts/live.ts)
// dashboard → next start on :3000 (reads dashboard/.env.local)
const REPO = '~/projects/Dorahacks/casper';
const NODE_BIN = '~/.nvm/versions/node/v22.10.0/bin';

module.exports = {
  apps: [
    {
      name: 'agentgate-gateway',
      cwd: REPO,
      script: 'npm',
      args: 'run dev:live',
      interpreter: 'none',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PATH: `${NODE_BIN}:${process.env.PATH || ''}`,
        // Persist issued invoices across restarts (FileInvoiceStore, F2) —
        // a buyer who paid on-chain is not lost if the gateway bounces.
        INVOICE_STORE_PATH: `${REPO}/data/gateway-invoices.json`,
      },
    },
    {
      name: 'agentgate-dashboard',
      cwd: `${REPO}/dashboard`,
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      autorestart: true,
      env: { NODE_ENV: 'production', PATH: `${NODE_BIN}:${process.env.PATH || ''}` },
    },
  ],
};
