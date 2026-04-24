export function ok(data: unknown): never {
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  process.exit(0);
}

export function fail(message: string, details?: unknown): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message, details }) + '\n');
  process.exit(1);
}
