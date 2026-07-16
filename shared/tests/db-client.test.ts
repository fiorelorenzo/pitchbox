import { describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db/client.js';

describe('db client pool error handling', () => {
  it('attaches an error listener to the pool so idle-client errors do not crash the process', () => {
    const pool = getPool();
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });

  it('logs and survives a synthetic error event instead of throwing', () => {
    const pool = getPool();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const syntheticError = new Error('synthetic idle-client error');
    expect(() => pool.emit('error', syntheticError)).not.toThrow();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
