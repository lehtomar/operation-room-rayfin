import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FeatureCollection, Feature } from 'geojson';

import type { GridAssets } from '../grid/assets';
import { buildStyle, applyBasemapMode, radarTiles, type BasemapMode } from '../map/basemap';
import type { Crew, Incident } from '../lib/types';

interface MapViewProps {
  assets: GridAssets;
  deadSegments: Set<string>;
  deadTransformers: Set<string>;
  highlightSegments: Set<string>;
  incidents: Incident[];
  crews: Crew[];
  stormFront: [number, number][] | null;
  selectedIncidentId: string | null;
  onSelectFault: (incidentId: string | null) => void;
}

const LAYER_GROUPS: { key: string; label: string; layers: string[] }[] = [
  { key: 'feeders', label: 'MV feeders', layers: ['feeders-live', 'feeders-dead', 'feeders-hl'] },
  { key: 'transformers', label: 'Transformers', layers: ['transformers'] },
  { key: 'faults', label: 'Faults', layers: ['faults', 'faults-pulse'] },
  { key: 'crews', label: 'Crews & routes', layers: ['crews', 'crews-label', 'dispatch-routes'] },
  { key: 'weather', label: 'Weather / FMI', layers: ['warning-fill', 'warning-line', 'front-line'] },
  { key: 'radar', label: 'Rain radar (FMI)', layers: ['fmi-radar'] },
];

const STATUS_COLOR: Record<string, string> = {
  idle: '#7dd3fc',
  enroute: '#fbbf24',
  onsite: '#a78bfa',
  returning: '#94a3b8',
  offshift: '#475569',
};

