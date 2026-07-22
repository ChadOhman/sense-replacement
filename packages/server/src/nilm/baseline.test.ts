import { describe, expect, it } from 'vitest';
import { RollingMinBaseline } from './baseline.js';

describe('RollingMinBaseline', () => {
  it('is null before any sample and tracks the minimum immediately', () => {
    const b = new RollingMinBaseline();
    expect(b.value()).toBeNull();
    b.sample(0, 800);
    expect(b.value()).toBe(800);
    b.sample(1, 300);
    expect(b.value()).toBe(300);
    b.sample(2, 900);
    expect(b.value()).toBe(300);
  });

  it('forgets minima older than the trailing hour', () => {
    const b = new RollingMinBaseline();
    b.sample(0, 100); // minute 0
    b.sample(30 * 60, 500); // minute 30
    expect(b.value()).toBe(100);
    b.sample(61 * 60, 500); // minute 61: minute-0 bucket evicted
    expect(b.value()).toBe(500);
  });

  it('ignores junk samples', () => {
    const b = new RollingMinBaseline();
    b.sample(0, 400);
    b.sample(1, -5);
    b.sample(2, NaN);
    expect(b.value()).toBe(400);
  });
});
