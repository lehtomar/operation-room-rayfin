import { useState } from 'react';
import type { Crew } from '../lib/types';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Vapaa',
  enroute: 'Matkalla',
  onsite: 'Paikalla',
  returning: 'Paluu',
  offshift: 'Vuoron ulkop.',
};
const SKILL_LABEL: Record<string, string> = { hv: 'SJ', tree: 'Puu', line: 'Linja' };

interface CrewPanelProps {
  crews: Crew[];
  simClockIso: string | undefined;
  shiftStartIso: string;
  shiftEndIso: string;
  onAssign: (incidentId: string, crewId: string) => void;
}

function nowFrac(nowIso: string | undefined, startIso: string, endIso: string): number {
  if (!nowIso) return 0;
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  const n = new Date(nowIso).getTime();
  return Math.min(1, Math.max(0, (n - s) / (e - s)));
}

export function CrewPanel(props: CrewPanelProps) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  const frac = nowFrac(props.simClockIso, props.shiftStartIso, props.shiftEndIso);

  return (
    <div className="crewpanel">
      <div className="crew-head">Partiot · vuoro 14–22</div>
      <div className="crew-rows">
        {props.crews.map((c) => {
          const busy = c.status !== 'idle' && c.status !== 'offshift';
          return (
            <div
              key={c.crew_id}
              className={`crow ${dragOver === c.crew_id ? 'drop' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(c.crew_id);
              }}
              onDragLeave={() => setDragOver((p) => (p === c.crew_id ? null : p))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData('text/incident');
                if (id) props.onAssign(id, c.crew_id);
              }}
            >
              <div className="crow-id">
                <span className={`crew-dot st-dot-${c.status}`} />
                {c.callsign}
              </div>
              <div className="crow-skills">
                {c.skills.split(',').map((s) => (
                  <span key={s} className={`skill sk-${s}`}>
                    {SKILL_LABEL[s] ?? s}
                  </span>
                ))}
              </div>
              <div className="crow-status">
                <span className={`pill st-${c.status === 'idle' ? 'restored' : c.status}`}>
                  {STATUS_LABEL[c.status] ?? c.status}
                </span>
                {c.current_incident_id && <span className="crow-inc">{c.current_incident_id}</span>}
              </div>
              <div className="crow-timeline">
                <div className="tl-track">
                  {busy && (
                    <div
                      className="tl-block"
                      style={{ left: `${Math.max(0, frac * 100 - 6)}%`, width: '10%' }}
                    />
                  )}
                  <div className="tl-now" style={{ left: `${frac * 100}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
