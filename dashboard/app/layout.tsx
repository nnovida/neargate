import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { SITE_URL } from '@/lib/seo';
import './globals.css';

// Bundled variable fonts (SIL OFL 1.1, licenses beside them in ./fonts), so `next build` needs no
// network access. Subset to Latin, punctuation, arrows and box drawing.
const display = localFont({
  src: './fonts/SpaceGrotesk-Variable.woff2',
  weight: '300 700',
  display: 'swap',
  variable: '--font-display',
});
const body = localFont({
  src: './fonts/Inter-Variable.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-body',
});
const mono = localFont({
  src: './fonts/JetBrainsMono-Variable.woff2',
  weight: '100 800',
  display: 'swap',
  variable: '--font-mono',
  adjustFontFallback: false,
});

const SITE_TAGLINE = 'NearGate — Stripe for AI agents on NEAR';
const SITE_DESCRIPTION =
  'Wrap any API into a paid x402 service in one command — machine-to-machine NEAR micropayments with on-chain discovery and reputation on NEAR.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: 'NearGate',
  title: {
    default: SITE_TAGLINE,
    template: '%s — NearGate',
  },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'NearGate',
    url: '/',
    title: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: '#0A0E14',
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'NearGate',
      description: 'HTTP 402 payments for AI agents on NEAR.',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'NearGate',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      url: SITE_URL,
      description:
        'Wrap any HTTP API into a paid x402 service with on-chain discovery and reputation on NEAR.',
    },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col bg-ink font-sans text-zinc-200 antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <a
          href="#main"
          className="sr-only left-4 top-4 z-[100] border border-accent bg-panel px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] text-white focus:not-sr-only focus:fixed"
        >
          Skip to content
        </a>
        <Nav />
        <main id="main" className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