/** Radar frames: last 2 h at 5-min steps, ending at the latest available. */
function buildRadarFrames(count = 24, stepMin = 5): Date[] {
  const step = stepMin * 60000;
  const latest = Math.floor((Date.now() - 5 * 60000) / step) * step;
  const arr: Date[] = [];
  for (let i = count - 1; i >= 0; i--) arr.push(new Date(latest - i * step));
  return arr;
}
const RADAR_FRAMES = buildRadarFrames();
function frameLabel(d: Date): string {
  return d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
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
/** Preload the current viewport's tiles for every frame so the loop is smooth. */
function prefetchRadar(map: maplibregl.Map): void {
  const z = Math.min(8, Math.max(0, Math.floor(map.getZoom())));
  const b = map.getBounds();
  const nw = lngLatToTile(b.getWest(), b.getNorth(), z);
  const se = lngLatToTile(b.getEast(), b.getSouth(), z);
  const tiles: { x: number; y: number }[] = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) tiles.push({ x, y });
  if (tiles.length === 0 || tiles.length > 30) return; // keep the warm-up bounded
  for (const f of RADAR_FRAMES) {
    const base = radarTiles(f.toISOString());
    for (const t of tiles) {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // match MapLibre's CORS fetch → shared cache entry
      img.src = base.replace('{bbox-epsg-3857}', tileMercBBox(t.x, t.y, z).join(','));
    }
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
  const [visible, setVisible] = useState<Record<string, boolean>>({
    feeders: true,
    transformers: true,
    faults: true,
    crews: true,
    weather: true,
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
        style: buildStyle(assets.basemap),
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
      if (String(e?.error?.message ?? '').includes('WebGL')) setGlError('WebGL ei käytettävissä');
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      // static sources
      map.addSource('kayttopaikat', { type: 'geojson', data: assets.kayttopaikat });
      map.addSource('feeders', { type: 'geojson', data: assets.feeders });
      map.addSource('transformers', { type: 'geojson', data: assets.transformers });
      map.addSource('substations', { type: 'geojson', data: assets.substations });
      map.addSource('warning', { type: 'geojson', data: warningFC(assets) });
      map.addSource('front', { type: 'geojson', data: emptyFC() });
      map.addSource('droutes', { type: 'geojson', data: emptyFC() });
      map.addSource('faults', { type: 'geojson', data: emptyFC() });
      map.addSource('crews', { type: 'geojson', data: emptyFC() });

      // storm warning polygon
      map.addLayer({
        id: 'warning-fill', type: 'fill', source: 'warning',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'warning-line', type: 'line', source: 'warning',
        paint: { 'line-color': '#f59e0b', 'line-opacity': 0.4, 'line-width': 1.5, 'line-dasharray': [3, 3] },
      });
      // storm front (moves NW→SE over time)
      map.addLayer({
        id: 'front-line', type: 'line', source: 'front',
        paint: { 'line-color': '#fb923c', 'line-width': 3, 'line-opacity': 0.8, 'line-dasharray': [1.5, 1] },
      });

      // käyttöpaikat (dim density dots)
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

      // transformers (status squares via square-ish stroke + colour + size)
      map.addLayer({
        id: 'transformers', type: 'circle', source: 'transformers',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'dead'], true], 5, 3],
          'circle-color': ['case', ['==', ['get', 'dead'], true], '#ff4d4f', '#2dd4bf'],
          'circle-stroke-color': ['case', ['==', ['get', 'dead'], true], '#7f1d1d', '#0f172a'],
          'circle-stroke-width': ['case', ['==', ['get', 'dead'], true], 2, 0.5],
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

      // fault pulses
      map.addLayer({
        id: 'faults-pulse', type: 'circle', source: 'faults',
        paint: { 'circle-radius': 10, 'circle-color': '#ef4444', 'circle-opacity': 0.25 },
      });
      map.addLayer({
        id: 'faults', type: 'circle', source: 'faults',
        paint: {
          'circle-radius': 6,
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

  // --- radar: apply the selected frame (scrub / animate) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !visible.radar) return;
    const iso = RADAR_FRAMES[radarIdx]?.toISOString();
    if (!iso) return;
    const src = map.getSource('fmi-radar') as unknown as { setTiles?: (t: string[]) => void } | undefined;
    src?.setTiles?.([radarTiles(iso)]);
  }, [visible.radar, radarIdx]);

  // jump to the latest frame + warm the cache when radar is turned on
  useEffect(() => {
    if (visible.radar) {
      setRadarIdx(RADAR_FRAMES.length - 1);
      const map = mapRef.current;
      if (map && loadedRef.current) prefetchRadar(map);
    } else {
      setRadarPlaying(false);
    }
  }, [visible.radar]);

  // animate the radar loop
  useEffect(() => {
    if (!radarPlaying) return;
    const id = setInterval(() => setRadarIdx((i) => (i + 1) % RADAR_FRAMES.length), 650);
    return () => clearInterval(id);
  }, [radarPlaying]);

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
      </div>
      <div className="legend">
        <LegendRow swatch={<span className="lg-line live" />} text="Feeder energized" />
        <LegendRow swatch={<span className="lg-line dead" />} text="De-energized" />
        <LegendRow swatch={<span className="lg-sq ok" />} text="Transformer OK" />
        <LegendRow swatch={<span className="lg-sq out" />} text="Transformer out" />
        <LegendRow swatch={<span className="lg-dot fault" />} text="Fault (pulsing)" />
        <LegendRow swatch={<span className="lg-pill" />} text="Crew (K1…K6)" />
        <LegendRow swatch={<span className="lg-line route" />} text="Dispatch route" />
        <LegendRow swatch={<span className="lg-line front" />} text="Storm front / FMI" />
      </div>
      {visible.radar && (
        <div className="radar-control">
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
  (map.getSource('front') as maplibregl.GeoJSONSource | undefined)?.setData(lineFC(p.stormFront));
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

function warningFC(assets: GridAssets): FeatureCollection {
  const ring = assets.scenario.storm.warningPolygon;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
      },
    ],
  };
}

function lineFC(coords: [number, number][] | null): FeatureCollection {
  if (!coords || coords.length < 2) return emptyFC();
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
  };
}

function faultsFC(
  incidents: Incident[],
  coords: Record<string, [number, number]>,
  selected: string | null
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: incidents
      .filter((i) => i.status !== 'restored' && coords[i.incident_id])
      .map((i) => ({
        type: 'Feature',
        properties: {
          incident_id: i.incident_id,
          fault_type: i.fault_type,
          selected: i.incident_id === selected,
        },
        geometry: { type: 'Point', coordinates: coords[i.incident_id] },
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
