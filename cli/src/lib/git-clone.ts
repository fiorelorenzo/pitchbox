import { spawn } from 'node:child_process';
import { assertSafeGitCloneUrl } from '@pitchbox/shared/project-extraction';

export async function shallowClone(url: string, dest: string, timeoutMs = 60_000): Promise<void> {
  if (!url || !url.trim()) throw new Error('git URL is empty');
  assertSafeGitCloneUrl(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth=1', url, dest], { stdio: 'pipe' });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git clone timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (b) => (stderr += String(b)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}
