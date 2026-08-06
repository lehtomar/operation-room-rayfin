import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FeatureCollection, Feature } from 'geojson';

import type { GridAssets } from '../grid/assets';
import {
  archivedRadarImage,
  buildStyle,
  applyBasemapMode,
  radarImageCoordinates,
  radarTiles,
  type BasemapMode,
} from '../map/basemap';
import { replayRadarFrameMs, replayRadarFrames } from '../lib/radar';
import type { Crew, Incident } from '../lib/types';
import { faultDispatchStatus } from '../lib/events';

interface MapViewProps {
  assets: GridAssets;
  deadSegments: Set<string>;
  deadTransformers: Set<string>;
  highlightSegments: Set<string>;
  incidents: Incident[];
  crews: Crew[];
  mode: 'storm' | 'live';
  stormElapsedMs: number;
  stormDurationMs: number;
  selectedIncidentId: string | null;
  onSelectFault: (incidentId: string | null) => void;
}

const LAYER_GROUPS: { key: string; label: string; layers: string[] }[] = [
  { key: 'feeders', label: 'MV feeders', layers: ['feeders-live', 'feeders-dead', 'feeders-hl'] },
  { key: 'transformers', label: 'Transformers', layers: ['transformers'] },
  { key: 'faults', label: 'Faults', layers: ['faults', 'faults-status-ring', 'faults-pulse'] },
  { key: 'crews', label: 'Crews & routes', layers: ['crews', 'crews-label', 'dispatch-routes'] },
];
const RADAR_OPACITY = 0.6;

const STATUS_COLOR: Record<string, string> = {
  idle: '#7dd3fc',
  enroute: '#fbbf24',
  onsite: '#a78bfa',
  returning: '#94a3b8',
  offshift: '#475569',
};

/** Radar frames: last 2 h at 5-min steps, ending at the latest available. */
const RADAR_STEP_MS = 5 * 60000;
const LATEST_RADAR_MS = Math.floor((Date.now() - RADAR_STEP_MS) / RADAR_STEP_MS) * RADAR_STEP_MS;
function buildRadarFrames(count = 24): Date[] {
  const arr: Date[] = [];
  for (let i = count - 1; i >= 0; i--) arr.push(new Date(LATEST_RADAR_MS - i * RADAR_STEP_MS));
  return arr;
}
const RADAR_FRAMES = buildRadarFrames();
function frameLabel(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function frameLabelFull(d: Date): string {
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// --- radar tile prefetch (warm the browser cache for smooth scrub/loop) ---
const MERC_R = 20037508.342789244;
function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}
function tileMercBBox(x: number, y: number, z: number): [number, number, number, number] {
  const size = (2 * MERC_R) / 2 ** z;
  const minx = -MERC_R + x * size;
  const maxy = MERC_R - y * size;
  return [minx, maxy - size, minx + size, maxy];
}
/** Preload the current viewport's tiles for the given frames so scrub/sync is smooth. */
function prefetchRadar(
  map: maplibregl.Map,
  frames: Date[],
  template: (frame: Date) => string
): void {
  const z = Math.min(8, Math.max(0, Math.floor(map.getZoom())));
  const b = map.getBounds();
  const nw = lngLatToTile(b.getWest(), b.getNorth(), z);
  const se = lngLatToTile(b.getEast(), b.getSouth(), z);
  const tiles: { x: number; y: number }[] = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) tiles.push({ x, y });
  if (tiles.length === 0 || tiles.length > 30) return; // keep the warm-up bounded
  for (const f of frames) {
    const base = template(f);
    for (const t of tiles) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = base
        .replace('{z}', String(z))
        .replace('{x}', String(t.x))
        .replace('{y}', String(t.y))
        .replace('{bbox-epsg-3857}', tileMercBBox(t.x, t.y, z).join(','));
    }
  }
}

function prefetchImages(frames: Date[], template: (frame: Date) => string): void {
  for (const frame of frames) {
    const image = new Image();
    image.src = template(frame);
  }
}

