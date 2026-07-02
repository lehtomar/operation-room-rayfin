import { bootstrapAuth } from '../services/bootstrap';
import { getRayfinClient } from '../services/rayfinClient';
import type { AppSchema } from '../../rayfin/data/schema';
import type { RayfinClient } from '@microsoft/rayfin-client';

import { DevProvider } from './devProvider';
import type { DataProvider } from './provider';
import { RayfinProvider } from './rayfinProvider';

/** Dev mode = the frontend itself is served from localhost (vite). */
export function isDevMode(): boolean {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

/**
 * In dev, read/control the simulator's local HTTP server (no auth).
 * In the Fabric portal, initialize the Rayfin client, silently pick up the
 * embedded Fabric session, and read/write via authenticated GraphQL.
 */
export async function createProvider(): Promise<DataProvider> {
  if (isDevMode()) return new DevProvider();

  const auth = bootstrapAuth();
  try {
    await auth.initEmbeddedAuth();
  } catch {
    // Not inside a Fabric iframe yet; interactive sign-in is offered by the UI.
  }
  return new RayfinProvider(getRayfinClient() as RayfinClient<AppSchema>);
}

export type { DataProvider };
