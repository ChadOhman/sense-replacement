/**
 * Minimal deterministic k-means for clustering event waveforms, plus the
 * small vector helpers shared by clustering and live matching. Pure math,
 * no dependencies — waveforms are short (~20 samples) and event counts are
 * small (thousands at most), so a simple Lloyd's loop is plenty.
 */

export function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** 2-point moving average: kills sub-sample jitter from transients landing
 *  mid-second, without reshaping the waveform. Length shrinks by one. */
export function smooth2(waveform: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < waveform.length - 1; i++) out.push((waveform[i]! + waveform[i + 1]!) / 2);
  return out;
}

/** Per-index median across member waveforms — robust to outlier members. */
export function medianWaveform(members: number[][]): number[] {
  const len = members[0]?.length ?? 0;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const vals = members.map((m) => m[i]!).sort((a, b) => a - b);
    const mid = vals.length >> 1;
    out.push(vals.length % 2 === 1 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2);
  }
  return out;
}

/** mulberry32 — tiny seeded PRNG so clustering is reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KmeansResult {
  /** assignments[i] = cluster index of points[i]. */
  assignments: number[];
  centroids: number[][];
}

const MAX_ITER = 50;

/** Standard k-means with k-means++ seeding and a seeded PRNG. */
export function kmeans(points: number[][], k: number, seed: number): KmeansResult {
  if (points.length === 0 || k < 1) return { assignments: [], centroids: [] };
  const rand = prng(seed);
  const kk = Math.min(k, points.length);

  const pick = (idx: number): number[] => points[idx]!.slice();

  // k-means++ init: first centroid uniform, then weighted by squared distance.
  const centroids: number[][] = [pick(Math.floor(rand() * points.length))];
  while (centroids.length < kk) {
    const d2 = points.map((p) => {
      let best = Infinity;
      for (const c of centroids) best = Math.min(best, euclidean(p, c) ** 2);
      return best;
    });
    const total = d2.reduce((a, b) => a + b, 0);
    if (total === 0) {
      // All remaining points coincide with a centroid; duplicates are fine.
      centroids.push(pick(Math.floor(rand() * points.length)));
      continue;
    }
    let r = rand() * total;
    let idx = 0;
    while (idx < points.length - 1 && (r -= d2[idx]!) > 0) idx++;
    centroids.push(pick(idx));
  }

  const assignments = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = euclidean(points[i]!, centroids[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    if (!changed && iter > 0) break;

    for (let c = 0; c < centroids.length; c++) {
      const members = points.filter((_, i) => assignments[i] === c);
      if (members.length === 0) {
        // Empty cluster: reseat on the point farthest from its centroid.
        let farIdx = 0;
        let farD = -1;
        for (let i = 0; i < points.length; i++) {
          const d = euclidean(points[i]!, centroids[assignments[i]!]!);
          if (d > farD) {
            farD = d;
            farIdx = i;
          }
        }
        centroids[c] = pick(farIdx);
        assignments[farIdx] = c;
        continue;
      }
      const dim = members[0]!.length;
      const mean = new Array<number>(dim).fill(0);
      for (const m of members) for (let i = 0; i < dim; i++) mean[i] = mean[i]! + m[i]!;
      for (let i = 0; i < dim; i++) mean[i] = mean[i]! / members.length;
      centroids[c] = mean;
    }
  }
  return { assignments, centroids };
}

const MAX_K = 40;

/**
 * Pick the cluster count by binary search: the largest k whose cluster
 * median profiles all stay at least `splitDistance` apart — i.e. keep
 * splitting until clusters start looking like the same appliance. Returns
 * the winning clustering's assignments.
 */
export function chooseK(points: number[][], splitDistance: number, seed: number): KmeansResult {
  if (points.length === 0) return { assignments: [], centroids: [] };
  const upper = Math.min(MAX_K, points.length);

  const distinct = (result: KmeansResult): boolean => {
    const groups = new Map<number, number[][]>();
    result.assignments.forEach((c, i) => {
      const g = groups.get(c);
      if (g) g.push(points[i]!);
      else groups.set(c, [points[i]!]);
    });
    const medians = [...groups.values()].map((members) => medianWaveform(members));
    for (let i = 0; i < medians.length; i++) {
      for (let j = i + 1; j < medians.length; j++) {
        if (euclidean(medians[i]!, medians[j]!) < splitDistance) return false;
      }
    }
    return true;
  };

  let lo = 1; // k=1 is trivially distinct
  let hi = upper;
  let best = kmeans(points, 1, seed);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2); // upper-bound search: mid > lo always
    const result = kmeans(points, mid, seed);
    if (distinct(result)) {
      lo = mid;
      best = result;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
