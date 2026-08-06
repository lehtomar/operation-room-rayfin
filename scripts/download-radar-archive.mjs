import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const scenarioId = 'mauri-2026';
const start = new Date('2026-07-09T08:00:00Z');
const end = new Date('2026-07-09T12:00:00Z');
const stepMs = 5 * 60000;
const bounds = [24.8, 61.1, 26.8, 62.0];
const output = resolve('assets', 'radar', scenarioId);
const tasks = [];

function mercator(lon, lat) {
  const radius = 6378137;
  return [
    (lon * Math.PI * radius) / 180,
    radius * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  ];
}

function frameKey(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('.000', '');
}

for (let time = start.getTime(); time <= end.getTime(); time += stepMs) {
  tasks.push(new Date(time));
}

async function download(date) {
  const [minX, minY] = mercator(bounds[0], bounds[1]);
  const [maxX, maxY] = mercator(bounds[2], bounds[3]);
  const query = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: 'Radar:suomi_dbz_eureffin',
    styles: '',
    format: 'image/png',
    transparent: 'true',
    srs: 'EPSG:3857',
    width: '1024',
    height: '1024',
    bbox: [minX, minY, maxX, maxY].join(','),
    TIME: date.toISOString().replace('.000Z', 'Z'),
  });
  const response = await fetch(`https://openwms.fmi.fi/geoserver/wms?${query}`);
  if (!response.ok) throw new Error(`FMI radar ${response.status} for ${date.toISOString()}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`FMI returned a non-PNG response for ${date.toISOString()}`);
  }
  await writeFile(resolve(output, `${frameKey(date)}.png`), bytes);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
let next = 0;
const workers = Array.from({ length: 8 }, async () => {
  while (next < tasks.length) {
    const date = tasks[next++];
    await download(date);
    if (next % 10 === 0 || next === tasks.length) {
      console.log(`[radar] ${next}/${tasks.length} frames`);
    }
  }
});

await Promise.all(workers);
await writeFile(
  resolve(output, 'manifest.json'),
  `${JSON.stringify(
    {
      scenarioId,
      start: start.toISOString(),
      end: end.toISOString(),
      stepMinutes: stepMs / 60000,
      bounds,
      frameCount: tasks.length,
      imageSize: [1024, 1024],
      source: 'FMI Radar:suomi_dbz_eureffin',
      archivedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`
);
console.log(`[radar] archive written to ${output}`);
