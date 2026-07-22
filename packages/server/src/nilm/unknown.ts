/**
 * Unknown-power accounting: whatever part of the current draw is neither
 * the always-on floor nor a matched-ON NILM device. A persistently negative
 * residual means some device we think is ON actually turned off (its off
 * transient went unrecognized) — the self-correction picks which one to
 * force off.
 */

export interface OnDeviceEst {
  id: number;
  estW: number;
}

export function computeUnknown(totalW: number, baselineW: number, onDevices: OnDeviceEst[]): number {
  let known = 0;
  for (const d of onDevices) known += d.estW;
  return totalW - baselineW - known;
}

/**
 * When the residual is negative, return the id of the ON device to force
 * off: the smallest device whose estimated draw covers at least 90% of the
 * deficit (turning off a bigger device than necessary would overshoot).
 * Null when no single device explains the deficit — better to keep honest
 * negative accounting than guess.
 */
export function findForceOff(residualW: number, onDevices: OnDeviceEst[]): number | null {
  if (residualW >= 0) return null;
  const deficit = -residualW;
  let best: OnDeviceEst | null = null;
  for (const d of onDevices) {
    if (d.estW < 0.9 * deficit) continue;
    if (best === null || d.estW < best.estW) best = d;
  }
  return best?.id ?? null;
}
