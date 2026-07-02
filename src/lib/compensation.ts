import type { CompensationTier, Incident } from './types';

/**
 * Projected standard-compensation (vakiokorvaus) risk in €.
 *
 * Finnish standard compensation (Sähkömarkkinalaki 588/2013 §100) pays each
 * affected customer a percentage of their annual distribution-network fee based
 * on continuous outage duration. We project the € owed *if nothing restores*:
 * for each active incident, take its outage hours (elapsed so far), find the
 * highest reached tier, and multiply by affected käyttöpaikat × annual fee.
 *
 * Source: https://finlex.fi/fi/laki/ajantasa/2013/20130588 (§100).
 */
export function tierPctForHours(tiers: CompensationTier[], hours: number, capPct: number): number {
  let pct = 0;
  for (const t of tiers) {
    if (hours >= t.hours) pct = t.pct;
  }
  return Math.min(pct, capPct);
}

export function projectedCompensationEur(
  incidents: Incident[],
  simNowIso: string,
  annualFeeEur: number,
  tiers: CompensationTier[],
  capPct: number
): number {
  const now = new Date(simNowIso).getTime();
  const firstTierHours = tiers[0]?.hours ?? 12;
  let total = 0;
  for (const inc of incidents) {
    if (inc.status === 'restored' || !inc.started_at) continue;
    const hours = Math.max(0, (now - new Date(inc.started_at).getTime()) / 3_600_000);
    // "Risk if nothing restores": project each active outage to at least the
    // first compensation threshold, escalating as the real outage grows past
    // later tiers.
    const pct = tierPctForHours(tiers, Math.max(hours, firstTierHours), capPct);
    total += inc.affected_kp * annualFeeEur * (pct / 100);
  }
  return Math.round(total);
}
