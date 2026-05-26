export function normName(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}

export function formatNum(n: number, d = 4): string {
  return n.toFixed(d).replace(".", ",");
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export type Ranked<T> = T & { rank: number; idx: number };

export function rankRows<T extends { total: number }>(rows: T[]): Ranked<T>[] {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const out: Ranked<T>[] = [];
  let curRank = 1;
  let prevTotal = Number.POSITIVE_INFINITY;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].total < prevTotal) {
      curRank = i + 1;
      prevTotal = sorted[i].total;
    }
    out.push({ ...sorted[i], rank: curRank, idx: i });
  }
  return out;
}

export type ProbabilityResult = {
  p150: number;
  p343: number;
  examNeeded: { optimistic: number; median: number; pessimistic: number };
  empirical: number | null;
};

/** Seeded PRNG for reproducible Monte Carlo in the UI. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function estimateProbability(
  baremo2026: number,
  examScores2024: number[],
  allBaremo2026: number[],
  plazas150: number,
  plazas343: number,
  cutoffFinal2024: number,
  empiricalRate: number | null,
  trials = 4000,
): ProbabilityResult {
  const sortedExams = [...examScores2024].sort((a, b) => a - b);
  const rng = mulberry32(Math.round(baremo2026 * 10000));

  function simulate(plazas: number): number {
    let wins = 0;
    for (let t = 0; t < trials; t++) {
      const myExam = examScores2024[Math.floor(rng() * examScores2024.length)];
      const myFinal = baremo2026 + myExam;

      const finals = new Array(allBaremo2026.length);
      for (let i = 0; i < allBaremo2026.length; i++) {
        finals[i] = allBaremo2026[i] + examScores2024[Math.floor(rng() * examScores2024.length)];
      }
      finals.sort((a, b) => b - a);
      const cutoff = finals[Math.min(plazas - 1, finals.length - 1)];
      if (myFinal >= cutoff) wins++;
    }
    return wins / trials;
  }

  const examNeeded = {
    optimistic: Math.max(0, cutoffFinal2024 - baremo2026 - percentile(sortedExams, 0.75)),
    median: Math.max(0, cutoffFinal2024 - baremo2026 - percentile(sortedExams, 0.5)),
    pessimistic: Math.max(0, cutoffFinal2024 - baremo2026 - percentile(sortedExams, 0.25)),
  };

  return {
    p150: simulate(plazas150),
    p343: simulate(plazas343),
    examNeeded,
    empirical: empiricalRate,
  };
}

export function empiricalPlazaRate(
  baremo2026: number,
  repeaters: { baremo2026: number; gotPlaza2024: boolean }[],
  band = 0.5,
): number | null {
  const nearby = repeaters.filter((r) => Math.abs(r.baremo2026 - baremo2026) <= band);
  const pool = nearby.length >= 10 ? nearby : repeaters.filter((r) => r.baremo2026 <= baremo2026 + band);
  if (pool.length < 5) return null;
  return pool.filter((r) => r.gotPlaza2024).length / pool.length;
}
