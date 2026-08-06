import { describe, expect, it } from 'vitest';

import { buildStyle } from '../map/basemap';

describe('basemap style', () => {
  it('provides keyless map and satellite sources when MML is not configured', () => {
    const style = buildStyle({ provider: 'mtk-vector' });
    const map = style.sources.mml;
    const satellite = style.sources.ortokuva;
    expect(map.type).toBe('raster');
    expect(satellite.type).toBe('raster');
    expect('tiles' in map ? map.tiles?.[0] : '').toContain('openstreetmap.org');
    expect('tiles' in satellite ? satellite.tiles?.[0] : '').toContain('arcgisonline.com');
  });

  it('uses MML sources when an API key is configured', () => {
    const style = buildStyle({ provider: 'mml-wmts', mmlApiKey: 'test-key' });
    const map = style.sources.mml;
    expect('tiles' in map ? map.tiles?.[0] : '').toContain('api-key=test-key');
  });
});
