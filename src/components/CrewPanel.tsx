import { useState } from 'react';
import type { Crew } from '../lib/types';
import type { GanttBlock } from '../lib/events';

const STATUS_LABEL: Record<string, string> = {
  idle: 'AVAILABLE · depot',
  enroute: 'EN ROUTE',
  onsite: 'ON SITE',
  returning: 'RETURNING',
  offshift: 'OFF SHIFT',
};
const SKILL_LABEL: Record<string, string> = { hv: 'HV WORK', tree: 'TREE CLEARING', line: 'LINE WORK' };

interface CrewPanelProps {
  crews: Crew[];
  gantt: Map<string, GanttBlock[]>;
  simClockIso: string | undefined;
  shiftStartIso: string;
  shiftEndIso: string;
  onAssign: (incidentId: string, crewId: string) => void;
}

function frac(ms: number, s: number, e: number): number {
  return Math.min(1, Math.max(0, (ms - s) / (e - s)));
}

export function CrewPanel(props: CrewPanelProps) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  const s = new Date(props.shiftStartIso).getTime();
  const e = new Date(props.shiftEndIso).getTime();
  const now = props.simClockIso ? new Date(props.simClockIso).getTime() : s;
  const nowF = frac(now, s, e);
  const hours: number[] = [];
  for (let h = 14; h <= 22; h++) hours.push(h);
  const dispatched = props.crews.filter((c) => c.status !== 'idle' && c.status !== 'offshift').length;

  return (
    <div className="crewpanel">
      <div className="crew-head">
        <span>FIELD CREWS</span>
        <span className="crew-meta">
          {dispatched}/{props.crews.length} dispatched · shift 14:00–22:00
        </span>
      </div>
      <div className="crew-grid">
        <div className="crew-colhead">CREW</div>
        <div className="crew-colhead">SKILLS</div>
        <div className="crew-colhead">STATUS</div>
        <div className="crew-ruler">
          {hours.map((h) => (
            <div key={h} className="ruler-h" style={{ left: `${frac(new Date(props.shiftStartIso).setHours(h, 0, 0, 0), s, e) * 100}%` }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
          <div className="ruler-now" style={{ left: `${nowF * 100}%` }} />
        </div>

        {props.crews.map((c) => {
          const blocks = props.gantt.get(c.crew_id) ?? [];
          return [
            <div key={`${c.crew_id}-id`} className="cg-id">
              <span className={`crew-dot st-dot-${c.status}`} />
              {c.callsign}
            </div>,
            <div key={`${c.crew_id}-sk`} className="cg-skills">
              {c.skills.split(',').map((sk) => (
                <span key={sk} className={`skill sk-${sk}`}>{SKILL_LABEL[sk] ?? sk}</span>
              ))}
            </div>,
            <div key={`${c.crew_id}-st`} className="cg-status">
              <span className={`st-text st-t-${c.status}`}>
                {STATUS_LABEL[c.status] ?? c.status}
                {c.current_incident_id && c.status !== 'idle' ? ` → ${c.current_incident_id}` : ''}
              </span>
            </div>,
            <div
              key={`${c.crew_id}-tl`}
              className={`cg-track ${dragOver === c.crew_id ? 'drop' : ''}`}
              onDragOver={(ev) => {
                ev.preventDefault();
                setDragOver(c.crew_id);
              }}
              onDragLeave={() => setDragOver((p) => (p === c.crew_id ? null : p))}
              onDrop={(ev) => {
                ev.preventDefault();
                setDragOver(null);
                const id = ev.dataTransfer.getData('text/incident');
                if (id) props.onAssign(id, c.crew_id);
              }}
            >
              {blocks.map((b, idx) => {
                const end = b.endMs ?? now;
                const left = frac(b.startMs, s, e) * 100;
                const width = Math.max(1.5, (frac(end, s, e) - frac(b.startMs, s, e)) * 100);
                const onsiteLeft = b.onsiteMs ? (frac(b.onsiteMs, s, e) - frac(b.startMs, s, e)) * 100 : width;
                const done = b.endMs != null;
                return (
                  <div key={idx} className={`gblock ${done ? 'done' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${b.incident} · ${b.feeder ?? ''}`}>
                    <div className="gb-enroute" style={{ width: `${(onsiteLeft / width) * 100}%` }} />
                    <span className="gb-label">{b.feeder ?? b.incident}</span>
                  </div>
                );
              })}
              <div className="ruler-now" style={{ left: `${nowF * 100}%` }} />
            </div>,
          ];
        })}
      </div>
    </div>
  );
}
