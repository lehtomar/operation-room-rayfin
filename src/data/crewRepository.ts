import type { RayfinClient } from '@microsoft/rayfin-client';

import type { AppSchema } from '../../rayfin/data/schema';
import type { CrewDefinition } from '../lib/types';
import { bootstrapAuth } from '../services/bootstrap';
import { getRayfinClient } from '../services/rayfinClient';

export interface CrewRepository {
  list(): Promise<CrewDefinition[]>;
  create(crew: CrewDefinition): Promise<void>;
  update(crew: CrewDefinition): Promise<void>;
  delete(id: string): Promise<void>;
}

const STORAGE_KEY = 'gridwatch:crew-roster:v1';

function localBrowser(): boolean {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

class BrowserCrewRepository implements CrewRepository {
  async list(): Promise<CrewDefinition[]> {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('The locally saved crew roster is invalid.');
    return parsed as CrewDefinition[];
  }

  private async write(crews: CrewDefinition[]): Promise<void> {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(crews));
  }

  async create(crew: CrewDefinition): Promise<void> {
    const crews = await this.list();
    await this.write([...crews, { ...crew, id: crypto.randomUUID() }]);
  }

  async update(crew: CrewDefinition): Promise<void> {
    if (!crew.id) throw new Error('Cannot update a crew without an ID.');
    const crews = await this.list();
    await this.write(crews.map((item) => (item.id === crew.id ? crew : item)));
  }

  async delete(id: string): Promise<void> {
    const crews = await this.list();
    await this.write(crews.filter((crew) => crew.id !== id));
  }
}

class RayfinCrewRepository implements CrewRepository {
  constructor(private readonly client: RayfinClient<AppSchema>) {}

  async list(): Promise<CrewDefinition[]> {
    const rows = await this.client.data.Crew.select([
      'id',
      'crew_id',
      'callsign',
      'skills',
      'depot_lat',
      'depot_lon',
      'shift_start',
      'shift_end',
    ])
      .orderBy({ crew_id: 'asc' })
      .execute();
    return (rows as unknown as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      crew_id: String(row.crew_id),
      callsign: String(row.callsign),
      skills: String(row.skills).split(',').filter(Boolean),
      depot: { lat: Number(row.depot_lat), lon: Number(row.depot_lon) },
      shiftStart: new Date(row.shift_start as string).toISOString(),
      shiftEnd: new Date(row.shift_end as string).toISOString(),
    }));
  }

  async create(crew: CrewDefinition): Promise<void> {
    await this.client.data.Crew.create({
      crew_id: crew.crew_id,
      callsign: crew.callsign,
      skills: crew.skills.join(','),
      depot_lat: crew.depot.lat.toFixed(6),
      depot_lon: crew.depot.lon.toFixed(6),
      lat: crew.depot.lat.toFixed(6),
      lon: crew.depot.lon.toFixed(6),
      status: 'idle',
      shift_start: new Date(crew.shiftStart),
      shift_end: new Date(crew.shiftEnd),
      updated_at: new Date(),
    });
  }

  async update(crew: CrewDefinition): Promise<void> {
    if (!crew.id) throw new Error('Cannot update a crew without an ID.');
    await this.client.data.Crew.update(
      { id: crew.id },
      {
        crew_id: crew.crew_id,
        callsign: crew.callsign,
        skills: crew.skills.join(','),
        depot_lat: crew.depot.lat.toFixed(6),
        depot_lon: crew.depot.lon.toFixed(6),
        shift_start: new Date(crew.shiftStart),
        shift_end: new Date(crew.shiftEnd),
        updated_at: new Date(),
      }
    );
  }

  async delete(id: string): Promise<void> {
    await this.client.data.Crew.delete({ id });
  }
}

export async function createCrewRepository(): Promise<CrewRepository> {
  if (localBrowser()) return new BrowserCrewRepository();
  const auth = bootstrapAuth();
  await auth.initEmbeddedAuth();
  return new RayfinCrewRepository(getRayfinClient() as RayfinClient<AppSchema>);
}
