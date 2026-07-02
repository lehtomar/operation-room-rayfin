import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { FeatureCollection, Feature } from 'geojson';

import type { GridAssets } from '../grid/assets';
import { buildStyle } from '../map/basemap';
import type { Crew, Incident } from '../lib/types';

interface MapViewProps {
  assets: GridAssets;
  deadSegments: Set<string>;
  deadTransformers: Set<string>;
  highlightSegments: Set<string>;
  incidents: Incident[];
  crews: Crew[];
  selectedIncidentId: string | null;
  onSelectFault: (incidentId: string | null) => void;
}

const STATUS_COLOR: Record<string, string> = {
  idle: '#7dd3fc',
  enroute: '#fbbf24',
  onsite: '#a78bfa',
  returning: '#94a3b8',
  offshift: '#475569',
};

export function MapView(props: MapViewProps) {
  const { assets } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const propsRef = useRef(props);
  const [glError, setGlError] = useState<string | null>(null);
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

    map.on('load', () => {
      // static sources
      map.addSource('kayttopaikat', { type: 'geojson', data: assets.kayttopaikat });
      map.addSource('feeders', { type: 'geojson', data: assets.feeders });
      map.addSource('transformers', { type: 'geojson', data: assets.transformers });
      map.addSource('substations', { type: 'geojson', data: assets.substations });
      map.addSource('warning', { type: 'geojson', data: warningFC(assets) });
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

  return (
    <div className="map-root" ref={containerRef}>
      {glError && (
        <div className="gl-error">
          Karttaa ei voitu piirtää ({glError}). KPI:t ja vikatiedot päivittyvät silti.
        </div>
      )}
    </div>
  );
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
