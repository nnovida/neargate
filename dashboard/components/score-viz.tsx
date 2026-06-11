import type { ServiceScore } from '@agentgate/shared';
import { formatInt } from '@/lib/format';

/**
 * Pure-CSS score visualization: conic-gradient donut for success ratio
 * plus a horizontal split bar (success vs failed). No chart library.
 * (Float math here is for pixels/percentages only — never money.)
 */
export function ScoreViz({ score }: { score: ServiceScore }) {
  const { totalCalls, successCalls } = score;
  const failed = Math.max(0, totalCalls - successCalls);
  const pct = totalCalls > 0 ? (successCalls / totalCalls) * 100 : 0;
  const pctLabel = totalCalls > 0 ? `${Math.round(pct)}%` : '—';

  return (
    <div className="flex items-center gap-6">
      <div
        role="img"
        aria-label={
          totalCalls > 0
            ? `Success ratio ${Math.round(pct)} percent (${successCalls} of ${totalCalls} calls)`
            : 'No calls yet'
        }
        className="relative h-28 w-28 shrink-0 rounded-full"
        style={{
          background:
            totalCalls > 0
              ? `conic-gradient(#FF3B30 ${pct}%, rgba(255,255,255,0.08) ${pct}% 100%)`
              : 'conic-gradient(rgba(255,255,255,0.08) 0 100%)',
        }}
      >
        <div className="absolute inset-[9px] flex flex-col items-center justify-center rounded-full bg-panel">
          <span className="font-display text-2xl font-semibold text-white">{pctLabel}</span>
          <span className="microlabel mt-0.5">success</span>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <div className="flex justify-between font-mono text-xs text-mut">
            <span>
              <span className="text-white">{formatInt(successCalls)}</span> ok
            </span>
            <span>
              <span className="text-white">{formatInt(failed)}</span> failed
            </span>
          </div>
          <div className="mt-2 flex h-1.5 w-full overflow-hidden bg-white/5">
            {totalCalls > 0 ? (
              <>
                <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                <div className="h-full bg-white/15" style={{ width: `${100 - pct}%` }} />
              </>
            ) : null}
          </div>
        </div>
        <p className="font-mono text-xs text-mut">
          <span className="text-white">{formatInt(totalCalls)}</span> total attested calls
        </p>
      </div>
    </div>
  );
}
