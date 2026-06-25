/** @type {import('next').NextConfig} */

// Pragmatic CSP for a read-only, server-rendered dashboard with no
// user-generated HTML (React auto-escapes; there is no dangerouslySetInnerHTML).
// Scripts/styles allow 'unsafe-inline' because the Next App Router injects inline
// hydration bootstrap and next/font inlines its CSS; a nonce-based policy would
// need custom middleware. This still blocks external script/object sources and
// framing. Fonts are self-hosted by next/font, so font-src 'self' suffices.
// React's DEV mode uses eval() for debugging (it never does in production), so
// allow 'unsafe-eval' only in development — the production CSP stays strict.
const isDev = process.env.NODE_ENV !== 'production';
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const csp = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig = {
  transpilePackages: ['@agentgate/shared', '@agentgate/chain'],
  // Don't advertise the framework/version.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
