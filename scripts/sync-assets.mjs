// Copies generated grid assets + config into public/data so the frontend can
// fetch them at runtime. Runs in predev/prebuild. public/data is gitignored
// (regenerated from committed sources in tools/gridgen/output + config).
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public', 'data');
mkdirSync(out, { recursive: true });

const grid = resolve(root, 'tools', 'gridgen', 'output');
for (const f of ['substations', 'transformers', 'kayttopaikat', 'feeders']) {
  copyFileSync(resolve(grid, `${f}.geojson`), resolve(out, `${f}.geojson`));
}
copyFileSync(resolve(grid, 'topology.json'), resolve(out, 'topology.json'));
copyFileSync(
  resolve(root, 'scenarios', 'mauri-2026.json'),
  resolve(out, 'scenario.json')
);
const muni = process.env.MUNICIPALITY || 'sysma';
copyFileSync(
  resolve(root, 'config', `municipality.${muni}.json`),
  resolve(out, 'municipality.json')
);

// Basemap: prefer the local MML WMTS key; otherwise fall back to the MTK vector.
const basemapLocal = resolve(root, 'config', 'basemap.local.json');
const basemapOut = resolve(out, 'basemap.json');
if (existsSync(basemapLocal)) {
  copyFileSync(basemapLocal, basemapOut);
} else {
  writeFileSync(basemapOut, JSON.stringify({ provider: 'mtk-vector' }, null, 2));
}

console.log('[sync-assets] grid + config copied to public/data');
