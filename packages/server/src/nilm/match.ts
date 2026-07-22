/**
 * Live event matching: a freshly captured waveform against the labeled
 * cluster profiles. Only clusters mapped to a device participate — an
 * unlabeled cluster matching tells the user nothing.
 */

import { euclidean, smooth2 } from './kmeans.js';

export interface MatchProfile {
  clusterId: number;
  deviceId: number;
  direction: 'on' | 'off';
  profile: number[];
  radius: number;
  /** Device-level radius override; null = the cluster's own radius. */
  maxMatchDistance: number | null;
}

export interface MatchResult {
  clusterId: number;
  deviceId: number;
  distance: number;
}

export function matchEvent(
  waveform: number[],
  direction: 'on' | 'off',
  profiles: MatchProfile[],
): MatchResult | null {
  const smoothed = smooth2(waveform);
  let best: MatchResult | null = null;
  for (const p of profiles) {
    if (p.direction !== direction) continue;
    const d = euclidean(smoothed, p.profile);
    if (d > (p.maxMatchDistance ?? p.radius)) continue;
    if (best === null || d < best.distance) {
      best = { clusterId: p.clusterId, deviceId: p.deviceId, distance: d };
    }
  }
  return best;
}
