import type maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapConfig } from '../grid/assets';

const DARK_BG = '#0a0e14';
const GLYPHS = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';

export type BasemapMode = 'map' | 'dark' | 'satellite';

/**
 * A single dark-canvas style with two MML WMTS raster basemaps layered on top
 * (background map + orthophoto/satellite). The active one is chosen at runtime
 * via layer visibility (see MapView), so we never re-create the style.
 */
export function buildStyle(basemap: BasemapConfig): StyleSpecification {
  const sources: StyleSpecification['sources'] = {};
  const layers: NonNullable<StyleSpecification['layers']> = [
    { id: 'bg', type: 'background', paint: { 'background-color': DARK_BG } },
  ];

  if (basemap.provider === 'mml-wmts' && basemap.mmlApiKey) {
    const base =
      basemap.wmtsUrl?.replace(/\?.*$/, '') ??
      'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/taustakartta/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png';
    const ortho =
      'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.jpg';
    sources.mml = {
      type: 'raster',
      tiles: [`${base}?api-key=${basemap.mmlApiKey}`],
      tileSize: 256,
      attribution: '© Maanmittauslaitos',
    };
    sources.ortokuva = {
      type: 'raster',
      tiles: [`${ortho}?api-key=${basemap.mmlApiKey}`],
      tileSize: 256,
      attribution: '© Maanmittauslaitos',
    };
    layers.push({
      id: 'mml',
      type: 'raster',
      source: 'mml',
      paint: { 'raster-brightness-max': 0.82, 'raster-saturation': -0.25, 'raster-contrast': 0.05 },
    });
    layers.push({
      id: 'ortokuva',
      type: 'raster',
      source: 'ortokuva',
      layout: { visibility: 'none' },
      paint: { 'raster-brightness-max': 0.9 },
    });
  }

  // Live FMI weather radar (reflectivity). Rendered under the grid, off by
  // default. Constrained to Finland + capped zoom so only relevant, visible
  // tiles load (overzoomed beyond z8 instead of fetching more tiles).
  const latestIso = new Date(Math.floor((Date.now() - 5 * 60000) / 300000) * 300000).toISOString();
  sources['fmi-radar'] = {
    type: 'raster',
    tiles: [radarTiles(latestIso)],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 8,
    bounds: [19, 59, 32, 71],
    attribution: '© Ilmatieteen laitos (FMI)',
  };
  layers.push({
    id: 'fmi-radar',
    type: 'raster',
    source: 'fmi-radar',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.6 },
  });

  return { version: 8, glyphs: GLYPHS, sources, layers };
}

/**
 * FMI open-data WMS GetMap tile template for a radar frame. The URL is
 * deterministic per (frame time, tile bbox) so browser + MapLibre caches reuse
 * tiles across scrubbing/looping (the WMS sends Cache-Control max-age=86400).
 */
export function radarTiles(timeIso: string): string {
  const t = timeIso.replace(/\.\d{3}Z$/, 'Z');
  return (
    'https://openwms.fmi.fi/geoserver/wms?service=WMS&version=1.1.1&request=GetMap' +
    '&layers=Radar:suomi_dbz_eureffin&styles=&format=image/png&transparent=true' +
    '&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}&TIME=' +
    t
  );
}

/** Apply a basemap mode by toggling the two raster layers' visibility. */
export function applyBasemapMode(map: maplibregl.Map, mode: BasemapMode): void {
  const set = (id: string, vis: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis ? 'visible' : 'none');
  };
  set('mml', mode === 'map');
  set('ortokuva', mode === 'satellite');
}
