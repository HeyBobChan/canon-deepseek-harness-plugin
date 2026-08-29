import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import Schema from '@deepseek-ai/schemastery';

export interface PluginConfig {
  /** Canon profile saved by `canon-dsh-register`; empty means auto-select. */
  canonProfile?: string;
  /** Absolute DSH workspace used for every Canon-created session. */
  workspaceRoot: string;
  /** Optional provider route override supplied by the DSH profile. */
  provider?: string;
  /** Optional model override supplied by the DSH profile. */
  model?: string;
}

export const DSH_PLUGIN_CONFIG_KEYS = [
  'canonProfile',
  'workspaceRoot',
  'provider',
  'model',
] as const satisfies ReadonlyArray<keyof PluginConfig>;

const configShape = Schema.object({
  canonProfile: Schema.string().default(''),
  workspaceRoot: Schema.string().default(process.cwd()),
  provider: Schema.string(),
  model: Schema.string(),
});

// The third argument puts Schemastery's Standard Schema resolver in strict
// mode, dropping keys that are not part of the Canon DSH plugin contract.
export const Config = Schema.transform(configShape, (value) => value, true);

export function normalizePluginConfig(value: PluginConfig): PluginConfig {
  const canonProfile = value.canonProfile?.trim() || undefined;
  const provider = value.provider?.trim();
  const model = value.model?.trim();
  if ((provider && !model) || (!provider && model)) {
    throw new Error('canon-dsh: provider and model must be configured together');
  }

  return {
    canonProfile,
    workspaceRoot: resolveWorkspaceRoot(value.workspaceRoot),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

export function resolveWorkspaceRoot(value: string | undefined): string {
  const workspaceRoot = resolve(value ?? process.cwd());
  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    throw new Error(`canon-dsh: workspaceRoot is not an existing directory: ${workspaceRoot}`);
  }
  return workspaceRoot;
}
