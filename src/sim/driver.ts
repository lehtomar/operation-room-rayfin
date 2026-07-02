import type { GridAssets } from '../grid/assets';
import { haversineKm, etaMinutes } from '../lib/geo';
import type { Crew, GridEventRow, Incident, LiveState, ScenarioMeta, Topology } from '../lib/types';
import { windAt } from '../lib/wind';

const CREW_SPEED_KMH = 60;
const ARRIVE_KM = 0.1;

/** Best-effort persistence sink (GraphQL in prod, no-op in dev). Never throws. */
export interface Persist {
  seed(crews: SeedCrew[], scenarioId: string, startIso: string, speed: number): Promise<void>;
  resetLive(): Promise<void>;
  incident(row: Record<string, unknown>): Promise<void>;
  crew(crewId: string, patch: Record<string, unknown>): Promise<void>;
  event(row: Record<string, unknown>): Promise<void>;
  scenario(patch: Record<string, unknown>): Promise<void>;
}
export interface SeedCrew {
  crew_id: string;
  callsign: string;
  skills: string;
  depot_lat: number;
  depot_lon: number;
}

interface CrewState {
  crew_id: string;
  callsign: string;
  skills: string[];
  status: string;
  lat: number;
  lon: number;
  depotLat: number;
  depotLon: number;
  current_incident_id: string | null;
}
interface IncidentState {
  incident_id: string;
  seg_id: string;
  feeder_id: string;
  ss_id: string;
  fault_type: string;
  status: string;
  affected_kp: number;
  affected_tr: number;
  repair_effort_min: number;
  required_skill: string;
  lat: number;
  lon: number;
  crew_id: string | null;
  eta_min: number | null;
  started_at: string | null;
  restored_at: string | null;
}

/**
 * Self-contained storm engine that runs in the browser from the bundled
 * scenario + topology. It is the source of truth for the UI (so the deployed
 * app animates with zero backend dependency); `persist` mirrors state into the
 * Fabric SQL DB on a best-effort basis.
 */
export class SimDriver {
  private meta: ScenarioMeta;
  private topo: Topology;
  private start: Date;
  private simClock: Date;
  playing = false;
  speed = 24;
  status = 'idle';
  auto = true;
  private crews = new Map<string, CrewState>();
  private incidents = new Map<string, IncidentState>();
  private events: GridEventRow[] = [];
  private fired = new Set<string>();
  private onsiteAt = new Map<string, Date>();
  private lastPosPersist = 0;

  constructor(
    assets: GridAssets,
    private persist: Persist | null = null
  ) {
    this.meta = assets.scenario;
    this.topo = assets.topology;
    this.start = new Date(this.meta.startWallClock);
    this.simClock = new Date(this.meta.startWallClock);
    this.speed = this.meta.defaultSpeed ?? 24;
    this.reset(false);
  }

  async init(): Promise<void> {
    if (!this.persist) return;
    try {
      await this.persist.seed(
        [...this.crews.values()].map((c) => ({
          crew_id: c.crew_id,
          callsign: c.callsign,
          skills: c.skills.join(','),
          depot_lat: c.depotLat,
          depot_lon: c.depotLon,
        })),
        this.meta.id,
        this.start.toISOString(),
        this.speed
      );
    } catch {
      /* best-effort */
    }
  }

  reset(persist = true): void {
    this.simClock = new Date(this.start);
    this.playing = false;
    this.status = 'idle';
    this.incidents.clear();
    this.events = [];
    this.fired.clear();
    this.onsiteAt.clear();
    this.crews.clear();
    for (const c of this.meta.crews) {
      this.crews.set(c.crew_id, {
        crew_id: c.crew_id,
        callsign: c.callsign,
        skills: c.skills,
        status: 'idle',
        lat: c.depot.lat,
        lon: c.depot.lon,
        depotLat: c.depot.lat,
        depotLon: c.depot.lon,
        current_incident_id: null,
      });
    }
    if (persist && this.persist) {
      this.persist.resetLive().catch(() => {});
      this.persist.scenario({ sim_clock: this.simClock, playing: false, status: 'idle' }).catch(() => {});
    }
  }

