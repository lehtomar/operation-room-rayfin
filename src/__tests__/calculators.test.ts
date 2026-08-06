import { describe, it, expect } from 'vitest';
import type { FeatureCollection } from 'geojson';

import { haversineKm, etaMinutes } from '../lib/geo';
import { tierPctForHours, projectedCompensationEur } from '../lib/compensation';
import {
  deEnergizedFromIncidents,
  buildSegmentChildren,
  deadSegmentsFromIncidents,
  subtreeSegments,
} from '../lib/topology';
import type { CompensationTier, Incident, Topology } from '../lib/types';
import { faultDispatchStatus } from '../lib/events';

const TIERS: CompensationTier[] = [
  { hours: 12, pct: 10 },
  { hours: 24, pct: 25 },
  { hours: 72, pct: 50 },
  { hours: 120, pct: 100 },
  { hours: 192, pct: 150 },
  { hours: 288, pct: 200 },
];

function inc(partial: Partial<Incident>): Incident {
  return {
    incident_id: 'INC',
    seg_id: 'S1',
    feeder_id: 'F1',
    ss_id: 'SS',
    fault_type: 'tree_on_line',
    status: 'open',
    affected_kp: 0,
    affected_tr: 0,
    repair_effort_min: 60,
    crew_id: null,
    eta_min: null,
    started_at: null,
    restored_at: null,
    ...partial,
  };
}

describe('geo', () => {
  it('haversine is ~0 for identical points and matches a known distance', () => {
    expect(haversineKm(61.5, 25.7, 61.5, 25.7)).toBeCloseTo(0, 5);
    // ~0.1° latitude ≈ 11.1 km
    expect(haversineKm(61.5, 25.7, 61.6, 25.7)).toBeGreaterThan(10.5);
    expect(haversineKm(61.5, 25.7, 61.6, 25.7)).toBeLessThan(11.5);
  });

  it('etaMinutes applies the 1.3 road factor at 60 km/h', () => {
    // 11.1 km × 1.3 = 14.4 km ⇒ ~14.4 min
    const eta = etaMinutes(61.5, 25.7, 61.6, 25.7);
    expect(eta).toBeGreaterThanOrEqual(13);
    expect(eta).toBeLessThanOrEqual(16);
  });
});

describe('compensation', () => {
  it('picks the highest reached tier and caps', () => {
    expect(tierPctForHours(TIERS, 5, 200)).toBe(0);
    expect(tierPctForHours(TIERS, 13, 200)).toBe(10);
    expect(tierPctForHours(TIERS, 25, 200)).toBe(25);
    expect(tierPctForHours(TIERS, 1000, 200)).toBe(200);
  });

  it('projects active outages to at least the first tier ("if nothing restores")', () => {
    const now = '2026-01-15T15:00:00';
    const incidents = [inc({ affected_kp: 100, started_at: '2026-01-15T14:00:00', status: 'open' })];
    // 1 h elapsed → projected to 12 h tier (10%): 100 × 550 × 0.10 = 5500
    expect(projectedCompensationEur(incidents, now, 550, TIERS, 200)).toBe(5500);
  });

  it('ignores restored incidents', () => {
    const now = '2026-01-15T15:00:00';
    const incidents = [inc({ affected_kp: 100, started_at: '2026-01-15T14:00:00', status: 'restored' })];
    expect(projectedCompensationEur(incidents, now, 550, TIERS, 200)).toBe(0);
  });
});

describe('topology', () => {
  const topo: Topology = {
    counts: {},
    transformer_nodes: {},
    segments: {
      S1: { transformer_ids: ['T1'], kayttopaikka_count: 2, kayttopaikka_ids: ['k1', 'k2'] },
      S2: { transformer_ids: ['T2'], kayttopaikka_count: 1, kayttopaikka_ids: ['k3'] },
    },
  };
  const feeders: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { seg_id: 'S1', parent_seg_id: null }, geometry: { type: 'LineString', coordinates: [] } },
      { type: 'Feature', properties: { seg_id: 'S2', parent_seg_id: 'S1' }, geometry: { type: 'LineString', coordinates: [] } },
    ],
  };

  it('unions downstream customers across active incidents (deduping)', () => {
    const de = deEnergizedFromIncidents(topo, [
      inc({ incident_id: 'A', seg_id: 'S1', status: 'open' }),
      inc({ incident_id: 'B', seg_id: 'S1', status: 'open' }), // overlap dedupes
    ]);
    expect(de.customersOut).toBe(2);
    expect([...de.transformers].sort()).toEqual(['T1']);
  });

  describe('fault map dispatch status', () => {
    it('distinguishes unassigned, queued, assigned, and onsite faults', () => {
      expect(faultDispatchStatus(inc({ status: 'open' }))).toBe('unassigned');
      expect(faultDispatchStatus(inc({ status: 'open', reserved_crew_id: 'K-1' }))).toBe('queued');
      expect(faultDispatchStatus(inc({ status: 'enroute', crew_id: 'K-1' }))).toBe('assigned');
      expect(faultDispatchStatus(inc({ status: 'onsite', crew_id: 'K-1' }))).toBe('onsite');
    });
  });

  it('marks the whole downstream segment subtree as de-energized', () => {
    const children = buildSegmentChildren(feeders);
    expect(subtreeSegments(children, 'S1').sort()).toEqual(['S1', 'S2']);
    const dead = deadSegmentsFromIncidents(children, [inc({ seg_id: 'S1', status: 'open' })]);
    expect([...dead].sort()).toEqual(['S1', 'S2']);
  });

  it('excludes restored incidents from the de-energized set', () => {
    const de = deEnergizedFromIncidents(topo, [inc({ seg_id: 'S1', status: 'restored' })]);
    expect(de.customersOut).toBe(0);
  });
});
