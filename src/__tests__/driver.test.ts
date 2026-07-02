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

  it('queues an incident to the next crew that frees when none are available', () => {
    const a = fakeAssets() as unknown as { scenario: { crews: unknown[]; faults: unknown[] } };
    a.scenario.crews = [
      { crew_id: 'K-1', callsign: 'T-1', skills: ['tree'], depot: { lat: 61.5, lon: 25.7 } },
    ];
    a.scenario.faults = [
      { incident_id: 'INC-1', seg_id: 'S1', feeder_id: 'F1', ss_id: 'SS', offsetMin: 5, repair_effort_min: 10, lat: 61.5, lon: 25.7, fault_type: 'tree_on_line', requiredSkill: 'tree' },
      { incident_id: 'INC-2', seg_id: 'S1', feeder_id: 'F1', ss_id: 'SS', offsetMin: 6, repair_effort_min: 10, lat: 61.5, lon: 25.7, fault_type: 'tree_on_line', requiredSkill: 'tree' },
    ];
    const d = new SimDriver(a as unknown as GridAssets, null);
    d.setAuto(false);
    d.setSpeed(600);
    d.play();
    d.tick(1); // both faults fire
    d.assign('INC-1', 'K-1'); // dispatch the only crew to the first fault
    d.reserveNextFree('INC-2'); // no idle crew → queue for the next free one
    expect(d.snapshot().incidents.find((i) => i.incident_id === 'INC-2')?.reserved_crew_id).toBe('K-1');
    for (let i = 0; i < 8; i++) d.tick(1); // K-1 finishes INC-1 and is auto-given INC-2
    const inc2 = d.snapshot().incidents.find((i) => i.incident_id === 'INC-2')!;
    expect(inc2.status).not.toBe('open');
  });

  it('crews follow the road route polyline, not a straight line', () => {
    // Route detours north (lat 61.6) before reaching the incident at lat 61.5.
    const a = fakeAssets() as unknown as { scenario: { faults: { lat: number; lon: number }[] }; routes: unknown };
    a.scenario.faults[0].lat = 61.5;
    a.scenario.faults[0].lon = 25.9;
    a.routes = {
      'DEPOT-0->INC-1': {
        coords: [
          [25.7, 61.5],
          [25.7, 61.6],
          [25.9, 61.6],
          [25.9, 61.5],
        ],
        km: 32,
      },
    };
    const d = new SimDriver(a as unknown as GridAssets, null);
    d.setSpeed(960); // ~16 km per tick → partway along the detour
    d.play();
    d.tick(1); // fault fires + auto-dispatch + drive ~16 km along the road
    const crew = d.snapshot().crews[0];
    // On the northern leg the crew is well above the straight depot→incident line (lat 61.5).
    expect(crew.status).toBe('enroute');
    expect(parseFloat(crew.lat)).toBeGreaterThan(61.55);
  });

  it('seeds the Live board with maintenance crews and unscheduled incidents', () => {
    const a = fakeAssets() as unknown as {
      scenario: {
        crews: unknown[];
        liveSeed: unknown;
      };
    };
    a.scenario.crews = [
      { crew_id: 'K-1', callsign: 'T-1', skills: ['tree', 'line'], depot: { lat: 61.5, lon: 25.7 } },
      { crew_id: 'K-2', callsign: 'T-2', skills: ['hv', 'line'], depot: { lat: 61.5, lon: 25.7 } },
    ];
    a.scenario.liveSeed = {
      startOffsetMin: 90,
      speed: 12,
      maintenance: [
        {
          job_id: 'MNT-1',
          crew_id: 'K-2',
          title: 'Inspection',
          feeder_id: 'F1',
          ss_id: 'SS',
          seg_id: 'S1',
          requiredSkill: 'hv',
          startOffsetMin: -30,
          durationMin: 120,
          lat: 61.55,
          lon: 25.6,
        },
      ],
      incidents: [
        {
          incident_id: 'LIVE-1',
          seg_id: 'S1',
          feeder_id: 'F1',
          ss_id: 'SS',
          fault_type: 'tree_on_line',
          requiredSkill: 'tree',
          startOffsetMin: -15,
          repair_effort_min: 60,
          lat: 61.53,
          lon: 25.8,
        },
      ],
    };
    const d = new SimDriver(a as unknown as GridAssets, null);
    d.setMode('live');
    const s = d.snapshot();
    // maintenance crew is onsite; the other crew stays available
    expect(s.crews.find((c) => c.crew_id === 'K-2')?.status).toBe('onsite');
    expect(s.crews.find((c) => c.crew_id === 'K-1')?.status).toBe('idle');
    // the unscheduled incident is open with real affected käyttöpaikat
    const live1 = s.incidents.find((i) => i.incident_id === 'LIVE-1')!;
    expect(live1.status).toBe('open');
    expect(live1.affected_kp).toBe(3);
    // maintenance shows as an incident but with zero customer impact
    const mnt = s.incidents.find((i) => i.incident_id === 'MNT-1')!;
    expect(mnt.fault_type).toBe('scheduled_maintenance');
    expect(mnt.affected_kp).toBe(0);
    // the live board is running so dispatched crews move
    expect(s.scenario?.playing).toBe(true);
  });
});
