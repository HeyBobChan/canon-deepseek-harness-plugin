import { describe, expect, it } from 'vitest';

import { apply, Config, inject, name } from './index.js';

describe('Canon DSH Cordis plugin', () => {
  it('exports a Canon row with its required DSH services', () => {
    expect(name).toBe('canon-dsh');
    expect(inject).toEqual([
      'agents',
      'sessions',
      'approval',
      'sessionPersistence',
    ]);
    expect(Config).toBeTypeOf('function');
    expect(apply).toBeTypeOf('function');
  });
});
