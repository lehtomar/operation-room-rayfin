import { describe, expect, it } from 'vitest';

import { bootstrapAuth } from '../services/bootstrap';

describe('Rayfin bootstrap', () => {
  it('reuses the initialized auth service across page remounts', () => {
    const first = bootstrapAuth();

    expect(bootstrapAuth()).toBe(first);
  });
});
