import { useEffect, useMemo, useRef, useState } from 'react';

import { MapView } from './components/MapView';
import { TopBar, type Kpis, type KpiSub } from './components/TopBar';
import { SimControls } from './components/SimControls';
import { FaultDetail } from './components/FaultDetail';
import { IncidentQueue, type Suggestion, type ReserveHint } from './components/IncidentQueue';
import { CrewPanel } from './components/CrewPanel';
import { EventsTicker } from './components/EventsTicker';
import { loadGridAssets, type GridAssets } from './grid/assets';
import { useFmiWind } from './hooks/useFmiWind';
import { haversineKm, etaMinutes } from './lib/geo';
import { projectedCompensationEur } from './lib/compensation';
import { buildCrewGantt, toAlerts } from './lib/events';
import {
  buildSegmentChildren,
  deEnergizedFromIncidents,
  deadSegmentsFromIncidents,
  subtreeSegments,
} from './lib/topology';
import type { Crew, Incident, LiveState } from './lib/types';
import { SimDriver } from './sim/driver';

const EMPTY: LiveState = { scenario: null, wind: null, incidents: [], crews: [], events: [] };

export default function App() {
  const [assets, setAssets] = useState<GridAssets | null>(null);
  const [live, setLive] = useState<LiveState>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [mode, setMode] = useState<'storm' | 'live'>('storm');
  const driverRef = useRef<SimDriver | null>(null);

  useEffect(() => {
    loadGridAssets().then(setAssets).catch((e) => setError(String(e)));
  }, []);

  // The simulation runs entirely in the browser from the bundled scenario +
  // topology, so the deployed app animates with no backend dependency.
  useEffect(() => {
    if (!assets) return;
    const d = new SimDriver(assets, null);
    d.setAuto(auto);
    driverRef.current = d;
    void d.init();
    setLive(d.snapshot());
    const id = setInterval(() => {
      d.tick(1);
      const snap = d.snapshot();
      setLive(snap);
      if (import.meta.env.DEV) (window as unknown as { __live?: LiveState }).__live = snap;
    }, 1000);
    return () => {
      clearInterval(id);
      driverRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  useEffect(() => {
    driverRef.current?.setAuto(auto);
  }, [auto]);

  const fmi = useFmiWind(assets?.municipality.fmi.place ?? 'Sysmä');

  const segChildren = useMemo(() => (assets ? buildSegmentChildren(assets.feeders) : null), [assets]);

  // Scheduled maintenance occupies crews but is not an electrical fault — keep
  // it out of the fault/de-energization/queue logic (it shows only on the Gantt).
  const faults = useMemo(
    () => live.incidents.filter((i) => i.fault_type !== 'scheduled_maintenance'),
    [live.incidents]
  );

  const de = useMemo(
    () => (assets ? deEnergizedFromIncidents(assets.topology, faults) : null),
    [assets, faults]
  );
  const deadSegments = useMemo(
    () => (segChildren ? deadSegmentsFromIncidents(segChildren, faults) : new Set<string>()),
    [segChildren, faults]
  );
  const highlightSegments = useMemo(() => {
    if (!segChildren || !selected) return new Set<string>();
    const inc = faults.find((i) => i.incident_id === selected);
    return inc ? new Set(subtreeSegments(segChildren, inc.seg_id)) : new Set<string>();
  }, [segChildren, selected, faults]);

  const kpis: Kpis = useMemo(() => {
    const active = faults.filter((i) => i.status !== 'restored');
    const comp =
      assets && live.scenario
        ? projectedCompensationEur(
            faults,
            live.scenario.sim_clock,
            assets.municipality.compensation.assumedAnnualDistributionFeeEur,
            assets.municipality.compensation.tiers,
            assets.municipality.compensation.capPct
          )
        : 0;
    return {
      customersOut: de?.customersOut ?? 0,
      activeFaults: active.length,
      crewsDispatched: live.crews.filter((c) => c.status !== 'idle' && c.status !== 'offshift').length,
      compensationEur: comp,
    };
  }, [live, de, assets]);

  const sub: KpiSub = useMemo(() => {
    const active = faults.filter((i) => i.status !== 'restored');
    const restoredList = faults.filter((i) => i.status === 'restored');
    const lastRestored = restoredList.map((i) => i.restored_at).filter(Boolean).sort().pop() ?? null;
    const totalKp = assets?.topology.counts.kayttopaikat ?? 0;
    const now = live.scenario ? new Date(live.scenario.sim_clock).getTime() : 0;
    let maxOutMin = 0;
    for (const i of active) if (i.started_at) maxOutMin = Math.max(maxOutMin, (now - new Date(i.started_at).getTime()) / 60000);
    return {
      totalKp,
      pctOut: totalKp ? (kpis.customersOut / totalKp) * 100 : 0,
      unassigned: active.filter((i) => i.status === 'open').length,
      restored: restoredList.length,
      lastRestored: lastRestored as string | null,
      crewsTotal: live.crews.length,
      crewsAvailable: live.crews.filter((c) => c.status === 'idle').length,
      minsToFirstTier: active.length ? Math.max(0, Math.round(12 * 60 - maxOutMin)) : null,
    };
  }, [live, assets, kpis.customersOut]);

  const gantt = useMemo(() => buildCrewGantt(live.events, live.crews, live.incidents), [live.events, live.crews, live.incidents]);
  const alerts = useMemo(() => toAlerts(live.events), [live.events]);

  const selectedIncident = faults.find((i) => i.incident_id === selected) ?? null;
  const suggestions: Record<string, Suggestion | null> = useMemo(() => {
    if (!assets) return {};
    const out: Record<string, Suggestion | null> = {};
    for (const i of faults) if (i.status === 'open') out[i.incident_id] = suggestCrew(assets, live.crews, i);
    return out;
  }, [assets, live.crews, faults]);
  const suggested = selectedIncident ? suggestions[selectedIncident.incident_id] ?? null : null;

  // For open incidents with no idle matching crew, preview which busy crew
  // frees next so the dispatcher can queue it ("assign to next available").
  const reserveSuggestions: Record<string, ReserveHint | null> = useMemo(() => {
    const d = driverRef.current;
    if (!d) return {};
    const out: Record<string, ReserveHint | null> = {};
    for (const i of faults) {
      if (i.status === 'open' && !suggestions[i.incident_id] && !i.reserved_crew_id) {
        out[i.incident_id] = d.reserveSuggestion(i.incident_id);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faults, suggestions]);
  const reserveSuggested = selectedIncident ? reserveSuggestions[selectedIncident.incident_id] ?? null : null;

  function drive(fn: (d: SimDriver) => void) {
    const d = driverRef.current;
    if (!d) return;
    fn(d);
    setLive(d.snapshot());
  }
  const dispatch = (incidentId: string, crewId: string) => drive((d) => d.assign(incidentId, crewId));
  const reserve = (incidentId: string) => drive((d) => d.reserveNextFree(incidentId));

  // Switch between the recorded storm replay and live/normal operations.
  function changeMode(m: 'storm' | 'live') {
    if (m === mode) return;
    setMode(m);
    setSelected(null);
    drive((d) => d.setMode(m)); // storm ⇄ live: reset + (live) seed normal-ops board
  }

  if (error) return <div className="fullscreen error">Error: {error}</div>;
  if (!assets) return <div className="fullscreen">Loading grid…</div>;

  return (
    <div className="app">
      <TopBar
        scenario={live.scenario}
        kpis={kpis}
        sub={sub}
        wind={live.wind}
        fmiWind={fmi}
        mode={mode}
        onMode={changeMode}
      />
      <div className="stage">
        <MapView
          assets={assets}
          deadSegments={deadSegments}
          deadTransformers={de?.transformers ?? new Set()}
          highlightSegments={highlightSegments}
          incidents={faults}
          crews={live.crews}
          mode={mode}
          stormElapsedMs={(live.scenario?.elapsed_min ?? 0) * 60000}
          stormDurationMs={assets.scenario.simDurationMin * 60000}
          selectedIncidentId={selected}
          onSelectFault={setSelected}
        />
        {mode === 'storm' && (
          <SimControls
            scenario={live.scenario}
            auto={auto}
            onPlay={() => drive((d) => d.play())}
            onPause={() => drive((d) => d.pause())}
            onSpeed={(v) => drive((d) => d.setSpeed(v))}
            onToggleAuto={() => setAuto((v) => !v)}
            onReset={() => {
              drive((d) => d.reset());
              setSelected(null);
            }}
          />
        )}
        <IncidentQueue
          incidents={faults}
          suggestions={suggestions}
          reserveSuggestions={reserveSuggestions}
          simNowIso={live.scenario?.sim_clock}
          selectedId={selected}
          onSelect={setSelected}
          onDispatch={(incidentId, crewId) => dispatch(incidentId, crewId)}
          onReserve={reserve}
        />
        <CrewPanel
          crews={live.crews}
          gantt={gantt}
          simClockIso={live.scenario?.sim_clock}
          shiftStartIso={assets.scenario.startWallClock}
          shiftEndIso={new Date(new Date(assets.scenario.startWallClock).getTime() + 8 * 3600_000).toISOString()}
          onAssign={(incidentId, crewId) => dispatch(incidentId, crewId)}
        />
        {selectedIncident && (
          <FaultDetail
            incident={selectedIncident}
            suggested={suggested}
            reserveSuggestion={reserveSuggested}
            simNowIso={live.scenario?.sim_clock}
            onDispatch={(incidentId, crewId) => dispatch(incidentId, crewId)}
            onReserve={reserve}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      <EventsTicker alerts={alerts} />
    </div>
  );
}

function suggestCrew(
  assets: GridAssets,
  crews: Crew[],
  incident: Incident
): { crew: Crew; etaMin: number } | null {
  const fault = assets.scenario.faults.find((f) => f.incident_id === incident.incident_id);
  if (!fault) return null;
  const required = fault.requiredSkill ?? 'line';
  let best: { crew: Crew; etaMin: number } | null = null;
  let bestKm = Infinity;
  for (const c of crews) {
    if (c.status !== 'idle' || !c.skills.split(',').includes(required)) continue;
    const km = haversineKm(parseFloat(c.lat), parseFloat(c.lon), fault.lat, fault.lon);
    if (km < bestKm) {
      bestKm = km;
      best = { crew: c, etaMin: etaMinutes(parseFloat(c.lat), parseFloat(c.lon), fault.lat, fault.lon) };
    }
  }
  return best;
}
