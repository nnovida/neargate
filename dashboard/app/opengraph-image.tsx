import { ImageResponse } from 'next/og';

export const alt = 'AgentGate — Stripe for AI agents on Casper';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Site-wide social card. Pages without their own opengraph-image inherit this one.
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: '#0A0E14',
          padding: '80px',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 40,
            letterSpacing: 8,
            fontWeight: 700,
            color: '#ff3b30',
          }}
        >
          AGENTGATE
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 78, fontWeight: 800, lineHeight: 1.05 }}>
            Stripe for AI agents on Casper
          </div>
          <div style={{ display: 'flex', fontSize: 34, color: '#8B93A5', marginTop: 28, maxWidth: 940 }}>
            Wrap any API into a paid x402 service in one command — per-call CSPR micropayments with
            on-chain discovery and reputation.
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 27, color: '#8B93A5', fontFamily: 'monospace' }}>
          register → 402 → pay → serve → attest → score
        </div>
      </div>
    ),
    { ...size },
  );
}
