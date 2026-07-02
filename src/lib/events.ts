import type { Crew, GridEventRow } from './types';

const FAULT_LABEL: Record<string, string> = {
  tree_on_line: 'Tree on line',
  broken_pole: 'Broken pole',
  transformer_failure: 'Transformer failure',
};

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
}

/** One-line English description of an event for the ticker / alert feed. */
export function describeEvent(e: GridEventRow): string {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case 'fault':
      return `New ${FAULT_LABEL[String(p.type)] ?? 'fault'} — feeder ${e.feeder_id} · ${p.kp ?? '?'} käyttöpaikkaa`;
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
  startMs: number;
  onsiteMs: number | null;
  endMs: number | null; // null = still ongoing
}

/**
 * Reconstruct per-crew assignment blocks from the append-only event log:
 * a `crew_status {assigned}` opens a block (enroute), `{onsite}` marks arrival,
 * and the matching `restoration` closes it. Open blocks run to `nowMs`.
 */
export function buildCrewGantt(events: GridEventRow[], crews: Crew[]): Map<string, GanttBlock[]> {
  const asc = [...events].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const blocks = new Map<string, GanttBlock[]>();
  for (const c of crews) blocks.set(c.crew_id, []);
  const openByIncident = new Map<string, { crew: string; block: GanttBlock }>();

  for (const e of asc) {
    const t = new Date(e.ts).getTime();
    const p = e.payload ?? {};
    if (e.event_type === 'crew_status' && p.assigned) {
      const crew = e.entity_id;
      const block: GanttBlock = { incident: String(p.assigned), feeder: e.feeder_id, startMs: t, onsiteMs: null, endMs: null };
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
  return blocks;
}
