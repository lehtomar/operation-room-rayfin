import { describe, it, expect } from 'vitest';

import { SimDriver } from '../sim/driver';
import type { GridAssets } from '../grid/assets';
import { buildCrewGantt } from '../lib/events';

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

  it('restores power and returns the crew to its depot', () => {
    const assets = fakeAssets() as unknown as { scenario: { faults: { lat: number; lon: number }[] } };
    assets.scenario.faults[0].lat = 61.55;
    assets.scenario.faults[0].lon = 25.75;
    const d = new SimDriver(assets as unknown as GridAssets, null);
    d.setSpeed(600);
    d.play();
    for (let i = 0; i < 12; i++) d.tick(1);
    const s = d.snapshot();
    expect(s.incidents[0].status).toBe('restored');
    expect(s.crews[0].status).toBe('idle');
    expect(parseFloat(s.crews[0].lat)).toBeCloseTo(61.5, 5);
    expect(parseFloat(s.crews[0].lon)).toBeCloseTo(25.7, 5);
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
    const queued = d.snapshot();
    expect(queued.incidents.find((i) => i.incident_id === 'INC-2')?.reserved_crew_id).toBe('K-1');
    const blocks = buildCrewGantt(queued.events, queued.crews, queued.incidents).get('K-1') ?? [];
    expect(blocks.map((block) => block.kind)).toEqual(['incident', 'queued']);
    expect(blocks[1].startMs).toBeGreaterThanOrEqual(blocks[0].estEndMs);
    for (let i = 0; i < 8; i++) d.tick(1); // K-1 finishes INC-1 and is auto-given INC-2
    const inc2 = d.snapshot().incidents.find((i) => i.incident_id === 'INC-2')!;
    expect(inc2.status).not.toBe('open');
  });

  it('balances queued work across crew schedules and dispatches it as displayed', () => {
    const a = fakeAssets() as unknown as { scenario: { crews: unknown[]; faults: unknown[] } };
    a.scenario.crews = [
      { crew_id: 'K-1', callsign: 'Crew 1', skills: ['tree'], depot: { lat: 61.5, lon: 25.7 } },
      { crew_id: 'K-2', callsign: 'Crew 2', skills: ['tree'], depot: { lat: 61.5, lon: 25.7 } },
    ];
    a.scenario.faults = [
      { incident_id: 'INC-1', seg_id: 'S1', feeder_id: 'F1', ss_id: 'SS', offsetMin: 1, repair_effort_min: 20, lat: 61.5, lon: 25.7, fault_type: 'tree_on_line', requiredSkill: 'tree' },
      { incident_id: 'INC-2', seg_id: 'S1', feeder_id: 'F2', ss_id: 'SS', offsetMin: 2, repair_effort_min: 40, lat: 61.5, lon: 25.7, fault_type: 'tree_on_line', requiredSkill: 'tree' },
      { incident_id: 'INC-3', seg_id: 'S1', feeder_id: 'F3', ss_id: 'SS', offsetMin: 3, repair_effort_min: 30, lat: 61.5, lon: 25.7, fault_type: 'tree_on_line', requiredSkill: 'tree' },
      { incident_id: 'INC-4', seg_id: 'S1', feeder_id: 'F4', ss_id: 'SS', offsetMin: 4, repair_effort_min: 30, lat: 61.5, lon: 25.7, fault_type: 'tree_on_line', requiredSkill: 'tree' },
    ];
    const d = new SimDriver(a as unknown as GridAssets, null);
    d.setAuto(false);
    d.setSpeed(600);
    d.play();
    d.tick(1);
    d.assign('INC-1', 'K-1');
    d.assign('INC-2', 'K-2');
    d.reserveNextFree('INC-3');
    d.reserveNextFree('INC-4');

    const queued = d.snapshot();
    expect(queued.incidents.find((incident) => incident.incident_id === 'INC-3')?.reserved_crew_id).toBe('K-1');
    expect(queued.incidents.find((incident) => incident.incident_id === 'INC-4')?.reserved_crew_id).toBe('K-2');
    const gantt = buildCrewGantt(queued.events, queued.crews, queued.incidents);
    expect(gantt.get('K-1')?.some((block) => block.incident === 'INC-3' && block.kind === 'queued')).toBe(true);
    expect(gantt.get('K-2')?.some((block) => block.incident === 'INC-4' && block.kind === 'queued')).toBe(true);

    for (let i = 0; i < 7; i++) d.tick(1);
    const dispatched = d.snapshot();
    expect(dispatched.incidents.find((incident) => incident.incident_id === 'INC-3')?.crew_id).toBe('K-1');
    expect(dispatched.incidents.find((incident) => incident.incident_id === 'INC-4')?.crew_id).toBe('K-2');
  });

  it('builds a large incident backlog when seventeen storm faults arrive', () => {
    const a = fakeAssets() as unknown as {
      scenario: {
        crews: unknown[];
        faults: unknown[];
      };
    };
    a.scenario.crews = [
      { crew_id: 'K-1', callsign: 'Crew 1', skills: ['tree', 'line'], depot: { lat: 61.5, lon: 25.7 } },
      { crew_id: 'K-2', callsign: 'Crew 2', skills: ['hv', 'line'], depot: { lat: 61.5, lon: 25.7 } },
      { crew_id: 'K-3', callsign: 'Crew 3', skills: ['tree'], depot: { lat: 61.5, lon: 25.7 } },
      { crew_id: 'K-4', callsign: 'Crew 4', skills: ['tree', 'line'], depot: { lat: 61.5, lon: 25.7 } },
      { crew_id: 'K-5', callsign: 'Crew 5', skills: ['hv', 'line'], depot: { lat: 61.5, lon: 25.7 } },
      { crew_id: 'K-6', callsign: 'Crew 6', skills: ['tree', 'line'], depot: { lat: 61.5, lon: 25.7 } },
    ];
    a.scenario.faults = Array.from({ length: 17 }, (_, index) => ({
      incident_id: `INC-${String(index + 1).padStart(2, '0')}`,
      seg_id: 'S1',
      feeder_id: `F${(index % 6) + 1}`,
      ss_id: 'SS',
      offsetMin: 5 + index * 5,
      repair_effort_min: 180,
      lat: 61.5,
      lon: 25.7,
      fault_type: index % 5 === 0 ? 'transformer_failure' : index % 2 === 0 ? 'broken_pole' : 'tree_on_line',
      requiredSkill: index % 5 === 0 ? 'hv' : index % 2 === 0 ? 'line' : 'tree',
    }));
    const d = new SimDriver(a as unknown as GridAssets, null);
    d.setSpeed(600);
    d.play();
    for (let i = 0; i < 10; i++) d.tick(1);
    const state = d.snapshot();
    expect(state.incidents).toHaveLength(17);
    expect(state.incidents.filter((incident) => incident.status === 'open').length).toBeGreaterThanOrEqual(10);
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

  it('returns to depot by reversing the direct precomputed depot route', () => {
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
    d.setSpeed(6000);
    d.play();
    d.tick(1);
    d.tick(1);
    const returning = d.snapshot().crews[0];
    expect(returning.status).toBe('returning');
    expect(returning.route).toEqual([
      [25.9, 61.5],
      [25.9, 61.6],
      [25.7, 61.6],
      [25.7, 61.5],
    ]);
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
    // the unscheduled incident is open with real affected customers
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

  it('keeps future maintenance scheduled until its planned start', () => {
    const a = fakeAssets() as unknown as {
      scenario: {
        crews: unknown[];
        liveSeed: unknown;
      };
    };
    a.scenario.liveSeed = {
      startOffsetMin: 90,
      speed: 600,
      maintenance: [
        {
          job_id: 'MNT-FUTURE',
          crew_id: 'K-1',
          title: 'Future inspection',
          feeder_id: 'F1',
          ss_id: 'SS',
          seg_id: 'S1',
          requiredSkill: 'line',
          startOffsetMin: 20,
          durationMin: 30,
          lat: 61.55,
          lon: 25.75,
        },
      ],
      incidents: [],
    };
    const d = new SimDriver(a as unknown as GridAssets, null);
    d.setMode('live');
    const scheduled = d.snapshot();
    expect(scheduled.incidents[0].status).toBe('scheduled');
    expect(scheduled.crews[0].status).toBe('idle');
    const blocks = buildCrewGantt(scheduled.events, scheduled.crews, scheduled.incidents);
    expect(blocks.get('K-1')?.[0].incident).toBe('MNT-FUTURE');
    d.tick(1);
    expect(d.snapshot().incidents[0].status).toBe('scheduled');
    d.tick(1);
    expect(d.snapshot().incidents[0].status).toBe('onsite');
  });
});
