import type { LiveState } from '../lib/types';

/**
 * Data access contract. Two implementations:
 * - {@link DevProvider}: talks to the simulator's local HTTP server (no auth).
 * - {@link RayfinProvider}: authenticated Rayfin GraphQL, used in the Fabric
 *   portal.
 * The frontend derives all KPIs / de-energized sets from this raw state plus
 * the static topology, so both providers return the same shape.
 */
export interface DataProvider {
  getState(): Promise<LiveState>;
  play(): Promise<void>;
  pause(): Promise<void>;
  setSpeed(v: number): Promise<void>;
  reset(): Promise<void>;
  dispatch(incidentId: string, crewId: string, etaMin: number): Promise<void>;
  readonly canReset: boolean;
}
