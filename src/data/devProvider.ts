import type { LiveState } from '../lib/types';
import type { DataProvider } from './provider';

const DEV_BASE =
  import.meta.env.VITE_SIM_URL || 'http://127.0.0.1:8787';

/** Local-dev provider backed by the simulator's HTTP state/control server. */
export class DevProvider implements DataProvider {
  readonly canReset = true;

  async getState(): Promise<LiveState> {
    const res = await fetch(`${DEV_BASE}/state`);
    if (!res.ok) throw new Error(`sim /state ${res.status}`);
    const s = await res.json();
    return {
      scenario: s.scenario ?? null,
      wind: s.wind ?? null,
      incidents: s.incidents ?? [],
      crews: s.crews ?? [],
    };
  }

  private async control(body: Record<string, unknown>): Promise<void> {
    await fetch(`${DEV_BASE}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  play() {
    return this.control({ action: 'play' });
  }
  pause() {
    return this.control({ action: 'pause' });
  }
  setSpeed(v: number) {
    return this.control({ action: 'speed', value: v });
  }
  reset() {
    return this.control({ action: 'reset' });
  }

  async dispatch(incidentId: string, crewId: string, etaMin: number): Promise<void> {
    await fetch(`${DEV_BASE}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incident_id: incidentId, crew_id: crewId, eta_min: etaMin }),
    });
  }
}
