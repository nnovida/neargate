import type { TrustTier } from '@agentgate/shared';

const TIERS: Record<TrustTier, { label: string; cls: string; dot: string }> = {
  new: {
    label: 'NEW',
    cls: 'border-line text-mut',
    dot: 'bg-mut',
  },
  reliable: {
    label: 'RELIABLE',
    cls: 'border-warn/50 text-warn',
    dot: 'bg-warn',
  },
  trusted: {
    label: 'TRUSTED',
    cls: 'border-ok/50 text-ok',
    dot: 'bg-ok',
  },
};

/** Shared trust badge — tier comes from shared trustTier(score). */
export function TrustBadge({ tier, className = '' }: { tier: TrustTier; className?: string }) {
  const t = TIERS[tier];
  return (
    <span
      title={`Trust tier: ${t.label.toLowerCase()}`}
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] ${t.cls} ${className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {t.label}
    </span>
  );
}
