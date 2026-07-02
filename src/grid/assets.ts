import type { FeatureCollection } from 'geojson';
import type { Municipality, RouteMap, ScenarioMeta, Topology } from '../lib/types';

export interface BasemapConfig {
  provider: 'mml-wmts' | 'mtk-vector';
  mmlApiKey?: string;
  wmtsUrl?: string;
}

export interface GridAssets {
  substations: FeatureCollection;
  transformers: FeatureCollection;
  kayttopaikat: FeatureCollection;
  feeders: FeatureCollection;
  topology: Topology;
  routes: RouteMap;
  scenario: ScenarioMeta;
  municipality: Municipality;
  basemap: BasemapConfig;
}

async function j<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export async function loadGridAssets(): Promise<GridAssets> {
  const base = `${import.meta.env.BASE_URL}data`;
  const [
    substations,
    transformers,
    kayttopaikat,
    feeders,
    topology,
    routes,
    scenario,
    municipality,
    basemap,
  ] = await Promise.all([
    j<FeatureCollection>(`${base}/substations.geojson`),
    j<FeatureCollection>(`${base}/transformers.geojson`),
    j<FeatureCollection>(`${base}/kayttopaikat.geojson`),
    j<FeatureCollection>(`${base}/feeders.geojson`),
    j<Topology>(`${base}/topology.json`),
    j<RouteMap>(`${base}/routes.json`).catch(() => ({}) as RouteMap),
    j<ScenarioMeta>(`${base}/scenario.json`),
    j<Municipality>(`${base}/municipality.json`),
    j<BasemapConfig>(`${base}/basemap.json`).catch(() => ({ provider: 'mtk-vector' as const })),
  ]);
  return {
    substations,
    transformers,
    kayttopaikat,
    feeders,
    topology,
    routes,
    scenario,
    municipality,
    basemap,
  };
}
