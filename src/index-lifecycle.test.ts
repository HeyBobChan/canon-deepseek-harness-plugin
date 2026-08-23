import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  CANON_DIR: '/tmp/canon-dsh-index-lifecycle-test',
  DEFAULT_FIRST_PARTY_RUNTIME_PRESENTATION: {
    preset: 'normal',
    fields: {
      cwd: { visibility: 'hidden' },
      worktreePath: { visibility: 'hidden' },
      workspaceRoot: { visibility: 'hidden' },
    },
  },
  resolveCanonProfile: vi.fn(),
  resolveCanonAgent: vi.fn(),
  verifyResolvedAgentEnvironment: vi.fn(),
}));

const agentSdk = vi.hoisted(() => ({
  constructedOptions: [] as Array<Record<string, unknown>>,
  instances: [] as Array<{
    on: (event: string, handler: unknown) => void;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }>,
}));

const bridgeCapture = vi.hoisted(() => ({
  instances: [] as unknown[],
}));

vi.mock('@canonmsg/core', () => core);
vi.mock('@canonmsg/agent-sdk', () => ({
  CanonAgent: class {
    constructor(options: Record<string, unknown>) {
      agentSdk.constructedOptions.push(options);
      const instance = {
        on: vi.fn(),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        clearRuntimeActivity: vi.fn(async () => undefined),
      };
      agentSdk.instances.push(instance);
      return instance;
    }
  },
}));
vi.mock('./bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge.js')>();
  return {
    ...actual,
    DeepSeekHarnessBridge: class extends actual.DeepSeekHarnessBridge {
      constructor(...args: ConstructorParameters<typeof actual.DeepSeekHarnessBridge>) {
        super(...args);
        bridgeCapture.instances.push(this);
      }
    },
  };
});

import { apply } from './index.js';
import type { DeepSeekHarnessBridge } from './bridge.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
  temporaryDirectories.length = 0;
  vi.clearAllMocks();
  agentSdk.constructedOptions.length = 0;
  agentSdk.instances.length = 0;
  bridgeCapture.instances.length = 0;
});

function makeContext() {
  return {
    effect: vi.fn(() => () => undefined),
    on: vi.fn(() => () => undefined),
    logger: vi.fn(() => ({ warn: vi.fn() })),
    sessions: {},
    agents: {},
    sessionPersistence: {},
  };
}

describe('Canon DSH plugin lifecycle', () => {
  it('releases the Canon profile lock when environment verification fails', async () => {
    const release = vi.fn();
    core.resolveCanonProfile.mockReturnValueOnce({
      apiKey: 'test-key',
      environmentId: 'canon-dev-v1',
      baseUrl: 'https://api.example',
      streamUrl: 'https://stream.example',
      rtdbUrl: 'https://rtdb.example',
      firebaseApiKey: 'key',
      lockHandle: { release },
    });
    core.verifyResolvedAgentEnvironment.mockRejectedValueOnce(
      new Error('environment unavailable'),
    );
    const effects: Array<() => Promise<void>> = [];
    const context = {
      effect: vi.fn((effect: () => () => Promise<void>) => {
        effects.push(effect());
        return () => undefined;
      }),
    };

    await expect(apply(context as never, {
      canonProfile: 'my-dsh',
      workspaceRoot: join(import.meta.dirname, '..'),
    })).rejects.toThrow('environment unavailable');

    expect(release).toHaveBeenCalledTimes(1);
    expect(effects).toHaveLength(0);
  });

  it('binds runtime controls to the constructed bridge through a live getter', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'canon-dsh-controls-'));
    temporaryDirectories.push(workspaceRoot);
    core.resolveCanonProfile.mockReturnValueOnce({
      apiKey: 'test-key',
      profile: 'my-dsh',
      environmentId: 'canon-dev-v1',
      baseUrl: 'https://api.example',
      streamUrl: 'https://stream.example',
      rtdbUrl: 'https://rtdb.example',
      firebaseApiKey: 'key',
    });
    core.verifyResolvedAgentEnvironment.mockResolvedValueOnce(undefined);

    await apply(makeContext() as never, {
      canonProfile: 'my-dsh',
      workspaceRoot,
    });

    expect(agentSdk.constructedOptions).toHaveLength(1);
    const controls = agentSdk.constructedOptions[0]?.runtimeControls as Record<
      'onInterrupt' | 'onStopAndDrop' | 'onNewSession',
      (context: { conversationId: string; droppedMessageIds: string[] }) => Promise<void>
    >;
    const bridge = bridgeCapture.instances[0] as DeepSeekHarnessBridge;
    const interrupt = vi.spyOn(bridge, 'interrupt');
    const stopAndDrop = vi.spyOn(bridge, 'stopAndDrop');
    const newSession = vi.spyOn(bridge, 'newSession');
    const context = { conversationId: 'conversation-1', droppedMessageIds: [] };

    await controls.onInterrupt(context);
    await controls.onStopAndDrop(context);
    await controls.onNewSession(context);

    expect(interrupt).toHaveBeenCalledWith(context);
    expect(stopAndDrop).toHaveBeenCalledWith(context);
    expect(newSession).toHaveBeenCalledWith(context);
  });
});
