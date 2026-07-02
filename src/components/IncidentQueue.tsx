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

export interface Suggestion {
  crew: Crew;
  etaMin: number;
}

interface IncidentQueueProps {
  incidents: Incident[];
  suggestions: Record<string, Suggestion | null>;
  simNowIso: string | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDispatch: (incidentId: string, crewId: string, etaMin: number) => void;
}

function elapsedMin(startIso: string | null, nowIso: string | undefined): number {
  if (!startIso || !nowIso) return 0;
  return Math.max(0, Math.round((new Date(nowIso).getTime() - new Date(startIso).getTime()) / 60000));
}

function elapsedLabel(mins: number): string {
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h} h ${mins % 60} min` : `${mins} min`;
}

export function IncidentQueue(props: IncidentQueueProps) {
  const { incidents, simNowIso } = props;
  const active = incidents
    .filter((i) => i.status !== 'restored')
    .map((i) => {
      const mins = elapsedMin(i.started_at, simNowIso);
      return { i, mins, impact: i.affected_kp * Math.max(1, mins) };
    })
    .sort((a, b) => b.impact - a.impact);

  return (
    <div className="queue">
      <div className="queue-head">
        Vikajono <span className="queue-count">{active.length}</span>
      </div>
      <div className="queue-list">
        {active.length === 0 && <div className="queue-empty">Ei aktiivisia vikoja</div>}
        {active.map(({ i, mins }) => {
          const sug = props.suggestions[i.incident_id];
          return (
            <div
              key={i.incident_id}
              className={`icard ${props.selectedId === i.incident_id ? 'sel' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/incident', i.incident_id)}
              onClick={() => props.onSelect(i.incident_id)}
            >
              <div className="icard-top">
                <span className="icard-type">{FAULT_LABEL[i.fault_type] ?? i.fault_type}</span>
                <span className={`pill st-${i.status}`}>{STATUS_LABEL[i.status] ?? i.status}</span>
              </div>
              <div className="icard-mid">
                <span className="icard-kp">{i.affected_kp.toLocaleString('fi-FI')} käyttöpaikkaa</span>
                <span className="icard-feeder">syöttö {i.feeder_id}</span>
              </div>
              <div className="icard-bot">
                <span className="icard-timer">⏱ {elapsedLabel(mins)}</span>
                {i.status === 'open' &&
                  (sug ? (
                    <button
                      className="mini-dispatch"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onDispatch(i.incident_id, sug.crew.crew_id, sug.etaMin);
                      }}
                    >
                      → {sug.crew.callsign} ({sug.etaMin}′)
                    </button>
                  ) : (
                    <span className="icard-nocrew">ei partiota</span>
                  ))}
                {i.crew_id && i.status !== 'open' && <span className="icard-crew">{i.crew_id}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
