import type { IAuthService } from './IAuthService';
import { MockAuthService } from './MockAuthService';
import { RayfinAuthService } from './RayfinAuthService';
import { initRayfinClient } from './rayfinClient';

let authService: IAuthService | null = null;

function isLocalBackendUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Read VITE_* env vars, initialize the Rayfin client, and return the right
 * auth service for the target backend.
 *
 * - Localhost API URL → {@link MockAuthService}
 * - Anything else     → {@link RayfinAuthService} (requires VITE_FABRIC_* vars)
 */
export function bootstrapAuth(): IAuthService {
  if (authService) return authService;

  const apiUrl = import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168';
  const localDev = isLocalBackendUrl(apiUrl);
  const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;

  if (!publishableKey && !localDev) {
    throw new Error(
      'VITE_RAYFIN_PUBLISHABLE_KEY environment variable is required'
    );
  }

  if (localDev) {
    const client = initRayfinClient({
      baseUrl: apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
      publishableKey: publishableKey ?? 'local-dev-key',
      localDev,
    });
    authService = new MockAuthService(client);
    return authService;
  }

  const workspaceId = import.meta.env.VITE_FABRIC_WORKSPACE_ID;
  const projectId = import.meta.env.VITE_FABRIC_ITEM_ID;
  const fabricPortalUrl = import.meta.env.VITE_FABRIC_PORTAL_URL;

  if (!workspaceId || !projectId || !fabricPortalUrl) {
    throw new Error(
      'Missing required Fabric config. Set VITE_FABRIC_WORKSPACE_ID, VITE_FABRIC_ITEM_ID, and VITE_FABRIC_PORTAL_URL.'
    );
  }

  const client = initRayfinClient({
    baseUrl: apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    publishableKey,
    localDev,
  });
  authService = new RayfinAuthService(client, {
    workspaceId,
    projectId,
    fabricPortalUrl,
    returnOrigin: window.location.origin,
  });
  return authService;
}
