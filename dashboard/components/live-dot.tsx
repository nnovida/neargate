/** Pulsing LIVE indicator; turns into a static STALLED marker when polling fails. */
export function LiveDot({ stalled = false }: { stalled?: boolean }) {
  if (stalled) {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-warn">
        <span aria-hidden className="h-2 w-2 rounded-full bg-warn" />
        stalled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
      <span aria-hidden className="h-2 w-2 rounded-full bg-accent animate-pulse-dot" />
      live
    </span>
  );
}
