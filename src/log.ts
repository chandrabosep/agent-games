/** One JSON line per event on stdout. Callers must never pass secrets or signature headers. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_SILENT === '1') return;
  process.stdout.write(
    `${JSON.stringify({ t: new Date().toISOString(), event, ...fields }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )}\n`,
  );
}
