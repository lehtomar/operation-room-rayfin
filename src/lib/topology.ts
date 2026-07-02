import type { Incident, Topology } from './types';

/** Käyttöpaikka ids de-energized by a single faulted segment. */
export function segmentKayttopaikat(topo: Topology, segId: string): string[] {
  return topo.segments[segId]?.kayttopaikka_ids ?? [];
}

export function segmentTransformers(topo: Topology, segId: string): string[] {
  return topo.segments[segId]?.transformer_ids ?? [];
}

export interface DeEnergized {
  segments: Set<string>;
  transformers: Set<string>;
  kayttopaikat: Set<string>;
  customersOut: number;
}

/**
 * Union of downstream assets across all active (non-restored) incidents.
 * Radial network → a plain union is correct, and overlapping feeder segments
 * de-duplicate automatically.
 */
export function deEnergizedFromIncidents(
  topo: Topology,
  incidents: Incident[]
): DeEnergized {
  const segments = new Set<string>();
  const transformers = new Set<string>();
  const kayttopaikat = new Set<string>();
  for (const inc of incidents) {
    if (inc.status === 'restored') continue;
    segments.add(inc.seg_id);
    for (const t of segmentTransformers(topo, inc.seg_id)) transformers.add(t);
    for (const k of segmentKayttopaikat(topo, inc.seg_id)) kayttopaikat.add(k);
  }
  return { segments, transformers, kayttopaikat, customersOut: kayttopaikat.size };
}

// --- feeder-segment tree (for map: colour whole de-energized subtree) ---
import type { FeatureCollection } from 'geojson';

export type SegmentChildren = Map<string, string[]>;

/** parent_seg_id -> [child seg_id] from the feeders GeoJSON. */
export function buildSegmentChildren(feeders: FeatureCollection): SegmentChildren {
  const children: SegmentChildren = new Map();
  for (const f of feeders.features) {
    const parent = f.properties?.parent_seg_id as string | null;
    const seg = f.properties?.seg_id as string;
    if (!parent || !seg) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(seg);
  }
  return children;
}

/** All segments in the subtree rooted at `root` (inclusive). */
export function subtreeSegments(children: SegmentChildren, root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const s = stack.pop()!;
    out.push(s);
    for (const c of children.get(s) ?? []) stack.push(c);
  }
  return out;
}

/** Every de-energized segment = union of subtrees below each active fault. */
export function deadSegmentsFromIncidents(
  children: SegmentChildren,
  incidents: Incident[]
): Set<string> {
  const dead = new Set<string>();
  for (const inc of incidents) {
    if (inc.status === 'restored') continue;
    for (const s of subtreeSegments(children, inc.seg_id)) dead.add(s);
  }
  return dead;
}
