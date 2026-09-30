// Parses `sync --since`: either an absolute ISO date/datetime
// ("2026-09-23", "2026-09-23T10:00:00Z") or a relative window back from now
// ("7d", "24h", "30m").
export function parseSince(input: string): Date {
  const relative = input.trim().match(/^(\d+)\s*([dhm])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[relative[2].toLowerCase() as 'd' | 'h' | 'm'];
    return new Date(Date.now() - amount * unitMs);
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --since value "${input}". Use an ISO date (e.g. 2026-09-23) or a relative window (e.g. 7d, 24h, 30m).`);
  }
  if (date.getTime() > Date.now()) {
    throw new Error(`--since value "${input}" is in the future — nothing would sync.`);
  }
  return date;
}

// Shopify Admin API search syntax for the `query:` argument of a
// connection. Returns undefined when --since wasn't given, so
// JSON.stringify drops the variable and the request is byte-identical to
// the pre---since one (no explicit `query: null` sent).
export function sinceQuery(since: Date | undefined): string | undefined {
  return since ? `updated_at:>='${since.toISOString()}'` : undefined;
}
