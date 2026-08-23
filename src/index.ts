import { CanonAgent } from '@canonmsg/agent-sdk';
import {
  resolveCanonAgent,
  resolveCanonProfile,
  verifyResolvedAgentEnvironment,
} from '@canonmsg/core';
import type { Context } from '@deepseek-ai/cordis';

import { DeepSeekHarnessBridge, createRuntimeSignalHandlers } from './bridge.js';
import { Config, normalizePluginConfig, type PluginConfig } from './config.js';
import { createDeepSeekHarnessRuntimeDescriptor } from './runtime.js';

export const name = 'canon-dsh';

export const inject = [
  'agents',
  'sessions',
  'approval',
  'sessionPersistence',
];

export { Config };
export type { PluginConfig };

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const config = normalizePluginConfig(rawConfig);
  const profile = config.canonProfile
    ? resolveCanonProfile(config.canonProfile, {
      logPrefix: 'canon-dsh',
      expectedClientType: 'deepseek-harness',
      lock: true,
    })
    : resolveCanonAgent({
      logPrefix: 'canon-dsh',
      expectedClientType: 'deepseek-harness',
      lock: true,
    });
  let bridge: DeepSeekHarnessBridge | undefined;
  let canonAgent: CanonAgent | null = null;
  try {
    await verifyResolvedAgentEnvironment(profile);
    const runtimeControls = createRuntimeSignalHandlers(() => bridge);
    canonAgent = new CanonAgent({
      apiKey: profile.apiKey,
      environmentId: profile.environmentId,
      baseUrl: profile.baseUrl,
      streamUrl: profile.streamUrl,
      rtdbUrl: profile.rtdbUrl,
      firebaseApiKey: profile.firebaseApiKey,
      deliveryMode: 'sse',
      debounceMs: 500,
      clientType: 'deepseek-harness',
      runtimeDescriptor: createDeepSeekHarnessRuntimeDescriptor(config.workspaceRoot),
      runtimeControls,
      sessions: {
        enabled: true,
        concurrency: 4,
        idleTimeoutMs: 60 * 60_000,
      },
      turnVerbosity: 'auto',
    });
    bridge = new DeepSeekHarnessBridge({
      context: ctx,
      config,
      profile,
      canonAgent,
    });

    // Register cleanup before the async Canon connection starts, so plugin
    // replacement during startup cannot leak the SDK or profile lock.
    ctx.effect(() => () => bridge?.dispose(), 'canon-dsh.bridge');
    await bridge.start();
  } catch (error) {
    await bridge?.dispose();
    if (!bridge) {
      await canonAgent?.stop().catch(() => undefined);
      profile.lockHandle?.release();
    }
    throw error;
  }
}

export default { name, inject, Config, apply };
