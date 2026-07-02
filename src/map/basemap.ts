import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapConfig } from '../grid/assets';

const DARK_BG = '#0b0f14';
const GLYPHS = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';

/**
 * MML WMTS "taustakartta" raster basemap when an API key is present, otherwise
 * a plain dark canvas (the MTK-vector fallback) — the grid layers still render.
 */
export function buildStyle(basemap: BasemapConfig): StyleSpecification {
  if (basemap.provider === 'mml-wmts' && basemap.mmlApiKey && basemap.wmtsUrl) {
    const url = `${basemap.wmtsUrl}?api-key=${basemap.mmlApiKey}`;
    return {
      version: 8,
      glyphs: GLYPHS,
      sources: {
        mml: {
          type: 'raster',
          tiles: [url],
          tileSize: 256,
          attribution: '© Maanmittauslaitos',
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': DARK_BG } },
        { id: 'mml', type: 'raster', source: 'mml', paint: { 'raster-brightness-max': 0.85, 'raster-saturation': -0.2 } },
      ],
    };
  }
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': DARK_BG } }],
  };
}
