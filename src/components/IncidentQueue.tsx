import type { Crew, Incident } from '../lib/types';

const FAULT_LABEL: Record<string, string> = {
  tree_on_line: 'Tree on line',
  broken_pole: 'Broken pole',
  transformer_failure: 'Transformer failure',
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
function outLabel(mins: number): string {
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h} h ${mins % 60} min` : `${mins} min`;
}

export function IncidentQueue(props: IncidentQueueProps) {
  const { incidents, simNowIso } = props;
  const active = incidents
    .filter((i) => i.status !== 'restored')
    .map((i) => {
      const mins = elapsedMin(i.started_at, simNowIso);
      return { i, mins, impact: Math.round(i.affected_kp * Math.max(1 / 60, mins / 60)) };
    })
    .sort((a, b) => b.impact - a.impact);
  const unassigned = active.filter((a) => a.i.status === 'open').length;

  return (
    <div className="queue">
      <div className="queue-head">
        <span>INCIDENT QUEUE</span>
        <span className="queue-meta">
          {active.length} active · <span className="queue-un">{unassigned} unassigned</span>
        </span>
      </div>
      <div className="queue-note">Ranked by impact · käyttöpaikat × outage h · drag onto a crew row to assign</div>
      <div className="queue-list">
        {active.length === 0 && <div className="queue-empty">No active faults — normal operations</div>}
        {active.map(({ i, mins, impact }) => {
          const sug = props.suggestions[i.incident_id];
          const open = i.status === 'open';
          return (
            <div
              key={i.incident_id}
              className={`icard ${props.selectedId === i.incident_id ? 'sel' : ''} ${open ? 'un' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/incident', i.incident_id)}
              onClick={() => props.onSelect(i.incident_id)}
            >
              <div className="icard-top">
                <span className="icard-type">
                  {FAULT_LABEL[i.fault_type] ?? i.fault_type} — feeder {i.feeder_id}
                </span>
                <span className="icard-fid">{i.seg_id}</span>
              </div>
              <div className="icard-mid">
                <span className="icard-kp">{i.affected_kp.toLocaleString('fi-FI')} käyttöpaikkaa</span>
                <span className="icard-out">out {outLabel(mins)}</span>
                <span className="icard-impact">{impact.toLocaleString('fi-FI')} kp·h</span>
              </div>
              <div className="icard-bot">
                {open ? (
                  <>
                    <span className="pill st-open">● UNASSIGNED</span>
                    {sug ? (
                      <button
                        className="mini-dispatch"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDispatch(i.incident_id, sug.crew.crew_id, sug.etaMin);
                        }}
                      >
                        SUGGEST DISPATCH
                      </button>
                    ) : (
                      <span className="icard-nocrew">no crew</span>
                    )}
                  </>
                ) : (
                  <span className={`pill st-${i.status}`}>
                    ● {i.status === 'onsite' ? 'ON SITE' : i.status === 'enroute' ? 'EN ROUTE' : 'ASSIGNED'} — {i.crew_id}
                    {i.status === 'enroute' && i.eta_min ? ` · ETA ${i.eta_min} min` : ''}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
