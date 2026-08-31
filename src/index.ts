import { CanonAgent } from '@canonmsg/agent-sdk';
import {
  resolveCanonAgent,
  resolveCanonProfile,
  verifyResolvedAgentEnvironment,
} from '@canonmsg/core';
import type { Context } from '@deepseek-ai/cordis';
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode';
import type {} from '@deepseek-ai/dsh-user-questions';

import { DeepSeekHarnessBridge, createRuntimeSignalHandlers } from './bridge.js';
import { Config, normalizePluginConfig, type PluginConfig } from './config.js';
import { createDeepSeekHarnessRuntimeDescriptor } from './runtime.js';

export const name = 'canon-dsh';

export const inject = [
  'agents',
  'attachments',
  'sessions',
  'approval',
  'sessionPersistence',
  'tools',
];

export { Config };
export type { PluginConfig };

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const config = normalizePluginConfig(rawConfig);
  let planMode: Pick<PlanModeController, 'set'> | undefined;
  if (config.planMode) {
    await ctx.inject(['planMode'], (planContext) => {
      planMode = planContext.planMode;
      return () => {
        planMode = undefined;
      };
    });
  }
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
  let startTask: Promise<void> | undefined;
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
      runtimeDescriptor: createDeepSeekHarnessRuntimeDescriptor(
        config.workspaceRoot,
        config.planMode === true,
      ),
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
      getPlanMode: () => planMode,
    });
    const log = ctx.logger(name);

    if (config.questionProvider === 'canon') {
      await ctx.inject(['userQuestions'], (questionContext) => {
        questionContext.userQuestions.registerProvider({
          ask: (request) => {
            if (!bridge) throw new Error('canon-dsh: bridge is unavailable');
            return bridge.answerUserQuestions(request);
          },
        });
      });
    }

    // CanonAgent.start() owns the long-lived SSE read loop. Register teardown
    // first, then launch that loop without holding the Cordis fiber in LOADING.
    // Initial connection failures still dispose every bridge-owned resource;
    // the SDK's own reconnect loop handles ordinary stream interruptions.
    ctx.effect(() => async () => {
      await bridge?.dispose();
      await startTask?.catch(() => undefined);
    }, 'canon-dsh.bridge');
    startTask = bridge.start();
    void startTask.catch(async (error) => {
      log.error('Canon SDK startup failed: %s', errorMessage(error));
      try {
        await bridge?.dispose();
      } catch (disposeError) {
        log.error('Canon SDK startup cleanup failed: %s', errorMessage(disposeError));
      }
    });
  } catch (error) {
    await bridge?.dispose();
    if (!bridge) {
      await canonAgent?.stop().catch(() => undefined);
      profile.lockHandle?.release();
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default { name, inject, Config, apply };
