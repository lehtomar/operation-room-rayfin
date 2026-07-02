import { useEffect, useMemo, useRef, useState } from 'react';

import { MapView } from './components/MapView';
import { TopBar, type Kpis } from './components/TopBar';
import { FaultDetail } from './components/FaultDetail';
import { IncidentQueue, type Suggestion } from './components/IncidentQueue';
import { CrewPanel } from './components/CrewPanel';
import { createProvider, isDevMode, type DataProvider } from './data';
import { loadGridAssets, type GridAssets } from './grid/assets';
import { useFmiWind } from './hooks/useFmiWind';
import { haversineKm, etaMinutes } from './lib/geo';
import { projectedCompensationEur } from './lib/compensation';
import {
  buildSegmentChildren,
  deEnergizedFromIncidents,
  deadSegmentsFromIncidents,
  subtreeSegments,
} from './lib/topology';
import type { Crew, Incident, LiveState } from './lib/types';
import { windAt } from './lib/wind';

const POLL_MS = 1500;

export default function App() {
  const [assets, setAssets] = useState<GridAssets | null>(null);
  const [provider, setProvider] = useState<DataProvider | null>(null);
  const [live, setLive] = useState<LiveState>({ scenario: null, wind: null, incidents: [], crews: [] });
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

  if (error) return <div className="fullscreen error">Virhe: {error}</div>;
  if (!assets) return <div className="fullscreen">Ladataan verkkoa…</div>;

  return (
    <div className="app">
      <TopBar
        scenario={live.scenario}
        kpis={kpis}
        stormName={assets.scenario.storm.name}
        wind={wind}
        fmiWind={fmi}
        connected={connected}
        canReset={provider?.canReset ?? false}
        onPlay={() => provider?.play()}
        onPause={() => provider?.pause()}
        onSpeed={(v) => provider?.setSpeed(v)}
        onReset={() => provider?.reset()}
      />
      <div className="stage">
        <MapView
          assets={assets}
          deadSegments={deadSegments}
          deadTransformers={de?.transformers ?? new Set()}
          highlightSegments={highlightSegments}
          incidents={live.incidents}
          crews={live.crews}
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
            Kytke simulaattori: <code>python -m simulator run --serve --play</code>
          </div>
        )}
      </div>
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
