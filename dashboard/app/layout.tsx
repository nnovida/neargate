import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { SITE_URL } from '@/lib/seo';
import './globals.css';

const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-display' });
const body = Inter({ subsets: ['latin'], variable: '--font-body' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

const SITE_TAGLINE = 'AgentGate — Stripe for AI agents on Casper';
const SITE_DESCRIPTION =
  'Wrap any API into a paid x402 service in one command — machine-to-machine CSPR micropayments with on-chain discovery and reputation on Casper.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: 'AgentGate',
  title: {
    default: SITE_TAGLINE,
    template: '%s — AgentGate',
  },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'AgentGate',
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
      name: 'AgentGate',
      description: 'HTTP 402 payments for AI agents on Casper.',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'AgentGate',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      url: SITE_URL,
      description:
        'Wrap any HTTP API into a paid x402 service with on-chain discovery and reputation on Casper.',
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
