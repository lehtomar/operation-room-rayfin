import { useEffect, useRef, useState, type FormEvent } from 'react';

import { createCrewRepository, type CrewRepository } from '../data/crewRepository';
import type { CrewDefinition } from '../lib/types';

const SKILLS = [
  ['line', 'Line work'],
  ['tree', 'Tree clearing'],
  ['hv', 'HV work'],
] as const;

interface Props {
  initialCrews: CrewDefinition[];
  activeCrews: CrewDefinition[] | null;
  onCrewsChange: (crews: CrewDefinition[]) => void;
}

function inputDate(iso: string): string {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function emptyCrew(initial: CrewDefinition[]): CrewDefinition {
  const basis = initial[0];
  const now = new Date();
  const shiftStart = basis?.shiftStart ?? now.toISOString();
  return {
    crew_id: '',
    callsign: '',
    skills: ['line'],
    depot: basis?.depot ?? { lat: 61.5, lon: 25.7 },
    shiftStart,
    shiftEnd: basis?.shiftEnd ?? new Date(now.getTime() + 8 * 3600_000).toISOString(),
  };
}

function sameRoster(left: CrewDefinition[] | null, right: CrewDefinition[]): boolean {
  if (!left || left.length !== right.length) return false;
  const normalize = (crew: CrewDefinition) => ({
    id: crew.id,
    crew_id: crew.crew_id,
    callsign: crew.callsign,
    skills: [...crew.skills].sort(),
    depot: crew.depot,
    shiftStart: crew.shiftStart,
    shiftEnd: crew.shiftEnd,
  });
  return JSON.stringify(left.map(normalize)) === JSON.stringify(right.map(normalize));
}

export function CrewManagement({ initialCrews, activeCrews, onCrewsChange }: Props) {
  const repository = useRef<CrewRepository | null>(null);
  const activeCrewsRef = useRef(activeCrews);
  const [crews, setCrews] = useState<CrewDefinition[]>([]);
  const [draft, setDraft] = useState<CrewDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  activeCrewsRef.current = activeCrews;

  async function refresh(): Promise<void> {
    if (!repository.current) return;
    const rows = await repository.current.list();
    setCrews(rows);
    if (rows.length > 0) onCrewsChange(rows);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const repo = await createCrewRepository();
        if (cancelled) return;
        repository.current = repo;
        const rows = await repo.list();
        if (cancelled) return;
        setCrews(rows);
        if (rows.length > 0 && !sameRoster(activeCrewsRef.current, rows)) onCrewsChange(rows);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onCrewsChange]);

  async function initializeRoster(): Promise<void> {
    if (!repository.current) return;
    setSaving(true);
    setError(null);
    try {
      for (const crew of initialCrews) await repository.current.create(crew);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft || !repository.current) return;
    const duplicate = crews.some((crew) => crew.crew_id === draft.crew_id && crew.id !== draft.id);
    if (!draft.crew_id.trim() || !draft.callsign.trim()) {
      setError('Crew ID and callsign are required.');
      return;
    }
    if (duplicate) {
      setError(`Crew ID ${draft.crew_id} is already in use.`);
      return;
    }
    if (draft.skills.length === 0) {
      setError('Select at least one skill.');
      return;
    }
    if (!Number.isFinite(draft.depot.lat) || !Number.isFinite(draft.depot.lon)) {
      setError('Depot latitude and longitude must be valid numbers.');
      return;
    }
    if (new Date(draft.shiftEnd).getTime() <= new Date(draft.shiftStart).getTime()) {
      setError('Shift end must be after shift start.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (draft.id) await repository.current.update(draft);
      else await repository.current.create(draft);
      await refresh();
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function remove(crew: CrewDefinition): Promise<void> {
    if (crews.length === 1) {
      setError('At least one crew is required for dispatch operations.');
      return;
    }
    if (!crew.id || !repository.current || !window.confirm(`Delete crew ${crew.callsign}?`)) return;
    setSaving(true);
    setError(null);
    try {
      await repository.current.delete(crew.id);
      await refresh();
      if (draft?.id === crew.id) setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="crew-admin">
      <div className="admin-head">
        <div>
          <div className="admin-kicker">RESOURCE ADMINISTRATION</div>
          <h1>Field crews</h1>
          <p>Manage crew identities, skills, depots and shifts. Roster changes reset the operations board.</p>
        </div>
        <button className="admin-primary" onClick={() => setDraft(emptyCrew(initialCrews))} disabled={loading || saving}>
          Add crew
        </button>
      </div>

      {error && <div className="admin-error">{error}</div>}
      {loading ? (
        <div className="admin-empty">Loading crew roster…</div>
      ) : crews.length === 0 ? (
        <div className="admin-empty">
          <strong>No managed crews</strong>
          <span>Initialize the database from the bundled scenario roster or add crews individually.</span>
          <button className="admin-secondary" onClick={initializeRoster} disabled={saving || initialCrews.length === 0}>
            Initialize scenario roster
          </button>
        </div>
      ) : (
        <div className="crew-admin-table">
          <div className="cat-head">CREW ID</div>
          <div className="cat-head">CALLSIGN</div>
          <div className="cat-head">SKILLS</div>
          <div className="cat-head">DEPOT</div>
          <div className="cat-head">SHIFT</div>
          <div className="cat-head" />
          {crews.map((crew) => (
            <div className="cat-row" key={crew.id ?? crew.crew_id}>
              <div className="cat-id">{crew.crew_id}</div>
              <div className="cat-callsign">{crew.callsign}</div>
              <div className="cat-skills">{crew.skills.map((skill) => <span className={`skill sk-${skill}`} key={skill}>{skill.toUpperCase()}</span>)}</div>
              <div className="cat-depot">{crew.depot.lat.toFixed(4)}, {crew.depot.lon.toFixed(4)}</div>
              <div className="cat-shift">{new Date(crew.shiftStart).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–{new Date(crew.shiftEnd).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
              <div className="cat-actions">
                <button onClick={() => setDraft(crew)}>Edit</button>
                <button className="danger" onClick={() => void remove(crew)} disabled={saving}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <form className="crew-form" onSubmit={save}>
          <div className="form-title">{draft.id ? `Edit ${draft.callsign}` : 'Add field crew'}</div>
          <label>Crew ID<input value={draft.crew_id} maxLength={20} onChange={(e) => setDraft({ ...draft, crew_id: e.target.value })} /></label>
          <label>Callsign<input value={draft.callsign} maxLength={40} onChange={(e) => setDraft({ ...draft, callsign: e.target.value })} /></label>
          <fieldset>
            <legend>Skills</legend>
            {SKILLS.map(([value, label]) => (
              <label className="skill-check" key={value}>
                <input
                  type="checkbox"
                  checked={draft.skills.includes(value)}
                  onChange={(e) => setDraft({
                    ...draft,
                    skills: e.target.checked ? [...draft.skills, value] : draft.skills.filter((skill) => skill !== value),
                  })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label>Depot latitude<input type="number" step="0.000001" value={draft.depot.lat} onChange={(e) => setDraft({ ...draft, depot: { ...draft.depot, lat: e.target.valueAsNumber } })} /></label>
          <label>Depot longitude<input type="number" step="0.000001" value={draft.depot.lon} onChange={(e) => setDraft({ ...draft, depot: { ...draft.depot, lon: e.target.valueAsNumber } })} /></label>
          <label>Shift start<input required type="datetime-local" value={inputDate(draft.shiftStart)} onChange={(e) => e.target.value && setDraft({ ...draft, shiftStart: new Date(e.target.value).toISOString() })} /></label>
          <label>Shift end<input required type="datetime-local" value={inputDate(draft.shiftEnd)} onChange={(e) => e.target.value && setDraft({ ...draft, shiftEnd: new Date(e.target.value).toISOString() })} /></label>
          <div className="form-actions">
            <button type="button" className="admin-secondary" onClick={() => setDraft(null)}>Cancel</button>
            <button type="submit" className="admin-primary" disabled={saving}>{saving ? 'Saving…' : 'Save crew'}</button>
          </div>
        </form>
      )}
    </main>
  );
}