  play(): void {
    this.playing = true;
    this.status = 'running';
    this.persist?.scenario({ playing: true, status: 'running' }).catch(() => {});
  }
  pause(): void {
    this.playing = false;
    this.status = 'paused';
    this.persist?.scenario({ playing: false, status: 'paused' }).catch(() => {});
  }
  setSpeed(v: number): void {
    this.speed = v;
    this.persist?.scenario({ speed: v }).catch(() => {});
  }
  setAuto(v: boolean): void {
    this.auto = v;
  }

  tick(dtRealSec: number): void {
    if (!this.playing || this.status === 'done') return;
    this.simClock = new Date(this.simClock.getTime() + dtRealSec * this.speed * 1000);
    const elapsedMin = (this.simClock.getTime() - this.start.getTime()) / 60000;
    this.fireFaults(elapsedMin);
    if (this.auto) this.autoDispatch();
    this.moveCrews(dtRealSec * this.speed);
    this.checkDone(elapsedMin);
    this.persist?.scenario({ sim_clock: this.simClock, status: this.status }).catch(() => {});
  }

  private fireFaults(elapsedMin: number): void {
    for (const f of this.meta.faults) {
      if (this.fired.has(f.incident_id) || elapsedMin < f.offsetMin) continue;
      const seg = this.topo.segments[f.seg_id];
      const inc: IncidentState = {
        incident_id: f.incident_id,
        seg_id: f.seg_id,
        feeder_id: f.feeder_id,
        ss_id: f.ss_id,
        fault_type: f.fault_type,
        status: 'open',
        affected_kp: seg?.kayttopaikka_count ?? 0,
        affected_tr: seg?.transformer_ids.length ?? 0,
        repair_effort_min: f.repair_effort_min,
        required_skill: f.requiredSkill ?? 'line',
        lat: f.lat,
        lon: f.lon,
        crew_id: null,
        eta_min: null,
        started_at: this.simClock.toISOString(),
        restored_at: null,
      };
      this.incidents.set(f.incident_id, inc);
      this.fired.add(f.incident_id);
      this.emit('fault', f.seg_id, f.feeder_id, { incident_id: f.incident_id, type: f.fault_type, kp: inc.affected_kp });
      this.persist?.incident(this.incidentRow(inc)).catch(() => {});
    }
  }

  private autoDispatch(): void {
    for (const inc of this.incidents.values()) {
      if (inc.status !== 'open' || inc.crew_id) continue;
      const crew = this.nearestCrew(inc);
      if (crew) this.assign(inc.incident_id, crew.crew_id);
    }
  }

  private nearestCrew(inc: IncidentState): CrewState | null {
    let best: CrewState | null = null;
    let bestKm = Infinity;
    for (const c of this.crews.values()) {
      if (c.status !== 'idle' || !c.skills.includes(inc.required_skill)) continue;
      const km = haversineKm(c.lat, c.lon, inc.lat, inc.lon);
      if (km < bestKm) {
        bestKm = km;
        best = c;
      }
    }
    return best;
  }

  assign(incidentId: string, crewId: string): void {
    const inc = this.incidents.get(incidentId);
    const crew = this.crews.get(crewId);
    if (!inc || !crew || inc.status !== 'open' || crew.status !== 'idle') return;
    const eta = etaMinutes(crew.lat, crew.lon, inc.lat, inc.lon);
    inc.status = 'assigned';
    inc.crew_id = crewId;
    inc.eta_min = eta;
    crew.status = 'enroute';
    crew.current_incident_id = incidentId;
    this.emit('crew_status', crewId, inc.feeder_id, { assigned: incidentId, eta_min: eta });
    this.persist?.incident(this.incidentRow(inc)).catch(() => {});
    this.persist?.crew(crewId, { status: 'enroute', current_incident_id: incidentId }).catch(() => {});
  }

