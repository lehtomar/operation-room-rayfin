import { useEffect, useMemo, useRef, useState } from 'react';

import { MapView } from './components/MapView';
import { TopBar, type Kpis, type KpiSub } from './components/TopBar';
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
import type { Crew, Incident, LiveState, ScenarioMeta } from './lib/types';
import { SimDriver } from './sim/driver';

const EMPTY: LiveState = { scenario: null, wind: null, incidents: [], crews: [], events: [] };

export default function App() {
  const [assets, setAssets] = useState<GridAssets | null>(null);
  const [live, setLive] = useState<LiveState>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
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
  const elapsedMin = live.scenario?.elapsed_min ?? 0;

  const de = useMemo(
    () => (assets ? deEnergizedFromIncidents(assets.topology, live.incidents) : null),
    [assets, live.incidents]
  );
  const deadSegments = useMemo(
    () => (segChildren ? deadSegmentsFromIncidents(segChildren, live.incidents) : new Set<string>()),
    [segChildren, live.incidents]
  );
  const highlightSegments = useMemo(() => {
    if (!segChildren || !selected) return new Set<string>();
    const inc = live.incidents.find((i) => i.incident_id === selected);
    return inc ? new Set(subtreeSegments(segChildren, inc.seg_id)) : new Set<string>();
  }, [segChildren, selected, live.incidents]);

  const kpis: Kpis = useMemo(() => {
    const active = live.incidents.filter((i) => i.status !== 'restored');
    const comp =
      assets && live.scenario
        ? projectedCompensationEur(
            live.incidents,
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
    const active = live.incidents.filter((i) => i.status !== 'restored');
    const restoredList = live.incidents.filter((i) => i.status === 'restored');
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
  const stormFront = useMemo(() => (assets ? frontAt(assets.scenario, elapsedMin) : null), [assets, elapsedMin]);

  const selectedIncident = live.incidents.find((i) => i.incident_id === selected) ?? null;
  const suggestions: Record<string, Suggestion | null> = useMemo(() => {
    if (!assets) return {};
    const out: Record<string, Suggestion | null> = {};
    for (const i of live.incidents) if (i.status === 'open') out[i.incident_id] = suggestCrew(assets, live.crews, i);
    return out;
  }, [assets, live.crews, live.incidents]);
  const suggested = selectedIncident ? suggestions[selectedIncident.incident_id] ?? null : null;

  // For open incidents with no idle matching crew, preview which busy crew
  // frees next so the dispatcher can queue it ("assign to next available").
  const reserveSuggestions: Record<string, ReserveHint | null> = useMemo(() => {
    const d = driverRef.current;
    if (!d) return {};
    const out: Record<string, ReserveHint | null> = {};
    for (const i of live.incidents) {
      if (i.status === 'open' && !suggestions[i.incident_id] && !i.reserved_crew_id) {
        out[i.incident_id] = d.reserveSuggestion(i.incident_id);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.incidents, suggestions]);
  const reserveSuggested = selectedIncident ? reserveSuggestions[selectedIncident.incident_id] ?? null : null;

  function drive(fn: (d: SimDriver) => void) {
    const d = driverRef.current;
    if (!d) return;
    fn(d);
    setLive(d.snapshot());
  }
  const dispatch = (incidentId: string, crewId: string) => drive((d) => d.assign(incidentId, crewId));
  const reserve = (incidentId: string) => drive((d) => d.reserveNextFree(incidentId));

  if (error) return <div className="fullscreen error">Error: {error}</div>;
  if (!assets) return <div className="fullscreen">Loading grid…</div>;

  return (
    <div className="app">
      <TopBar
        scenario={live.scenario}
        kpis={kpis}
        sub={sub}
        stormName={assets.scenario.storm.name}
        wind={live.wind}
        fmiWind={fmi}
        auto={auto}
        onToggleAuto={() => setAuto((v) => !v)}
        onPlay={() => drive((d) => d.play())}
        onPause={() => drive((d) => d.pause())}
        onSpeed={(v) => drive((d) => d.setSpeed(v))}
        onReset={() => {
          drive((d) => d.reset());
          setSelected(null);
        }}
      />
      <div className="stage">
        <MapView
          assets={assets}
          deadSegments={deadSegments}
          deadTransformers={de?.transformers ?? new Set()}
          highlightSegments={highlightSegments}
          incidents={live.incidents}
          crews={live.crews}
          stormFront={stormFront}
          selectedIncidentId={selected}
          onSelectFault={setSelected}
        />
        <IncidentQueue
          incidents={live.incidents}
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

/** Interpolate the storm front line at the given elapsed minute. */
function frontAt(meta: ScenarioMeta, elapsedMin: number): [number, number][] | null {
  const fr = meta.storm.front;
  if (!fr || fr.length === 0) return null;
  let prev = fr[0];
  for (const p of fr) {
    if (p.offsetMin <= elapsedMin) {
      prev = p;
    } else {
      const span = p.offsetMin - prev.offsetMin || 1;
      const f = (elapsedMin - prev.offsetMin) / span;
      return prev.line.map((pt, idx) => {
        const nxt = p.line[idx] ?? pt;
        return [pt[0] + (nxt[0] - pt[0]) * f, pt[1] + (nxt[1] - pt[1]) * f] as [number, number];
      });
    }
  }
  return prev.line;
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
