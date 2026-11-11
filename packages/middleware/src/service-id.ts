const SERVICE_ID_RE = /^\d{1,15}$/;

/** The numeric on-chain service id in a `:id` route segment, or null when it is not one. */
export function parseServiceId(raw: string | undefined): number | null {
  if (raw === undefined || !SERVICE_ID_RE.test(raw)) return null;
  return Number(raw);
}
