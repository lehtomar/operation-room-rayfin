import { useEffect, useMemo, useRef, useState } from 'react';

import { MapView } from './components/MapView';
import { TopBar, type Kpis, type KpiSub } from './components/TopBar';
import { FaultDetail } from './components/FaultDetail';
import { IncidentQueue, type Suggestion } from './components/IncidentQueue';
import { CrewPanel } from './components/CrewPanel';
import { EventsTicker } from './components/EventsTicker';
import { createProvider, isDevMode, type DataProvider } from './data';
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
import { windAt } from './lib/wind';

const POLL_MS = 1500;

export default function App() {
  const [assets, setAssets] = useState<GridAssets | null>(null);
  const [provider, setProvider] = useState<DataProvider | null>(null);
  const [live, setLive] = useState<LiveState>({ scenario: null, wind: null, incidents: [], crews: [], events: [] });
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const optimistic = useRef<Record<string, Partial<Incident>>>({});

  useEffect(() => {
    loadGridAssets().then(setAssets).catch((e) => setError(String(e)));
    createProvider().then(setProvider).catch((e) => setError(String(e)));
  }, []);

  // poll live state
  useEffect(() => {
    if (!provider) return;
    let active = true;
    const tick = async () => {
      try {
        const s = await provider.getState();
        if (!active) return;
        const incidents = s.incidents.map((inc) => {
          const o = optimistic.current[inc.incident_id];
          if (o && inc.status !== 'open') delete optimistic.current[inc.incident_id];
          return o && inc.status === 'open' ? { ...inc, ...o } : inc;
        });
        setLive({ ...s, incidents });
        setConnected(true);
      } catch {
        if (active) setConnected(false);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [provider]);

  const fmi = useFmiWind(assets?.municipality.fmi.place ?? 'Sysmä');

  const segChildren = useMemo(
    () => (assets ? buildSegmentChildren(assets.feeders) : null),
    [assets]
  );

  const elapsedMin = useMemo(() => {
    if (!assets || !live.scenario) return 0;
    const start = new Date(assets.scenario.startWallClock).getTime();
    return (new Date(live.scenario.sim_clock).getTime() - start) / 60000;
  }, [assets, live.scenario]);

  const wind = assets && live.scenario ? windAt(assets.scenario, elapsedMin) : null;

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
    const lastRestored = restoredList
      .map((i) => i.restored_at)
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    const totalKp = assets?.topology.counts.kayttopaikat ?? 0;
    const now = live.scenario ? new Date(live.scenario.sim_clock).getTime() : 0;
    let maxOutMin = 0;
    for (const i of active) {
      if (i.started_at) maxOutMin = Math.max(maxOutMin, (now - new Date(i.started_at).getTime()) / 60000);
    }
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

  const gantt = useMemo(() => buildCrewGantt(live.events, live.crews), [live.events, live.crews]);
  const alerts = useMemo(() => toAlerts(live.events), [live.events]);
  const stormFront = useMemo(
    () => (assets ? frontAt(assets.scenario, elapsedMin) : null),
    [assets, elapsedMin]
  );

  const selectedIncident = live.incidents.find((i) => i.incident_id === selected) ?? null;
  const suggestions: Record<string, Suggestion | null> = useMemo(() => {
    if (!assets) return {};
    const out: Record<string, Suggestion | null> = {};
    for (const i of live.incidents) {
      if (i.status === 'open') out[i.incident_id] = suggestCrew(assets, live.crews, i);
    }
    return out;
  }, [assets, live.crews, live.incidents]);
  const suggested = selectedIncident ? suggestions[selectedIncident.incident_id] ?? null : null;

  async function dispatch(incidentId: string, crewId: string, etaMin: number) {
    if (!provider) return;
    optimistic.current[incidentId] = { status: 'assigned', crew_id: crewId, eta_min: etaMin };
    setLive((prev) => ({
      ...prev,
      incidents: prev.incidents.map((i) =>
        i.incident_id === incidentId ? { ...i, status: 'assigned', crew_id: crewId, eta_min: etaMin } : i
      ),
    }));
    try {
      await provider.dispatch(incidentId, crewId, etaMin);
    } catch (e) {
      setError(String(e));
    }
  }

  // Drag incident card onto a crew row → dispatch (same path as suggest→confirm).
  function assignToCrew(incidentId: string, crewId: string) {
    if (!assets) return;
    const fault = assets.scenario.faults.find((f) => f.incident_id === incidentId);
    const crew = live.crews.find((c) => c.crew_id === crewId);
    if (!fault || !crew) return;
    const eta = etaMinutes(parseFloat(crew.lat), parseFloat(crew.lon), fault.lat, fault.lon);
    dispatch(incidentId, crewId, eta);
  }

  if (error) return <div className="fullscreen error">Error: {error}</div>;
  if (!assets) return <div className="fullscreen">Loading grid…</div>;

  return (
    <div className="app">
      <TopBar
        scenario={live.scenario}
        kpis={kpis}
        sub={sub}
        stormName={assets.scenario.storm.name}
        wind={wind}
        fmiWind={fmi}
        connected={connected}
        canReset={provider?.canReset ?? false}
        onPlay={() => provider?.play()}
        onPause={() => provider?.pause()}
        onSpeed={(v) => provider?.setSpeed(v)}
        onReset={() => {
          provider?.reset();
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
          simNowIso={live.scenario?.sim_clock}
          selectedId={selected}
          onSelect={setSelected}
          onDispatch={dispatch}
        />
        <CrewPanel
          crews={live.crews}
          gantt={gantt}
          simClockIso={live.scenario?.sim_clock}
          shiftStartIso={assets.scenario.startWallClock}
          shiftEndIso={new Date(new Date(assets.scenario.startWallClock).getTime() + 8 * 3600_000).toISOString()}
          onAssign={assignToCrew}
        />
        {selectedIncident && (
          <FaultDetail
            incident={selectedIncident}
            suggested={suggested}
            simNowIso={live.scenario?.sim_clock}
            onDispatch={dispatch}
            onClose={() => setSelected(null)}
          />
        )}
        {isDevMode() && !connected && (
          <div className="hint">
            Start the simulator: <code>python -m simulator run --serve --play</code>
          </div>
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
    if (c.status !== 'idle') continue;
    if (!c.skills.split(',').includes(required)) continue;
    const km = haversineKm(parseFloat(c.lat), parseFloat(c.lon), fault.lat, fault.lon);
    if (km < bestKm) {
      bestKm = km;
      best = { crew: c, etaMin: etaMinutes(parseFloat(c.lat), parseFloat(c.lon), fault.lat, fault.lon) };
    }
  }
  return best;
}
