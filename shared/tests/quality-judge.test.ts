import { describe, it, expect } from 'vitest';
import { scoreBand, DEFAULT_QUALITY_RUBRIC } from '../src/quality-judge.js';

describe('quality-judge', () => {
  it('maps scores to UI bands using rubric thresholds', () => {
    expect(scoreBand(null, DEFAULT_QUALITY_RUBRIC)).toBe('none');
    expect(scoreBand(20, DEFAULT_QUALITY_RUBRIC)).toBe('red');
    expect(scoreBand(50, DEFAULT_QUALITY_RUBRIC)).toBe('amber');
    expect(scoreBand(90, DEFAULT_QUALITY_RUBRIC)).toBe('green');
  });
});
