import type { Crew, GridEventRow, Incident } from './types';

export type FaultDispatchStatus = 'unassigned' | 'queued' | 'assigned' | 'onsite';

export function faultDispatchStatus(incident: Incident): FaultDispatchStatus {
  if (incident.status === 'open') return incident.reserved_crew_id ? 'queued' : 'unassigned';
  if (incident.status === 'onsite') return 'onsite';
  return 'assigned';
}

const FAULT_LABEL: Record<string, string> = {
  tree_on_line: 'Tree on line',
  broken_pole: 'Broken pole',
  transformer_failure: 'Transformer failure',
  scheduled_maintenance: 'Scheduled maintenance',
};

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
}

/** One-line English description of an event for the ticker / alert feed. */
export function describeEvent(e: GridEventRow): string {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case 'fault':
      return `New ${FAULT_LABEL[String(p.type)] ?? 'fault'} — feeder ${e.feeder_id} · ${p.kp ?? '?'} customers`;
    case 'restoration':
      return `Restored — feeder ${e.feeder_id} · ${e.entity_id}`;
    case 'crew_status':
      if (p.assigned) return `${e.entity_id} dispatched → ${p.assigned} · ETA ${p.eta_min ?? '?'} min`;
      if (p.onsite) return `${e.entity_id} on site — ${p.onsite}`;
      return `${e.entity_id} status update`;
    default:
      return `${e.event_type} · ${e.entity_id}`;
  }
}

export interface AlertItem {
  ts: string;
  text: string;
  kind: 'fault' | 'restoration' | 'crew' | 'other';
}

export function toAlerts(events: GridEventRow[]): AlertItem[] {
  return events.map((e) => ({
    ts: e.ts,
    text: `${hhmm(e.ts)}  ${describeEvent(e)}`,
    kind:
      e.event_type === 'fault'
        ? 'fault'
        : e.event_type === 'restoration'
          ? 'restoration'
          : e.event_type === 'crew_status'
            ? 'crew'
            : 'other',
  }));
}

// ---- crew Gantt ----
export interface GanttBlock {
  incident: string;
  feeder: string | null;
  kind: 'incident' | 'maintenance' | 'queued';
  startMs: number;
  onsiteMs: number | null;
  endMs: number | null; // null = still ongoing (actual restoration time)
  estOnsiteMs: number; // projected arrival
  estEndMs: number; // projected completion (start + ETA + repair effort)
}

/**
 * Reconstruct per-crew assignment blocks from the append-only event log:
 * a `crew_status {assigned}` opens a block (enroute), `{onsite}` marks arrival,
 * and the matching `restoration` closes it. Open blocks are projected forward to
 * their estimated completion (arrival + repair effort) using the incident data.
 */
export function buildCrewGantt(
  events: GridEventRow[],
  crews: Crew[],
  incidents: Incident[] = []
): Map<string, GanttBlock[]> {
  const incById = new Map(incidents.map((i) => [i.incident_id, i]));
  const asc = [...events].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const blocks = new Map<string, GanttBlock[]>();
  for (const c of crews) blocks.set(c.crew_id, []);
  const openByIncident = new Map<string, { crew: string; block: GanttBlock }>();

  for (const e of asc) {
    const t = new Date(e.ts).getTime();
    const p = e.payload ?? {};
    if (e.event_type === 'crew_status' && p.assigned) {
      const crew = e.entity_id;
      const block: GanttBlock = {
        incident: String(p.assigned),
        feeder: e.feeder_id,
        kind: p.maintenance ? 'maintenance' : 'incident',
        startMs: t,
        onsiteMs: null,
        endMs: null,
        estOnsiteMs: t,
        estEndMs: t,
      };
      if (!blocks.has(crew)) blocks.set(crew, []);
      blocks.get(crew)!.push(block);
      openByIncident.set(String(p.assigned), { crew, block });
    } else if (e.event_type === 'crew_status' && p.onsite) {
      const rec = openByIncident.get(String(p.onsite));
      if (rec) rec.block.onsiteMs = t;
    } else if (e.event_type === 'restoration') {
      const incId = String(p.incident_id ?? '');
      const rec = openByIncident.get(incId);
      if (rec) {
        rec.block.endMs = t;
        openByIncident.delete(incId);
      }
    }
  }

  for (const inc of incidents) {
    if (
      inc.fault_type !== 'scheduled_maintenance' ||
      inc.status !== 'scheduled' ||
      !inc.crew_id ||
      !inc.started_at ||
      openByIncident.has(inc.incident_id)
    ) {
      continue;
    }
    const startMs = new Date(inc.started_at).getTime();
    const block: GanttBlock = {
      incident: inc.incident_id,
      feeder: inc.feeder_id,
      kind: 'maintenance',
      startMs,
      onsiteMs: null,
      endMs: null,
      estOnsiteMs: startMs,
      estEndMs: startMs + inc.repair_effort_min * 60000,
    };
    if (!blocks.has(inc.crew_id)) blocks.set(inc.crew_id, []);
    blocks.get(inc.crew_id)!.push(block);
  }

  // Project estimated arrival + completion for every block.
  for (const list of blocks.values()) {
    for (const b of list) {
      const inc = incById.get(b.incident);
      const etaMs = (inc?.eta_min ?? 10) * 60000;
      const repairMs = (inc?.repair_effort_min ?? 60) * 60000;
      b.estOnsiteMs = b.onsiteMs ?? b.startMs + etaMs;
      b.estEndMs = b.endMs ?? b.estOnsiteMs + repairMs;
    }
  }

  const reservedAt = new Map<string, number>();
  for (const event of asc) {
    const reserved = event.event_type === 'crew_status' ? event.payload?.reserved : null;
    if (reserved) reservedAt.set(String(reserved), new Date(event.ts).getTime());
  }
  const queuedByCrew = new Map<string, Incident[]>();
  for (const incident of incidents) {
    if (incident.status !== 'open' || !incident.reserved_crew_id) continue;
    const queued = queuedByCrew.get(incident.reserved_crew_id) ?? [];
    queued.push(incident);
    queuedByCrew.set(incident.reserved_crew_id, queued);
  }
  for (const [crewId, queued] of queuedByCrew) {
    const list = blocks.get(crewId) ?? [];
    queued.sort(
      (a, b) =>
        (reservedAt.get(a.incident_id) ?? new Date(a.started_at ?? 0).getTime()) -
        (reservedAt.get(b.incident_id) ?? new Date(b.started_at ?? 0).getTime())
    );
    let freeAt = Math.max(0, ...list.map((block) => block.estEndMs));
    for (const incident of queued) {
      const queuedAt = reservedAt.get(incident.incident_id) ?? new Date(incident.started_at ?? 0).getTime();
      const startMs = Math.max(freeAt, queuedAt);
      const estOnsiteMs = startMs + (incident.eta_min ?? 10) * 60000;
      const block: GanttBlock = {
        incident: incident.incident_id,
        feeder: incident.feeder_id,
        kind: 'queued',
        startMs,
        onsiteMs: null,
        endMs: null,
        estOnsiteMs,
        estEndMs: estOnsiteMs + incident.repair_effort_min * 60000,
      };
      list.push(block);
      freeAt = block.estEndMs;
    }
    blocks.set(crewId, list);
  }

  for (const list of blocks.values()) list.sort((a, b) => a.startMs - b.startMs);
  return blocks;
}
