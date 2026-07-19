import { describe, expect, it } from 'vitest';
import { median, pairRuns } from './runs.js';

describe('pairRuns', () => {
  it('pairs simple on/off sequences', () => {
    const runs = pairRuns([
      { ts: 100, type: 'on' },
      { ts: 400, type: 'off' },
      { ts: 1000, type: 'on' },
      { ts: 1900, type: 'off' },
    ]);
    expect(runs).toEqual([
      { onTs: 100, offTs: 400, durationS: 300 },
      { onTs: 1000, offTs: 1900, durationS: 900 },
    ]);
  });

  it('handles unsorted input', () => {
    const runs = pairRuns([
      { ts: 1900, type: 'off' },
      { ts: 100, type: 'on' },
      { ts: 400, type: 'off' },
      { ts: 1000, type: 'on' },
    ]);
    expect(runs).toHaveLength(2);
  });

  it('drops unmatched off and keeps latest of consecutive ons', () => {
    const runs = pairRuns([
      { ts: 50, type: 'off' }, // unmatched
      { ts: 100, type: 'on' },
      { ts: 200, type: 'on' }, // restart — latest wins
      { ts: 500, type: 'off' },
    ]);
    expect(runs).toEqual([{ onTs: 200, offTs: 500, durationS: 300 }]);
  });

  it('drops blips shorter than minDurationS', () => {
    const runs = pairRuns(
      [
        { ts: 100, type: 'on' },
        { ts: 130, type: 'off' },
      ],
      60,
    );
    expect(runs).toEqual([]);
  });
});

describe('median', () => {
  it('handles odd, even, and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
