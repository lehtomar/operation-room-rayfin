import type { Crew, Incident } from '../lib/types';

const FAULT_LABEL: Record<string, string> = {
  tree_on_line: 'Puu linjalla',
  broken_pole: 'Pylväsvaurio',
  transformer_failure: 'Muuntamovika',
};
const STATUS_LABEL: Record<string, string> = {
  open: 'Avoin',
  assigned: 'Osoitettu',
  enroute: 'Matkalla',
  onsite: 'Paikalla',
  restored: 'Palautettu',
};

interface FaultDetailProps {
  incident: Incident;
  suggested: { crew: Crew; etaMin: number } | null;
  simNowIso: string | undefined;
  onDispatch: (incidentId: string, crewId: string, etaMin: number) => void;
  onClose: () => void;
}

function elapsed(startIso: string | null, nowIso: string | undefined): string {
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
          <div className="detail-type">{FAULT_LABEL[i.fault_type] ?? i.fault_type}</div>
          <div className="detail-sub">
            {i.incident_id} · syöttö {i.feeder_id} · {i.seg_id}
          </div>
        </div>
        <button className="x" onClick={props.onClose}>
          ✕
        </button>
      </div>

      <div className="detail-grid">
        <Stat label="Käyttöpaikkaa pimeänä" value={i.affected_kp.toLocaleString('fi-FI')} tone="danger" />
        <Stat label="Muuntamoa" value={String(i.affected_tr)} />
        <Stat label="Kesto" value={elapsed(i.started_at, props.simNowIso)} />
        <Stat label="Korjausarvio" value={`${i.repair_effort_min} min`} />
      </div>

      <div className="detail-status">
        <span className={`pill st-${i.status}`}>{STATUS_LABEL[i.status] ?? i.status}</span>
        {i.crew_id && <span className="assigned">Partio {i.crew_id}{i.eta_min ? ` · ETA ${i.eta_min} min` : ''}</span>}
      </div>

      {i.status === 'open' && (
        <div className="suggest">
          {suggested ? (
            <button
              className="dispatch-btn"
              onClick={() => props.onDispatch(i.incident_id, suggested.crew.crew_id, suggested.etaMin)}
            >
              Ehdota partiota: <b>{suggested.crew.callsign}</b> · ETA {suggested.etaMin} min →
            </button>
          ) : (
            <div className="no-crew">Ei vapaata sopivan taidon partiota</div>
          )}
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
