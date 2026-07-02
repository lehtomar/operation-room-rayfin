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

  return { version: 8, glyphs: GLYPHS, sources, layers };
}

/** Apply a basemap mode by toggling the two raster layers' visibility. */
export function applyBasemapMode(map: maplibregl.Map, mode: BasemapMode): void {
  const set = (id: string, vis: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis ? 'visible' : 'none');
  };
  set('mml', mode === 'map');
  set('ortokuva', mode === 'satellite');
}
