import type { RayfinClient } from '@microsoft/rayfin-client';

import type { AppSchema } from '../../rayfin/data/schema';
import type { Crew, Incident, LiveState, Scenario } from '../lib/types';
import type { DataProvider } from './provider';

/**
 * Production provider — authenticated Rayfin GraphQL (Fabric SSO, in-portal).
 * Reads current state with plain selects; the frontend derives KPIs and the
 * de-energized set from this raw state + the static topology.
 */
export class RayfinProvider implements DataProvider {
  readonly canReset = false; // reset is a simulator/CLI operation

  constructor(private readonly client: RayfinClient<AppSchema>) {}

  async getState(): Promise<LiveState> {
    const [scenarioRows, incidents, crews] = await Promise.all([
      this.client.data.ScenarioState.select([
        'scenario_id',
        'status',
        'playing',
        'speed',
        'sim_clock',
      ]).execute(),
      this.client.data.Incident.select([
        'incident_id',
        'seg_id',
        'feeder_id',
        'ss_id',
        'fault_type',
        'status',
        'affected_kp',
        'affected_tr',
        'repair_effort_min',
        'crew_id',
        'eta_min',
        'started_at',
        'restored_at',
      ]).execute(),
      this.client.data.Crew.select([
        'crew_id',
        'callsign',
        'skills',
        'status',
        'lat',
        'lon',
        'current_incident_id',
      ]).execute(),
    ]);

    const s = scenarioRows[0] as unknown as Record<string, unknown> | undefined;
    const scenario: Scenario | null = s
      ? {
          scenario_id: String(s.scenario_id),
          status: String(s.status),
          playing: Boolean(s.playing),
          speed: Number(s.speed),
          sim_clock: new Date(s.sim_clock as string).toISOString(),
          elapsed_min: 0, // recomputed in App from scenario meta
          start: '',
        }
      : null;

    return {
      scenario,
      wind: null, // computed in App from scenario meta
      incidents: incidents as unknown as Incident[],
      crews: crews as unknown as Crew[],
    };
  }

  private async scenarioId(): Promise<string | null> {
    const rows = await this.client.data.ScenarioState.select(['id']).execute();
    return rows[0] ? String((rows[0] as unknown as Record<string, unknown>).id) : null;
  }

  private async setScenario(values: Record<string, unknown>): Promise<void> {
    const id = await this.scenarioId();
    if (!id) return;
    await this.client.data.ScenarioState.update({ id }, { ...values, updated_at: new Date() });
  }

  play() {
    return this.setScenario({ playing: true, status: 'running' });
  }
  pause() {
    return this.setScenario({ playing: false, status: 'paused' });
  }
  setSpeed(v: number) {
    return this.setScenario({ speed: v });
  }
  async reset(): Promise<void> {
    // Full reset clears live tables and is owned by the simulator/CLI; here we
    // only soft-reset the player so the UI stays consistent.
    await this.setScenario({ playing: false, status: 'idle' });
  }

  async dispatch(incidentId: string, crewId: string, etaMin: number): Promise<void> {
    await this.client.data.Assignment.create({
      incident_id: incidentId,
      crew_id: crewId,
      action: 'dispatch',
      eta_min: etaMin,
      ts: new Date(),
    });
  }
}
