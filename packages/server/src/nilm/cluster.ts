/**
 * One clustering pass over captured NILM events: pure logic, DB rows in /
 * row mutations out. Two phases:
 *
 *  1. Absorb — each unclustered event joins the nearest existing cluster it
 *     fits inside (labeled clusters are frozen: their profiles never move,
 *     so re-clustering can't destroy human labels).
 *  2. Discover — the leftovers are k-means clustered per direction; groups
 *     big enough to be a repeating appliance become new clusters with a
 *     median-waveform profile and a max-member-distance radius.
 */

import { chooseK, euclidean, medianWaveform, smooth2 } from './kmeans.js';

export interface ClusterRow {
  id: number;
  direction: 'on' | 'off';
  profile: number[];
  radius: number;
  size: number;
}

export interface EventRow {
  id: number;
  direction: 'on' | 'off';
  waveform: number[];
}

export interface NewCluster {
  direction: 'on' | 'off';
  profile: number[];
  radius: number;
  size: number;
  eventIds: number[];
}

export interface ClusterPassResult {
  /** Events absorbed into existing clusters. */
  assignments: { eventId: number; clusterId: number }[];
  /** Grown sizes for the clusters that absorbed events. */
  updatedSizes: { clusterId: number; size: number }[];
  newClusters: NewCluster[];
}

/** Below this many similar events a pattern isn't a repeating appliance yet;
 *  the events stay unclustered and wait for more occurrences. */
const MIN_NEW_CLUSTER_SIZE = 3;

/** A brand-new cluster of near-identical events would get radius ~0 and
 *  never match anything live; floor it at a fraction of the split distance. */
const MIN_RADIUS_FRACTION = 0.25;

const KMEANS_SEED = 0x5e75e;

export function clusterPass(
  existing: ClusterRow[],
  events: EventRow[],
  splitDistance: number,
): ClusterPassResult {
  const assignments: { eventId: number; clusterId: number }[] = [];
  const sizeGrowth = new Map<number, number>();
  const leftovers: { event: EventRow; smoothed: number[] }[] = [];

  for (const event of events) {
    const smoothed = smooth2(event.waveform);
    let best: ClusterRow | null = null;
    let bestD = Infinity;
    for (const cluster of existing) {
      if (cluster.direction !== event.direction) continue;
      const d = euclidean(smoothed, cluster.profile);
      if (d <= cluster.radius && d < bestD) {
        bestD = d;
        best = cluster;
      }
    }
    if (best) {
      assignments.push({ eventId: event.id, clusterId: best.id });
      sizeGrowth.set(best.id, (sizeGrowth.get(best.id) ?? 0) + 1);
    } else {
      leftovers.push({ event, smoothed });
    }
  }

  const newClusters: NewCluster[] = [];
  for (const direction of ['on', 'off'] as const) {
    const pool = leftovers.filter((l) => l.event.direction === direction);
    if (pool.length < MIN_NEW_CLUSTER_SIZE) continue;
    const result = chooseK(
      pool.map((l) => l.smoothed),
      splitDistance,
      KMEANS_SEED,
    );
    const groups = new Map<number, typeof pool>();
    result.assignments.forEach((c, i) => {
      const member = pool[i]!;
      const g = groups.get(c);
      if (g) g.push(member);
      else groups.set(c, [member]);
    });
    for (const members of groups.values()) {
      if (members.length < MIN_NEW_CLUSTER_SIZE) continue;
      const profile = medianWaveform(members.map((m) => m.smoothed));
      const maxDist = Math.max(...members.map((m) => euclidean(m.smoothed, profile)));
      newClusters.push({
        direction,
        profile,
        radius: Math.max(maxDist, splitDistance * MIN_RADIUS_FRACTION),
        size: members.length,
        eventIds: members.map((m) => m.event.id),
      });
    }
  }

  return {
    assignments,
    updatedSizes: [...sizeGrowth.entries()].map(([clusterId, grown]) => {
      const cluster = existing.find((c) => c.id === clusterId)!;
      return { clusterId, size: cluster.size + grown };
    }),
    newClusters,
  };
}
