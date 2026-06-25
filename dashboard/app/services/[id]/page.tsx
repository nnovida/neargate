import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ServiceDetail } from '@/components/service-detail';

interface Props {
  // Next 15+ delivers route params as a Promise.
  params: Promise<{ id: string }>;
}

/** Strict numeric id — anything else is a hard 404 before any data fetching. */
function parseId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  return { title: id === null ? 'Service' : `Service #${id}` };
}

export default async function ServicePage({ params }: Props) {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) notFound();

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <Link
        href="/catalog"
        className="font-mono text-[11px] uppercase tracking-[0.18em] text-mut transition-colors hover:text-accent"
      >
        ← catalog
      </Link>
      <div className="mt-6">
        <ServiceDetail id={id} />
      </div>
    </div>
  );
}
