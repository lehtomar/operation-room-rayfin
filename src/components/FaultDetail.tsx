import type { Crew, Incident } from '../lib/types';

const FAULT_LABEL: Record<string, string> = {
  tree_on_line: 'Tree on line',
  broken_pole: 'Broken pole',
  transformer_failure: 'Transformer failure',
};
const WORK_LABEL: Record<string, string> = {
  tree_on_line: 'tree clearing',
  broken_pole: 'pole replacement · HV work',
  transformer_failure: 'transformer swap · HV work',
};
const STATUS_LABEL: Record<string, string> = {
  open: 'Unassigned',
  assigned: 'Assigned',
  enroute: 'En route',
  onsite: 'On site',
  restored: 'Restored',
};

interface FaultDetailProps {
  incident: Incident;
  suggested: { crew: Crew; etaMin: number } | null;
  reserveSuggestion: { crew_id: string; freesInMin: number } | null;
  simNowIso: string | undefined;
  onDispatch: (incidentId: string, crewId: string, etaMin: number) => void;
  onReserve: (incidentId: string) => void;
  onClose: () => void;
}

function outage(startIso: string | null, nowIso: string | undefined): string {
  if (!startIso || !nowIso) return '–';
  const mins = Math.max(0, Math.round((new Date(nowIso).getTime() - new Date(startIso).getTime()) / 60000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h} h ${mins % 60} min` : `${mins} min`;
}

export function FaultDetail(props: FaultDetailProps) {
  const { incident: i, suggested } = props;
  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <div className="detail-type">
            <span className="detail-dot" /> {FAULT_LABEL[i.fault_type] ?? i.fault_type}
          </div>
          <div className="detail-sub">Feeder {i.feeder_id} · section {i.seg_id}</div>
        </div>
        <button className="x" onClick={props.onClose}>✕</button>
      </div>

      <div className="detail-grid">
        <Stat label="Affected" value={`${i.affected_kp.toLocaleString('fi-FI')} kp`} tone="danger" />
        <Stat label="Outage" value={outage(i.started_at, props.simNowIso)} />
      </div>

      <div className="detail-repair">
        <div className="dr-label">ESTIMATED REPAIR</div>
        <div className="dr-value">≈ {i.repair_effort_min} min · {WORK_LABEL[i.fault_type] ?? 'field work'}</div>
      </div>

      {i.status === 'open' ? (
        i.reserved_crew_id ? (
          <div className="detail-crew">Queued → {i.reserved_crew_id} (next free)</div>
        ) : suggested ? (
          <button
            className="dispatch-btn"
            onClick={() => props.onDispatch(i.incident_id, suggested.crew.crew_id, suggested.etaMin)}
          >
            Dispatch <b>{suggested.crew.callsign}</b> · ETA {suggested.etaMin} min →
          </button>
        ) : props.reserveSuggestion ? (
          <button className="dispatch-btn reserve" onClick={() => props.onReserve(i.incident_id)}>
            Assign to next free: <b>{props.reserveSuggestion.crew_id}</b> · frees in ~{props.reserveSuggestion.freesInMin} min →
          </button>
        ) : (
          <div className="no-crew">No crew with the matching skill</div>
        )
      ) : (
        <div className="detail-crew">
          {i.crew_id} {STATUS_LABEL[i.status]?.toLowerCase()}
          {i.status === 'enroute' && i.eta_min ? ` · ETA ${i.eta_min} min` : ''}
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
