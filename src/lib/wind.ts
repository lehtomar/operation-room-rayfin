import type { ScenarioMeta, Wind } from './types';

/** Interpolate the scenario's synthetic storm wind at a given elapsed minute. */
export function windAt(meta: ScenarioMeta, elapsedMin: number): Wind {
  const pts = meta.storm.wind;
  let prev = pts[0];
  for (const p of pts) {
    if (p.offsetMin <= elapsedMin) {
      prev = p;
    } else {
      const span = p.offsetMin - prev.offsetMin || 1;
      const f = (elapsedMin - prev.offsetMin) / span;
      return {
        speed_ms: round1(prev.speed_ms + (p.speed_ms - prev.speed_ms) * f),
        gust_ms: round1(prev.gust_ms + (p.gust_ms - prev.gust_ms) * f),
        dir_deg: Math.round(prev.dir_deg + (p.dir_deg - prev.dir_deg) * f),
      };
    }
  }
  return { speed_ms: prev.speed_ms, gust_ms: prev.gust_ms, dir_deg: prev.dir_deg };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const DIRS = ['P', 'PK', 'K', 'KA', 'E', 'LO', 'L', 'LU']; // FI compass (8-pt)
export function windArrow(dirDeg: number): string {
  return DIRS[Math.round(dirDeg / 45) % 8];
}