export function MapView(props: MapViewProps) {
  const { assets } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const propsRef = useRef(props);
  const [glError, setGlError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode>('satellite');
  const [radarIdx, setRadarIdx] = useState(RADAR_FRAMES.length - 1);
  const [radarPlaying, setRadarPlaying] = useState(false);
  const radarFrontRef = useRef<'a' | 'b'>('a');
  const radarPendingRef = useRef<() => void>(() => {});
  const [visible, setVisible] = useState<Record<string, boolean>>({
    feeders: true,
    transformers: true,
    faults: true,
    crews: true,
    radar: false,
  });
  propsRef.current = props;

  // fault coordinates by incident_id (from scenario metadata)
  const faultCoords = useRef<Record<string, [number, number]>>({});
  useEffect(() => {
    const m: Record<string, [number, number]> = {};
    for (const f of assets.scenario.faults) m[f.incident_id] = [f.lon, f.lat];
    faultCoords.current = m;
  }, [assets]);

  // --- init (once) ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildStyle(assets.basemap, assets.scenario.radarReplay),
        center: [assets.municipality.map.center.lon, assets.municipality.map.center.lat],
        zoom: assets.municipality.map.defaultZoom,
        attributionControl: { compact: true },
      });
    } catch (e) {
      setGlError(String(e instanceof Error ? e.message : e));
      return;
    }
    mapRef.current = map;
    map.on('error', (e) => {
      if (String(e?.error?.message ?? '').includes('WebGL')) setGlError('WebGL unavailable');
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      // static sources
      map.addSource('kayttopaikat', { type: 'geojson', data: assets.kayttopaikat });
      map.addSource('feeders', { type: 'geojson', data: assets.feeders });
      map.addSource('transformers', { type: 'geojson', data: assets.transformers });
      map.addSource('substations', { type: 'geojson', data: assets.substations });
      map.addSource('droutes', { type: 'geojson', data: emptyFC() });
      map.addSource('faults', { type: 'geojson', data: emptyFC() });
      map.addSource('crews', { type: 'geojson', data: emptyFC() });

      // customer connection points (dim density dots)
      map.addLayer({
        id: 'kp', type: 'circle', source: 'kayttopaikat',
        paint: { 'circle-radius': 1.6, 'circle-color': '#334155', 'circle-opacity': 0.5 },
      });

      // downstream highlight glow (under the feeder lines)
      map.addLayer({
        id: 'feeders-hl', type: 'line', source: 'feeders',
        filter: ['==', ['get', 'hl'], true],
        paint: { 'line-color': '#facc15', 'line-width': 7, 'line-opacity': 0.35, 'line-blur': 2 },
      });
      // energized feeders (solid green)
      map.addLayer({
        id: 'feeders-live', type: 'line', source: 'feeders',
        filter: ['!=', ['get', 'dead'], true],
        paint: { 'line-color': '#39d98a', 'line-width': 1.8, 'line-opacity': 0.9 },
      });
      // de-energized feeders (dashed AND red — never colour-only)
      map.addLayer({
        id: 'feeders-dead', type: 'line', source: 'feeders',
        filter: ['==', ['get', 'dead'], true],
        paint: { 'line-color': '#ff4d4f', 'line-width': 2.6, 'line-dasharray': [2, 1.6] },
      });

      // Transformers stay deliberately smaller than fault origins.
      map.addLayer({
        id: 'transformers', type: 'circle', source: 'transformers',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'dead'], true], 3.2, 2],
          'circle-color': ['case', ['==', ['get', 'dead'], true], '#ff4d4f', '#2dd4bf'],
          'circle-stroke-color': ['case', ['==', ['get', 'dead'], true], '#7f1d1d', '#0f172a'],
          'circle-stroke-width': ['case', ['==', ['get', 'dead'], true], 1.2, 0.5],
        },
      });

      // substations
      map.addLayer({
        id: 'substations', type: 'circle', source: 'substations',
        paint: {
          'circle-radius': 7, 'circle-color': '#38bdf8',
          'circle-stroke-color': '#e0f2fe', 'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'substations-label', type: 'symbol', source: 'substations',
        layout: {
          'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.4],
          'text-font': ['Open Sans Regular'], 'text-anchor': 'top',
        },
        paint: { 'text-color': '#e0f2fe', 'text-halo-color': '#0b0f14', 'text-halo-width': 1.5 },
      });

      // Only unassigned faults pulse; rings encode dispatch state while the
      // large red centre consistently means the electrical fault origin.
      map.addLayer({
        id: 'faults-pulse', type: 'circle', source: 'faults',
        filter: ['==', ['get', 'dispatch_status'], 'unassigned'],
        paint: { 'circle-radius': 10, 'circle-color': '#ef4444', 'circle-opacity': 0.25 },
      });
      map.addLayer({
        id: 'faults-status-ring', type: 'circle', source: 'faults',
        paint: {
          'circle-radius': [
            'match',
            ['get', 'dispatch_status'],
            'unassigned', 11,
            'queued', 10,
            9,
          ],
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': [
            'match',
            ['get', 'dispatch_status'],
            'unassigned', '#ff4d4f',
            'queued', '#f5a524',
            'assigned', '#38bdf8',
            'onsite', '#a78bfa',
            '#94a3b8',
          ],
          'circle-stroke-width': 3,
          'circle-stroke-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'faults', type: 'circle', source: 'faults',
        paint: {
          'circle-radius': 7,
          'circle-color': ['case', ['==', ['get', 'selected'], true], '#fde047', '#ef4444'],
          'circle-stroke-color': '#450a0a', 'circle-stroke-width': 2,
        },
      });

      // crews
      map.addLayer({
        id: 'dispatch-routes', type: 'line', source: 'droutes',
        paint: { 'line-color': '#35d07f', 'line-width': 2, 'line-dasharray': [1.5, 1.2], 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'crews', type: 'circle', source: 'crews',
        paint: {
          'circle-radius': 6, 'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'crews-label', type: 'symbol', source: 'crews',
        layout: {
          'text-field': ['get', 'callsign'], 'text-size': 11, 'text-offset': [0, 1.2],
          'text-font': ['Open Sans Regular'], 'text-anchor': 'top',
        },
        paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0b0f14', 'text-halo-width': 1.5 },
      });

      map.on('click', 'faults', (e) => {
        const id = e.features?.[0]?.properties?.incident_id as string | undefined;
        if (id) propsRef.current.onSelectFault(id);
      });
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['faults'] });
        if (hits.length === 0) propsRef.current.onSelectFault(null);
      });
      for (const lyr of ['faults', 'crews']) {
        map.on('mouseenter', lyr, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', lyr, () => (map.getCanvas().style.cursor = ''));
      }

      loadedRef.current = true;
      applyUpdate(map, propsRef.current, faultCoords.current);
      applyVisibility(map, visible);
      applyBasemapMode(map, basemap);
    });

    // pulse animation
    let raf = 0;
    const animate = () => {
      const m = mapRef.current;
      if (m && loadedRef.current && m.getLayer('faults-pulse')) {
        const t = (Date.now() % 1500) / 1500;
        m.setPaintProperty('faults-pulse', 'circle-radius', 10 + t * 22);
        m.setPaintProperty('faults-pulse', 'circle-opacity', 0.3 * (1 - t));
      }
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- updates ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    applyUpdate(map, props, faultCoords.current);
  });

  // --- layer visibility ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    applyVisibility(map, visible);
  }, [visible]);

  // --- basemap mode ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    applyBasemapMode(map, basemap);
  }, [basemap]);

  // --- radar double-buffer crossfade (no blink between frames) ---
  const fadeOutRadar = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    radarPendingRef.current();
    for (const prefix of ['fmi-radar', 'replay-radar']) {
      for (const buf of ['a', 'b']) {
        if (map.getLayer(`${prefix}-${buf}`)) map.setPaintProperty(`${prefix}-${buf}`, 'raster-opacity', 0);
      }
    }
  }, []);

  const showRadarFrame = useCallback((iso: string, archived: boolean) => {
    const map = mapRef.current;
    const prefix = archived ? 'replay-radar' : 'fmi-radar';
    if (!map || !map.getLayer(`${prefix}-a`)) return;
    radarPendingRef.current(); // cancel any previous pending swap
    const front = radarFrontRef.current;
    const back = front === 'a' ? 'b' : 'a';
    const backSrc = `${prefix}-${back}`;
    if (archived && assets.scenario.radarReplay) {
      (map.getSource(backSrc) as maplibregl.ImageSource | undefined)?.updateImage({
        url: archivedRadarImage(assets.scenario.radarReplay, iso),
        coordinates: radarImageCoordinates(assets.scenario.radarReplay),
      });
    } else {
      (map.getSource(backSrc) as unknown as { setTiles?: (t: string[]) => void } | undefined)?.setTiles?.([
        radarTiles(iso),
      ]);
    }
    let done = false;
    const swap = () => {
      if (done) return;
      done = true;
      map.off('sourcedata', onData);
      clearTimeout(tid);
      // fade the freshly-loaded buffer in and the old one out (crossfade)
      map.setPaintProperty(`${prefix}-${back}`, 'raster-opacity', RADAR_OPACITY);
      map.setPaintProperty(`${prefix}-${front}`, 'raster-opacity', 0);
      const other = archived ? 'fmi-radar' : 'replay-radar';
      for (const buf of ['a', 'b']) {
        if (map.getLayer(`${other}-${buf}`)) map.setPaintProperty(`${other}-${buf}`, 'raster-opacity', 0);
      }
      radarFrontRef.current = back;
    };
    const onData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId === backSrc && map.isSourceLoaded(backSrc)) swap();
    };
    map.on('sourcedata', onData);
    const tid = setTimeout(swap, 1500); // safety if no event fires
    radarPendingRef.current = () => {
      map.off('sourcedata', onData);
      clearTimeout(tid);
    };
  }, [assets.scenario.radarReplay]);

  const stormFrameMs = assets.scenario.radarReplay
    ? replayRadarFrameMs(assets.scenario.radarReplay, props.stormElapsedMs, props.stormDurationMs)
    : null;

  // apply the selected frame (or fade out when radar is off)
  useEffect(() => {
    if (!loadedRef.current) return;
    if (!visible.radar) {
      fadeOutRadar();
      return;
    }
    if (props.mode === 'storm') {
      if (stormFrameMs != null) showRadarFrame(new Date(stormFrameMs).toISOString(), true);
      else fadeOutRadar();
    } else {
      const iso = RADAR_FRAMES[radarIdx]?.toISOString();
      if (iso) showRadarFrame(iso, false);
    }
  }, [visible.radar, radarIdx, props.mode, stormFrameMs, showRadarFrame, fadeOutRadar]);

  // on enable: jump to latest + warm the cache; on disable: stop looping
  useEffect(() => {
    if (visible.radar) {
      setRadarIdx(RADAR_FRAMES.length - 1);
      const map = mapRef.current;
      if (map && loadedRef.current) {
        if (props.mode === 'storm' && assets.scenario.radarReplay) {
          const replay = assets.scenario.radarReplay;
          prefetchImages(replayRadarFrames(replay, 2), (frame) => archivedRadarImage(replay, frame.toISOString()));
        } else {
          prefetchRadar(map, RADAR_FRAMES, (frame) => radarTiles(frame.toISOString()));
        }
      }
    } else {
      setRadarPlaying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.radar, props.mode]);

  // animate the radar loop (live mode only — storm mode follows the sim clock)
  useEffect(() => {
    if (!radarPlaying || props.mode !== 'live') return;
    const id = setInterval(() => setRadarIdx((i) => (i + 1) % RADAR_FRAMES.length), 650);
    return () => clearInterval(id);
  }, [radarPlaying, props.mode]);

  return (
    <div className="map-root" ref={containerRef}>
      {glError && (
        <div className="gl-error">
          Map could not render ({glError}). KPIs and incident data still update.
        </div>
      )}
      <div className="basemap-switch">
        {(['map', 'dark', 'satellite'] as BasemapMode[]).map((m) => (
          <button key={m} className={`bm-btn ${basemap === m ? 'active' : ''}`} onClick={() => setBasemap(m)}>
            {m === 'map' ? 'Map' : m === 'dark' ? 'Dark' : 'Satellite'}
          </button>
        ))}
      </div>
      <div className="layers-panel">
        <div className="lp-head">LAYERS</div>
        {LAYER_GROUPS.map((g) => (
          <label key={g.key} className="lp-row">
            <input
              type="checkbox"
              checked={visible[g.key]}
              onChange={(e) => setVisible((v) => ({ ...v, [g.key]: e.target.checked }))}
            />
            {g.label}
          </label>
        ))}
        <label className="lp-row">
          <input
            type="checkbox"
            checked={visible.radar}
            onChange={(e) => setVisible((v) => ({ ...v, radar: e.target.checked }))}
          />
          Rain radar (FMI)
        </label>
      </div>
      <div className="legend">
        <LegendRow swatch={<span className="lg-line live" />} text="Feeder energized" />
        <LegendRow swatch={<span className="lg-line dead" />} text="De-energized" />
        <LegendRow swatch={<span className="lg-sq ok" />} text="Transformer OK" />
        <LegendRow swatch={<span className="lg-sq out" />} text="Transformer out" />
        <LegendRow swatch={<span className="lg-dot fault" />} text="Fault origin (large)" />
        <LegendRow swatch={<span className="lg-ring unassigned" />} text="Unassigned (pulsing)" />
        <LegendRow swatch={<span className="lg-ring queued" />} text="Queued" />
        <LegendRow swatch={<span className="lg-ring assigned" />} text="Assigned / en route" />
        <LegendRow swatch={<span className="lg-ring onsite" />} text="On site" />
        <LegendRow swatch={<span className="lg-pill" />} text="Crew (K1…K6)" />
        <LegendRow swatch={<span className="lg-line route" />} text="Dispatch route" />
      </div>
      {visible.radar && (
        <div className={`radar-control ${props.mode === 'storm' ? 'storm' : ''}`}>
          {props.mode === 'storm' ? (
            <>
              <span className="radar-time">Radar {stormFrameMs == null ? 'unavailable' : frameLabelFull(new Date(stormFrameMs))}</span>
              <span className="radar-tag">FIXED REPLAY ARCHIVE · FMI</span>
            </>
          ) : (
            <>
              <button className="radar-play" onClick={() => setRadarPlaying((p) => !p)} title="Play radar loop">
                {radarPlaying ? '⏸' : '▶'}
              </button>
              <input
                className="radar-slider"
                type="range"
                min={0}
                max={RADAR_FRAMES.length - 1}
                value={radarIdx}
                onChange={(e) => {
                  setRadarPlaying(false);
                  setRadarIdx(Number(e.target.value));
                }}
              />
              <span className="radar-time">
                {frameLabel(RADAR_FRAMES[radarIdx])}
                {radarIdx === RADAR_FRAMES.length - 1 ? ' · LIVE' : ''}
              </span>
              <span className="radar-tag">RAIN RADAR · FMI</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LegendRow({ swatch, text }: { swatch: ReactNode; text: string }) {
  return (
    <div className="lg-row">
      {swatch}
      <span>{text}</span>
    </div>
  );
}

function applyVisibility(map: maplibregl.Map, visible: Record<string, boolean>) {
  for (const g of LAYER_GROUPS) {
    for (const lyr of g.layers) {
      if (map.getLayer(lyr)) map.setLayoutProperty(lyr, 'visibility', visible[g.key] ? 'visible' : 'none');
    }
  }
}

function applyUpdate(
  map: maplibregl.Map,
  p: MapViewProps,
  faultCoords: Record<string, [number, number]>
) {
  const feeders = withProps(p.assets.feeders, (f) => ({
    dead: p.deadSegments.has(f.properties?.seg_id),
    hl: p.highlightSegments.has(f.properties?.seg_id),
  }));
  (map.getSource('feeders') as maplibregl.GeoJSONSource | undefined)?.setData(feeders);

  const transformers = withProps(p.assets.transformers, (f) => ({
    dead: p.deadTransformers.has(f.properties?.tr_id),
  }));
  (map.getSource('transformers') as maplibregl.GeoJSONSource | undefined)?.setData(transformers);

  (map.getSource('faults') as maplibregl.GeoJSONSource | undefined)?.setData(
    faultsFC(p.incidents, faultCoords, p.selectedIncidentId)
  );
  (map.getSource('crews') as maplibregl.GeoJSONSource | undefined)?.setData(crewsFC(p.crews));
  (map.getSource('droutes') as maplibregl.GeoJSONSource | undefined)?.setData(crewRoutesFC(p.crews));
}

function withProps(fc: FeatureCollection, extra: (f: Feature) => Record<string, unknown>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => ({
      ...f,
      properties: { ...f.properties, ...extra(f) },
    })),
  };
}

function emptyFC(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function faultsFC(
  incidents: Incident[],
  coords: Record<string, [number, number]>,
  selected: string | null
): FeatureCollection {
  const coordFor = (i: Incident): [number, number] | null =>
    i.lon != null && i.lat != null ? [i.lon, i.lat] : coords[i.incident_id] ?? null;
  return {
    type: 'FeatureCollection',
    features: incidents
      .filter((i) => i.status !== 'restored' && coordFor(i))
      .map((i) => ({
        type: 'Feature',
        properties: {
          incident_id: i.incident_id,
          fault_type: i.fault_type,
          dispatch_status: faultDispatchStatus(i),
          selected: i.incident_id === selected,
        },
        geometry: { type: 'Point', coordinates: coordFor(i) as [number, number] },
      })),
  };
}

function crewsFC(crews: Crew[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: crews.map((c) => ({
      type: 'Feature',
      properties: {
        crew_id: c.crew_id,
        callsign: c.callsign,
        color: STATUS_COLOR[c.status] ?? '#7dd3fc',
      },
      geometry: { type: 'Point', coordinates: [parseFloat(c.lon), parseFloat(c.lat)] },
    })),
  };
}

function crewRoutesFC(crews: Crew[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: crews
      .filter((c) => c.route && c.route.length >= 2)
      .map((c) => ({
        type: 'Feature',
        properties: { crew_id: c.crew_id },
        geometry: { type: 'LineString', coordinates: c.route as [number, number][] },
      })),
  };
}
