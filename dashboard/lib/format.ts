/** Display-only formatting helpers (money formatting itself lives in @agentgate/shared). */

export function truncateHash(hash: string, lead = 10, tail = 8): string {
  if (hash.length <= lead + tail + 1) return hash;
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

export function truncateMiddle(value: string, lead = 18, tail = 8): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function timeAgo(tsMs: number, nowMs = Date.now()): string {
  const delta = Math.max(0, nowMs - tsMs);
  const s = Math.floor(delta / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function formatDateTime(tsMs: number): string {
  return new Date(tsMs).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function svcLabel(id: number): string {
  return `SVC-${String(id).padStart(3, '0')}`;
}
