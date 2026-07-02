import type { GridAssets } from '../grid/assets';
import { haversineKm, etaMinutes } from '../lib/geo';
import type { Crew, GridEventRow, Incident, LiveState, RouteMap, ScenarioMeta, Topology } from '../lib/types';
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
  locationId: string; // routing origin id: depot id or last incident id
  route: [number, number][] | null; // [lon,lat] road polyline being driven
  routeCum: number[]; // cumulative km per vertex
  routeDist: number; // km driven along the route
  routeTotal: number; // total km
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
  reserveNext: boolean;
  reserved_crew_id: string | null;
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
  private routes: RouteMap;
  private trCoord = new Map<string, [number, number]>();
  private depotIdByCrew = new Map<string, string>();
  private start: Date;
  private simClock: Date;
  mode: 'storm' | 'live' = 'storm';
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
    this.routes = assets.routes ?? {};
    // Transformer coordinates, for placing live-seed incidents/maintenance.
    for (const f of assets.transformers?.features ?? []) {
      const id = (f.properties as { tr_id?: string } | null)?.tr_id;
      const g = f.geometry;
      if (id && g && g.type === 'Point') this.trCoord.set(id, g.coordinates as [number, number]);
    }
    // Depot ids must match routegen.py: unique depot coords in crew order.
    const depotIds = new Map<string, string>();
    for (const c of this.meta.crews) {
      const key = `${c.depot.lat.toFixed(6)},${c.depot.lon.toFixed(6)}`;
      if (!depotIds.has(key)) depotIds.set(key, `DEPOT-${depotIds.size}`);
      this.depotIdByCrew.set(c.crew_id, depotIds.get(key)!);
    }
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
        locationId: this.depotIdByCrew.get(c.crew_id) ?? 'DEPOT-0',
        route: null,
        routeCum: [],
        routeDist: 0,
        routeTotal: 0,
      });
    }
    if (persist && this.persist) {
      this.persist.resetLive().catch(() => {});
      this.persist.scenario({ sim_clock: this.simClock, playing: false, status: 'idle' }).catch(() => {});
    }
    if (this.mode === 'live') this.seedLive();
  }

  /** Switch board between recorded storm replay and live/normal operations. */
  setMode(m: 'storm' | 'live'): void {
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'storm') this.speed = this.meta.defaultSpeed ?? 24;
    this.reset();
  }

  private segCoord(segId: string): [number, number] {
    const seg = this.topo.segments[segId];
    const tid = seg?.transformer_ids?.[0];
    const c = tid ? this.trCoord.get(tid) : undefined;
    if (c) return c;
    const d = this.meta.crews[0].depot;
    return [d.lon, d.lat];
  }

  /**
   * Seed the Live board so "normal operations" is realistic: two crews already
   * out on planned maintenance, plus a few small unscheduled outages waiting for
   * dispatch. Maintenance is planned work (no customer impact) — it is filtered
   * out of the fault/de-energization logic in the UI.
   */
  private seedLive(): void {
    const seed = this.meta.liveSeed;
    if (!seed) return;
    const now = new Date(this.start.getTime() + seed.startOffsetMin * 60000);
    this.simClock = now;
    this.speed = seed.speed ?? 12;
    this.playing = true;
    this.status = 'running';

    for (const m of seed.maintenance) {
      const seg = this.topo.segments[m.seg_id];
      const [lon, lat] = m.lat != null && m.lon != null ? [m.lon, m.lat] : this.segCoord(m.seg_id);
      const startTs = new Date(now.getTime() + m.startOffsetMin * 60000);
      this.incidents.set(m.job_id, {
        incident_id: m.job_id,
        seg_id: m.seg_id,
        feeder_id: m.feeder_id,
        ss_id: m.ss_id,
        fault_type: 'scheduled_maintenance',
        status: 'onsite',
        affected_kp: 0,
        affected_tr: seg?.transformer_ids.length ?? 0,
        repair_effort_min: m.durationMin,
        required_skill: m.requiredSkill,
        lat,
        lon,
        crew_id: m.crew_id,
        eta_min: 0,
        started_at: startTs.toISOString(),
        restored_at: null,
        reserveNext: false,
        reserved_crew_id: null,
      });
      this.fired.add(m.job_id);
      const crew = this.crews.get(m.crew_id);
      if (crew) {
        crew.status = 'onsite';
        crew.current_incident_id = m.job_id;
        crew.lat = lat;
        crew.lon = lon;
        crew.locationId = m.job_id;
        this.onsiteAt.set(m.crew_id, startTs);
      }
      this.emitAt(startTs.toISOString(), 'crew_status', m.crew_id, m.feeder_id, {
        assigned: m.job_id,
        eta_min: 0,
        maintenance: true,
        title: m.title,
      });
      this.emitAt(startTs.toISOString(), 'crew_status', m.crew_id, m.feeder_id, { onsite: m.job_id });
    }

    for (const f of seed.incidents) {
      const seg = this.topo.segments[f.seg_id];
      const [lon, lat] = f.lat != null && f.lon != null ? [f.lon, f.lat] : this.segCoord(f.seg_id);
      const startTs = new Date(now.getTime() + f.startOffsetMin * 60000);
      this.incidents.set(f.incident_id, {
        incident_id: f.incident_id,
        seg_id: f.seg_id,
        feeder_id: f.feeder_id,
        ss_id: f.ss_id,
        fault_type: f.fault_type,
        status: 'open',
        affected_kp: seg?.kayttopaikka_count ?? 0,
        affected_tr: seg?.transformer_ids.length ?? 0,
        repair_effort_min: f.repair_effort_min,
        required_skill: f.requiredSkill,
        lat,
        lon,
        crew_id: null,
        eta_min: null,
        started_at: startTs.toISOString(),
        restored_at: null,
        reserveNext: false,
        reserved_crew_id: null,
      });
      this.fired.add(f.incident_id);
      this.emitAt(startTs.toISOString(), 'fault', f.seg_id, f.feeder_id, {
        incident_id: f.incident_id,
        type: f.fault_type,
        kp: seg?.kayttopaikka_count ?? 0,
      });
    }
    // Newest event first for the ticker.
    this.events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
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
    if (this.mode === 'storm') {
      this.fireFaults(elapsedMin);
      if (this.auto) this.autoDispatch();
    }
    this.moveCrews(dtRealSec * this.speed);
    if (this.mode === 'storm') this.checkDone(elapsedMin);
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
        reserveNext: false,
        reserved_crew_id: null,
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

  /** Estimated wall-clock ms when a crew will next be free/idle. */
  private crewFreeAtMs(crew: CrewState): number {
    if (crew.status === 'idle') return this.simClock.getTime();
    const inc = crew.current_incident_id ? this.incidents.get(crew.current_incident_id) : null;
    const repairMs = (inc?.repair_effort_min ?? 60) * 60000;
    if (crew.status === 'onsite') {
      const onsite = this.onsiteAt.get(crew.crew_id) ?? this.simClock;
      return onsite.getTime() + repairMs;
    }
    const etaMs = (inc?.eta_min ?? 10) * 60000; // enroute: remaining travel + repair
    return this.simClock.getTime() + etaMs + repairMs;
  }

  /** The skilled crew that will be free soonest (tie-break: closest). */
  private soonestFreeCrew(inc: IncidentState): { crew: CrewState; freeAtMs: number } | null {
    let best: { crew: CrewState; freeAtMs: number } | null = null;
    let bestKm = Infinity;
    for (const c of this.crews.values()) {
      if (!c.skills.includes(inc.required_skill)) continue;
      const freeAt = this.crewFreeAtMs(c);
      const km = haversineKm(c.lat, c.lon, inc.lat, inc.lon);
      if (!best || freeAt < best.freeAtMs || (freeAt === best.freeAtMs && km < bestKm)) {
        best = { crew: c, freeAtMs: freeAt };
        bestKm = km;
      }
    }
    return best;
  }

  /** Preview which crew would take a still-open incident and when it frees. */
  reserveSuggestion(incidentId: string): { crew_id: string; freesInMin: number } | null {
    const inc = this.incidents.get(incidentId);
    if (!inc) return null;
    const s = this.soonestFreeCrew(inc);
    if (!s) return null;
    return {
      crew_id: s.crew.crew_id,
      freesInMin: Math.max(0, Math.round((s.freeAtMs - this.simClock.getTime()) / 60000)),
    };
  }

  /** Queue an open incident to be taken by the next matching crew that frees. */
  reserveNextFree(incidentId: string): void {
    const inc = this.incidents.get(incidentId);
    if (!inc || inc.status !== 'open') return;
    const s = this.soonestFreeCrew(inc);
    if (!s) return;
    // If a matching crew is already idle, dispatch immediately.
    if (s.crew.status === 'idle') {
      this.assign(incidentId, s.crew.crew_id);
      return;
    }
    inc.reserveNext = true;
    inc.reserved_crew_id = s.crew.crew_id; // display hint (actual crew = first to free)
    this.emit('crew_status', s.crew.crew_id, inc.feeder_id, { reserved: incidentId });
  }

  /** When a crew becomes idle, give it the best waiting incident it may take. */
  private tryAssignFreedCrew(crew: CrewState): void {
    let best: IncidentState | null = null;
    let bestKm = Infinity;
    for (const inc of this.incidents.values()) {
      if (inc.status !== 'open') continue;
      if (!((inc.reserveNext || (this.auto && this.mode === 'storm')) && crew.skills.includes(inc.required_skill))) continue;
      const km = haversineKm(crew.lat, crew.lon, inc.lat, inc.lon);
      if (km < bestKm) {
        bestKm = km;
        best = inc;
      }
    }
    if (best) this.assign(best.incident_id, crew.crew_id);
  }

  assign(incidentId: string, crewId: string): void {
    const inc = this.incidents.get(incidentId);
    const crew = this.crews.get(crewId);
    if (!inc || !crew || inc.status !== 'open' || crew.status !== 'idle') return;
    // Follow the precomputed road route from the crew's current location.
    const route = this.routes[`${crew.locationId}->${incidentId}`];
    let eta: number;
    if (route && route.coords.length >= 2) {
      crew.route = route.coords;
      crew.routeCum = cumulativeKm(route.coords);
      crew.routeTotal = crew.routeCum[crew.routeCum.length - 1];
      crew.routeDist = 0;
      eta = Math.max(1, Math.round((crew.routeTotal / CREW_SPEED_KMH) * 60));
    } else {
      crew.route = null;
      eta = etaMinutes(crew.lat, crew.lon, inc.lat, inc.lon);
    }
    inc.status = 'assigned';
    inc.crew_id = crewId;
    inc.eta_min = eta;
    crew.status = 'enroute';
    crew.current_incident_id = incidentId;
    this.emit('crew_status', crewId, inc.feeder_id, { assigned: incidentId, eta_min: eta });
    this.persist?.incident(this.incidentRow(inc)).catch(() => {});
    this.persist?.crew(crewId, { status: 'enroute', current_incident_id: incidentId }).catch(() => {});
  }

  private arriveOnSite(crew: CrewState, inc: IncidentState, incId: string): void {
    crew.status = 'onsite';
    inc.status = 'onsite';
    this.onsiteAt.set(crew.crew_id, new Date(this.simClock));
    this.emit('crew_status', crew.crew_id, inc.feeder_id, { onsite: incId });
    this.persist?.crew(crew.crew_id, { lat: crew.lat.toFixed(6), lon: crew.lon.toFixed(6), status: 'onsite' }).catch(() => {});
    this.persist?.incident(this.incidentRow(inc)).catch(() => {});
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
        if (crew.route) {
          // drive along the road polyline
          crew.routeDist += stepKm;
          if (crew.routeDist >= crew.routeTotal) {
            crew.lat = inc.lat;
            crew.lon = inc.lon;
            crew.route = null;
            crew.locationId = incId;
            this.arriveOnSite(crew, inc, incId);
          } else {
            const [lon, lat] = pointAlong(crew.route, crew.routeCum, crew.routeDist);
            crew.lat = lat;
            crew.lon = lon;
            if (persistPos) this.persist?.crew(crew.crew_id, { lat: lat.toFixed(6), lon: lon.toFixed(6) }).catch(() => {});
          }
        } else {
          // no road route available -> straight-line fallback
          const dist = haversineKm(crew.lat, crew.lon, inc.lat, inc.lon);
          if (dist <= Math.max(ARRIVE_KM, stepKm)) {
            crew.lat = inc.lat;
            crew.lon = inc.lon;
            crew.locationId = incId;
            this.arriveOnSite(crew, inc, incId);
          } else {
            const frac = stepKm / dist;
            crew.lat += (inc.lat - crew.lat) * frac;
            crew.lon += (inc.lon - crew.lon) * frac;
            if (persistPos) this.persist?.crew(crew.crew_id, { lat: crew.lat.toFixed(6), lon: crew.lon.toFixed(6) }).catch(() => {});
          }
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
          this.tryAssignFreedCrew(crew);
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

  /** Emit a historic event (used when seeding the live board). */
  private emitAt(ts: string, type: string, entity_id: string, feeder_id: string | null, payload: Record<string, unknown>): void {
    this.events.unshift({ ts, event_type: type, entity_id, feeder_id, payload });
    if (this.events.length > 150) this.events.pop();
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
      route: c.status === 'enroute' && c.route ? c.route : null,
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
      reserved_crew_id: i.reserveNext ? i.reserved_crew_id : null,
      lat: i.lat,
      lon: i.lon,
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

function cumulativeKm(coords: [number, number][]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return cum;
}

function pointAlong(coords: [number, number][], cum: number[], distKm: number): [number, number] {
  if (distKm <= 0) return coords[0];
  const total = cum[cum.length - 1];
  if (distKm >= total) return coords[coords.length - 1];
  let i = 1;
  while (i < cum.length && cum[i] < distKm) i++;
  const f = (distKm - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  const a = coords[i - 1];
  const b = coords[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
