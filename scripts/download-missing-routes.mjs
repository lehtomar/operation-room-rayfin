import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const scenarioPath = resolve('scenarios', 'mauri-2026.json');
const routesPath = resolve('tools', 'gridgen', 'output', 'routes.json');
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
const routes = JSON.parse(await readFile(routesPath, 'utf8'));

const depots = new Map();
for (const crew of scenario.crews) {
  const key = `${crew.depot.lat.toFixed(6)},${crew.depot.lon.toFixed(6)}`;
  if (!depots.has(key)) {
    depots.set(key, {
      id: `DEPOT-${depots.size}`,
      lat: crew.depot.lat,
      lon: crew.depot.lon,
    });
  }
}

const dispatchDestinations = [
  ...scenario.faults.map((fault) => ({
    id: fault.incident_id,
    lat: fault.lat,
    lon: fault.lon,
  })),
  ...(scenario.liveSeed?.incidents ?? [])
    .filter((incident) => incident.lat != null && incident.lon != null)
    .map((incident) => ({
      id: incident.incident_id,
      lat: incident.lat,
      lon: incident.lon,
    })),
];
const maintenanceDestinations = [
  ...(scenario.liveSeed?.maintenance ?? [])
    .filter((job) => job.lat != null && job.lon != null)
    .map((job) => ({ id: job.job_id, lat: job.lat, lon: job.lon })),
];

const missing = [];
const origins = [...depots.values(), ...dispatchDestinations];
for (const origin of origins) {
  for (const destination of dispatchDestinations) {
    if (origin.id === destination.id) continue;
    const key = `${origin.id}->${destination.id}`;
    if (!routes[key]) missing.push({ key, origin, destination });
  }
}
for (const depot of depots.values()) {
  for (const destination of maintenanceDestinations) {
    const key = `${depot.id}->${destination.id}`;
    if (!routes[key]) missing.push({ key, origin: depot, destination });
  }
}

for (const [index, { key, origin, destination }] of missing.entries()) {
  const coordinates = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
    '?overview=full&geometries=geojson';
  const response = await fetch(url, {
    headers: { 'User-Agent': 'operation-room-rayfin route precomputation' },
  });
  if (!response.ok) throw new Error(`OSRM ${response.status} for ${key}`);
  const body = await response.json();
  const route = body.routes?.[0];
  if (body.code !== 'Ok' || !route?.geometry?.coordinates?.length) {
    throw new Error(`No road route returned for ${key}`);
  }
  routes[key] = {
    coords: [
      [origin.lon, origin.lat],
      ...route.geometry.coordinates,
      [destination.lon, destination.lat],
    ],
    km: Math.round((route.distance / 1000) * 1000) / 1000,
  };
  console.log(`[routes] ${index + 1}/${missing.length} ${key}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
}

await writeFile(routesPath, JSON.stringify(routes), 'utf8');
console.log(`[routes] wrote ${Object.keys(routes).length} routes to ${routesPath}`);