  private moveCrews(dtSimSec: number): void {
    const stepKm = CREW_SPEED_KMH * (dtSimSec / 3600);
    const persistPos = Date.now() - this.lastPosPersist > 2000;
    for (const crew of this.crews.values()) {
      const incId = crew.current_incident_id;
      if (!incId || (crew.status !== 'enroute' && crew.status !== 'onsite')) continue;
      const inc = this.incidents.get(incId);
      if (!inc) continue;
      if (crew.status === 'enroute') {
        const dist = haversineKm(crew.lat, crew.lon, inc.lat, inc.lon);
        if (dist <= Math.max(ARRIVE_KM, stepKm)) {
          crew.lat = inc.lat;
          crew.lon = inc.lon;
          crew.status = 'onsite';
          inc.status = 'onsite';
          this.onsiteAt.set(crew.crew_id, new Date(this.simClock));
          this.emit('crew_status', crew.crew_id, inc.feeder_id, { onsite: incId });
          this.persist?.crew(crew.crew_id, { lat: crew.lat.toFixed(6), lon: crew.lon.toFixed(6), status: 'onsite' }).catch(() => {});
          this.persist?.incident(this.incidentRow(inc)).catch(() => {});
        } else {
          const frac = stepKm / dist;
          crew.lat += (inc.lat - crew.lat) * frac;
          crew.lon += (inc.lon - crew.lon) * frac;
          if (persistPos) this.persist?.crew(crew.crew_id, { lat: crew.lat.toFixed(6), lon: crew.lon.toFixed(6) }).catch(() => {});
        }
      } else {
        const onsite = this.onsiteAt.get(crew.crew_id) ?? this.simClock;
        if ((this.simClock.getTime() - onsite.getTime()) / 60000 >= inc.repair_effort_min) {
          inc.status = 'restored';
          inc.restored_at = this.simClock.toISOString();
          crew.status = 'idle';
          crew.current_incident_id = null;
          this.emit('restoration', inc.seg_id, inc.feeder_id, { incident_id: incId });
          this.persist?.incident(this.incidentRow(inc)).catch(() => {});
          this.persist?.crew(crew.crew_id, { status: 'idle', current_incident_id: null }).catch(() => {});
        }
      }
    }
    if (persistPos) this.lastPosPersist = Date.now();
  }

  private checkDone(elapsedMin: number): void {
    if (
      elapsedMin >= this.meta.simDurationMin &&
      this.fired.size === this.meta.faults.length &&
      [...this.incidents.values()].every((i) => i.status === 'restored')
    ) {
      this.status = 'done';
    }
  }

  private emit(type: string, entity_id: string, feeder_id: string | null, payload: Record<string, unknown>): void {
    this.events.unshift({ ts: this.simClock.toISOString(), event_type: type, entity_id, feeder_id, payload });
    if (this.events.length > 150) this.events.pop();
    this.persist?.event({ ts: this.simClock, event_type: type, entity_id, feeder_id, payload: JSON.stringify(payload) }).catch(() => {});
  }

  private incidentRow(inc: IncidentState): Record<string, unknown> {
    return {
      incident_id: inc.incident_id,
      seg_id: inc.seg_id,
      feeder_id: inc.feeder_id,
      ss_id: inc.ss_id,
      fault_type: inc.fault_type,
      status: inc.status,
      affected_kp: inc.affected_kp,
      affected_tr: inc.affected_tr,
      repair_effort_min: inc.repair_effort_min,
      crew_id: inc.crew_id,
      eta_min: inc.eta_min,
      started_at: inc.started_at,
      restored_at: inc.restored_at,
    };
  }

  snapshot(): LiveState {
    const elapsedMin = (this.simClock.getTime() - this.start.getTime()) / 60000;
    const crews: Crew[] = [...this.crews.values()].map((c) => ({
      crew_id: c.crew_id,
      callsign: c.callsign,
      skills: c.skills.join(','),
      status: c.status,
      lat: c.lat.toFixed(6),
      lon: c.lon.toFixed(6),
      current_incident_id: c.current_incident_id,
    }));
    const incidents: Incident[] = [...this.incidents.values()].map((i) => ({
      incident_id: i.incident_id,
      seg_id: i.seg_id,
      feeder_id: i.feeder_id,
      ss_id: i.ss_id,
      fault_type: i.fault_type,
      status: i.status,
      affected_kp: i.affected_kp,
      affected_tr: i.affected_tr,
      repair_effort_min: i.repair_effort_min,
      crew_id: i.crew_id,
      eta_min: i.eta_min,
      started_at: i.started_at,
      restored_at: i.restored_at,
    }));
    return {
      scenario: {
        scenario_id: this.meta.id,
        status: this.status,
        playing: this.playing,
        speed: this.speed,
        sim_clock: this.simClock.toISOString(),
        elapsed_min: elapsedMin,
        start: this.start.toISOString(),
      },
      wind: windAt(this.meta, elapsedMin),
      crews,
      incidents,
      events: this.events.slice(),
    };
  }
}
