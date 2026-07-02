// Geospatial helpers — great-circle distance and ETA (no routing engine).

export const ROAD_FACTOR = 1.3;
export const CREW_SPEED_KMH = 60;

export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const r = 6371;
  const p = Math.PI / 180;
  const dLat = (bLat - aLat) * p;
  const dLon = (bLon - aLon) * p;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
}

/** Estimated drive time in minutes (great-circle × road factor ÷ speed). */
export function etaMinutes(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const km = haversineKm(aLat, aLon, bLat, bLon) * ROAD_FACTOR;
  return Math.max(1, Math.round((km / CREW_SPEED_KMH) * 60));
}
