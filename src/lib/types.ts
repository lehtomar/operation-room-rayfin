// Shared domain types for the Verkkovahti control room.

export interface Scenario {
  scenario_id: string;
  status: string; // idle | running | paused | done
  playing: boolean;
  speed: number;
  sim_clock: string; // ISO
  elapsed_min: number;
  start: string; // ISO
}

export interface Wind {
  speed_ms: number;
  gust_ms: number;
  dir_deg: number;
}

export interface Incident {
  incident_id: string;
  seg_id: string;
  feeder_id: string;
  ss_id: string;
  fault_type: string; // tree_on_line | broken_pole | transformer_failure
  status: string; // open | assigned | enroute | onsite | restored
  affected_kp: number;
  affected_tr: number;
  repair_effort_min: number;
  crew_id: string | null;
  eta_min: number | null;
  started_at: string | null;
  restored_at: string | null;
}

export interface Crew {
  crew_id: string;
  callsign: string;
  skills: string; // csv
  status: string; // idle | enroute | onsite | returning | offshift
  lat: string;
  lon: string;
  current_incident_id: string | null;
}

export interface GridEventRow {
  ts: string;
  event_type: string; // fault | restoration | crew_status | transformer_status
  entity_id: string;
  feeder_id: string | null;
  payload: Record<string, unknown> | null;
}

export interface LiveState {
  scenario: Scenario | null;
  wind: Wind | null;
  incidents: Incident[];
  crews: Crew[];
  events: GridEventRow[];
}

// --- static grid + scenario assets ---
export interface SegmentClosure {
  transformer_ids: string[];
  kayttopaikka_count: number;
  kayttopaikka_ids: string[];
}

export interface Topology {
  counts: Record<string, number>;
  transformer_nodes: Record<string, string>;
  segments: Record<string, SegmentClosure>;
}

export interface ScenarioMeta {
  id: string;
  name: string;
  simDurationMin: number;
  defaultSpeed?: number;
  startWallClock: string;
  crews: {
    crew_id: string;
    callsign: string;
    skills: string[];
    depot: { lat: number; lon: number };
  }[];
  storm: {
    name: string;
    direction: string;
    warningPolygon: [number, number][];
    front: { offsetMin: number; line: [number, number][] }[];
    wind: { offsetMin: number; speed_ms: number; gust_ms: number; dir_deg: number }[];
  };
  faults: {
    incident_id: string;
    seg_id: string;
    feeder_id: string;
    ss_id: string;
    offsetMin: number;
    repair_effort_min: number;
    lat: number;
    lon: number;
    fault_type: string;
    requiredSkill?: string;
  }[];
}

export interface CompensationTier {
  hours: number;
  pct: number;
}

export interface Municipality {
  id: string;
  name: string;
  map: { center: { lon: number; lat: number }; defaultZoom: number };
  compensation: {
    assumedAnnualDistributionFeeEur: number;
    tiers: CompensationTier[];
    capPct: number;
  };
  fmi: { place: string };
}
