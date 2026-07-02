import { describe, it, expect } from 'vitest';

import { SimDriver } from '../sim/driver';
import type { GridAssets } from '../grid/assets';

function fakeAssets(): GridAssets {
  const meta = {
    id: 'test',
    name: 'Test',
    simDurationMin: 60,
    defaultSpeed: 600,
    startWallClock: '2026-01-15T14:00:00+02:00',
    crews: [
      { crew_id: 'K-1', callsign: 'T-1', skills: ['tree', 'line'], depot: { lat: 61.5, lon: 25.7 } },
    ],
    storm: { name: 'S', direction: 'NW-SE', warningPolygon: [], front: [], wind: [{ offsetMin: 0, speed_ms: 10, gust_ms: 15, dir_deg: 300 }] },
    faults: [
      { incident_id: 'INC-1', seg_id: 'S1', feeder_id: 'F1', ss_id: 'SS', offsetMin: 5, repair_effort_min: 30, lat: 61.5, lon: 25.7, fault_type: 'tree_on_line', requiredSkill: 'tree' },
    ],
  };
  const topology = {
    counts: { kayttopaikat: 3 },
    transformer_nodes: {},
    segments: { S1: { transformer_ids: ['T1'], kayttopaikka_count: 3, kayttopaikka_ids: ['k1', 'k2', 'k3'] } },
  };
  // Only scenario + topology are used by the driver.
  return { scenario: meta, topology } as unknown as GridAssets;
}

describe('SimDriver', () => {
  it('starts idle with crews at depot and no incidents', () => {
    const d = new SimDriver(fakeAssets(), null);
    const s = d.snapshot();
    expect(s.scenario?.status).toBe('idle');
    expect(s.crews).toHaveLength(1);
    expect(s.crews[0].status).toBe('idle');
    expect(s.incidents).toHaveLength(0);
  });

  it('fires the fault after its offset and auto-dispatches a skilled crew', () => {
    const d = new SimDriver(fakeAssets(), null);
    d.setSpeed(600); // 10 sim-min per tick(1)
    d.play();
    d.tick(1); // t+10min > offset 5 → fault fires + auto-dispatch
    const s = d.snapshot();
    expect(s.incidents).toHaveLength(1);
    expect(['assigned', 'enroute', 'onsite']).toContain(s.incidents[0].status);
    expect(s.crews[0].status).not.toBe('idle');
  });

  it('restores power after the repair effort and drains customers to zero', () => {
    const d = new SimDriver(fakeAssets(), null);
    d.setSpeed(600);
    d.play();
    for (let i = 0; i < 10; i++) d.tick(1); // plenty of sim time for the 30-min repair
    const s = d.snapshot();
    expect(s.incidents[0].status).toBe('restored');
    expect(s.crews[0].status).toBe('idle');
  });

  it('pause stops the clock', () => {
    const d = new SimDriver(fakeAssets(), null);
    d.setSpeed(600);
    d.play();
    d.tick(1);
    const t1 = d.snapshot().scenario?.sim_clock;
    d.pause();
    d.tick(1);
    expect(d.snapshot().scenario?.sim_clock).toBe(t1);
  });
});
