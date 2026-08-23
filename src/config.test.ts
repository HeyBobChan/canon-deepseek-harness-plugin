import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import {
  Config,
  DSH_PLUGIN_CONFIG_KEYS,
  normalizePluginConfig,
} from './config.js';

const packageRoot = join(import.meta.dirname, '..');

it('declares only the Canon DSH config fields used by the patch', () => {
  expect(DSH_PLUGIN_CONFIG_KEYS).toEqual([
    'canonProfile',
    'workspaceRoot',
    'provider',
    'model',
  ]);
});

it('keeps row-level disabled outside the plugin config', () => {
  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8');
  const config = patch.split(/\n(?=      disabled:)/)[0];
  expect(config).toContain('        model:');
  expect(config).not.toContain('        disabled:');
  expect(patch).toContain('      disabled: !!js process.env.CANON_DSH_DISABLED');
});

it('normalizes an explicit workspace and paired model route', () => {
  const config = normalizePluginConfig({
    canonProfile: 'my-dsh',
    workspaceRoot: packageRoot,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  });

  expect(config).toEqual({
    canonProfile: 'my-dsh',
    workspaceRoot: packageRoot,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  });
});

it('allows profile auto-selection and rejects half a model route', () => {
  expect(normalizePluginConfig({ workspaceRoot: packageRoot }).canonProfile)
    .toBeUndefined();
  expect(() => normalizePluginConfig({
    workspaceRoot: packageRoot,
    provider: 'deepseek-official',
  })).toThrow(/provider and model must be configured together/);
});

it('uses a strict Schemastery schema', () => {
  expect(Config).toBeTypeOf('function');
  const resolved = (Config as unknown as (value: unknown) => Record<string, unknown>)({
    canonProfile: 'my-dsh',
    workspaceRoot: packageRoot,
    dshProfile: 'web',
  });
  expect(resolved).toEqual({
    canonProfile: 'my-dsh',
    workspaceRoot: packageRoot,
  });
});
