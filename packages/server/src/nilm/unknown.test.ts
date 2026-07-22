import { describe, expect, it } from 'vitest';
import { computeUnknown, findForceOff } from './unknown.js';

describe('computeUnknown', () => {
  it('is the residual after baseline and known devices', () => {
    const unknown = computeUnknown(3000, 200, [
      { id: 1, estW: 1500 },
      { id: 2, estW: 800 },
    ]);
    expect(unknown).toBe(500);
  });

  it('goes negative when a tracked device actually turned off', () => {
    expect(computeUnknown(500, 200, [{ id: 1, estW: 1500 }])).toBe(-1200);
  });
});

describe('findForceOff', () => {
  it('returns null for a non-negative residual', () => {
    expect(findForceOff(100, [{ id: 1, estW: 1500 }])).toBeNull();
    expect(findForceOff(0, [{ id: 1, estW: 1500 }])).toBeNull();
  });

  it('picks the smallest device covering at least 90% of the deficit', () => {
    const on = [
      { id: 1, estW: 5000 },
      { id: 2, estW: 1300 },
      { id: 3, estW: 400 },
    ];
    // deficit 1200: device 3 (400 W) is too small, device 2 (1300 W) is the
    // smallest that covers >= 1080 W.
    expect(findForceOff(-1200, on)).toBe(2);
  });

  it('returns null when no single device explains the deficit', () => {
    expect(findForceOff(-1200, [{ id: 3, estW: 400 }])).toBeNull();
    expect(findForceOff(-1200, [])).toBeNull();
  });
});
