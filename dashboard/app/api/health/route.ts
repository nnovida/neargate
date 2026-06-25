import { NextResponse } from 'next/server';

// Liveness probe for the dashboard process itself. Deliberately does NOT touch
// the chain (that is the gateway's /readyz job) so it stays a pure, fast signal
// for a load balancer that the Next server is up.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' });
}
