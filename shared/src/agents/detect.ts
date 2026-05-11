import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from './meta.js';

const exec = promisify(execFile);

export type DetectResult = {
  available: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
  detectedAt: string;
};

const TIMEOUT_MS = 5_000;
const BINARY_BY_SLUG: Partial<Record<AgentRunnerSlug, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  // 'cloud' has no local binary — detection is meaningless. The loader returns
  // a synthetic "unavailable" result so the Settings UI still renders it.
};

async function whichBinary(binary: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await exec(cmd, [binary], { timeout: TIMEOUT_MS });
    const first = stdout.split(/\r?\n/).find((s) => s.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

async function probe(binary: string): Promise<DetectResult> {
  const detectedAt = new Date().toISOString();
  const path = await whichBinary(binary);
  if (!path) {
    return {
      available: false,
      version: null,
      path: null,
      error: `${binary} not found on PATH`,
      detectedAt,
    };
  }
  try {
    const { stdout, stderr } = await exec(binary, ['--version'], { timeout: TIMEOUT_MS });
    const out = (stdout || stderr).trim();
    const version = out.split(/\r?\n/)[0] || null;
    return { available: true, version, path, error: null, detectedAt };
  } catch (err) {
    return {
      available: false,
      version: null,
      path,
      error: err instanceof Error ? err.message : String(err),
      detectedAt,
    };
  }
}

const cache = new Map<AgentRunnerSlug, Promise<DetectResult>>();

export function detectRunner(slug: AgentRunnerSlug): Promise<DetectResult> {
  let pending = cache.get(slug);
  if (!pending) {
    const binary = BINARY_BY_SLUG[slug];
    if (!binary) {
      pending = Promise.resolve({
        available: false,
        version: null,
        path: null,
        error: 'No local binary — managed by the runtime.',
        detectedAt: new Date().toISOString(),
      });
    } else {
      pending = probe(binary);
    }
    cache.set(slug, pending);
  }
  return pending;
}

export async function detectAllRunners(): Promise<Record<AgentRunnerSlug, DetectResult>> {
  const slugs = AGENT_RUNNER_META.map((m) => m.slug);
  const results = await Promise.all(slugs.map((s) => detectRunner(s)));
  const out = {} as Record<AgentRunnerSlug, DetectResult>;
  slugs.forEach((s, i) => {
    out[s] = results[i];
  });
  return out;
}

export function clearDetectionCache(): void {
  cache.clear();
}
