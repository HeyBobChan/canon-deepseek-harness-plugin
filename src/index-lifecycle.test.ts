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
  startImplementation: null as null | (() => Promise<void>),
  stopImplementation: null as null | (() => Promise<void>),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const bridgeCapture = vi.hoisted(() => ({
  instances: [] as unknown[],
}));

vi.mock('@canonmsg/core', () => core);
vi.mock('@canonmsg/agent-tools', () => ({
  canonCommunicateToolDefinition: (name = 'communicate') => ({
    name,
    description: 'Communicate in Canon.',
    inputSchema: { type: 'object' },
  }),
  parseCommunicateToolInput: (value: unknown) => value,
}));
vi.mock('@canonmsg/agent-sdk', () => ({
  CanonAgent: class {
    constructor(options: Record<string, unknown>) {
      agentSdk.constructedOptions.push(options);
      const instance = {
        on: vi.fn(),
        start: vi.fn(() => agentSdk.startImplementation?.() ?? Promise.resolve()),
        stop: vi.fn(() => agentSdk.stopImplementation?.() ?? Promise.resolve()),
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
  agentSdk.startImplementation = null;
  agentSdk.stopImplementation = null;
  bridgeCapture.instances.length = 0;
});

function makeContext() {
  return {
    effect: vi.fn(() => () => undefined),
    on: vi.fn(() => () => undefined),
    logger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn() })),
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

  it('registers Canon as the explicit DSH question provider and binds plan mode', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'canon-dsh-questions-'));
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
    const setPlanMode = vi.fn();
    const registerProvider = vi.fn();
    const context = makeContext() as ReturnType<typeof makeContext> & {
      inject: ReturnType<typeof vi.fn>;
    };
    context.inject = vi.fn(async (dependencies: string[], callback: (ctx: unknown) => void) => {
      if (dependencies.includes('planMode')) {
        callback({ ...context, planMode: { set: setPlanMode } });
      } else if (dependencies.includes('userQuestions')) {
        callback({ ...context, userQuestions: { registerProvider } });
      }
    });

    await apply(context as never, {
      canonProfile: 'my-dsh',
      workspaceRoot,
      questionProvider: 'canon',
      planMode: true,
    });

    expect(registerProvider).toHaveBeenCalledWith({ ask: expect.any(Function) });
    expect(agentSdk.constructedOptions[0]?.runtimeDescriptor).toMatchObject({
      turnModes: [
        expect.objectContaining({ id: 'normal' }),
        expect.objectContaining({ id: 'plan' }),
      ],
    });
    expect((bridgeCapture.instances[0] as {
      deps?: { getPlanMode?: () => unknown };
    }).deps?.getPlanMode?.()).toEqual({ set: setPlanMode });
  });

  it('becomes active without awaiting the long-lived Canon SSE loop', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'canon-dsh-sse-'));
    temporaryDirectories.push(workspaceRoot);
    const stream = deferred<void>();
    agentSdk.startImplementation = () => stream.promise;
    agentSdk.stopImplementation = async () => stream.resolve();
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
    const effects: Array<() => Promise<void>> = [];
    const context = {
      ...makeContext(),
      effect: vi.fn((effect: () => () => Promise<void>) => {
        effects.push(effect());
        return () => undefined;
      }),
    };

    await expect(apply(context as never, {
      canonProfile: 'my-dsh',
      workspaceRoot,
    })).resolves.toBeUndefined();

    const agent = agentSdk.instances[0];
    if (!agent) throw new Error('expected Canon agent instance');
    expect(agent.start).toHaveBeenCalledTimes(1);
    expect(effects).toHaveLength(1);

    await effects[0]?.();

    expect(agent.stop).toHaveBeenCalledTimes(1);
  });

  it('disposes bridge resources when Canon startup fails asynchronously', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'canon-dsh-start-failure-'));
    temporaryDirectories.push(workspaceRoot);
    const stream = deferred<void>();
    const release = vi.fn();
    agentSdk.startImplementation = () => stream.promise;
    core.resolveCanonProfile.mockReturnValueOnce({
      apiKey: 'test-key',
      profile: 'my-dsh',
      environmentId: 'canon-dev-v1',
      baseUrl: 'https://api.example',
      streamUrl: 'https://stream.example',
      rtdbUrl: 'https://rtdb.example',
      firebaseApiKey: 'key',
      lockHandle: { release },
    });
    core.verifyResolvedAgentEnvironment.mockResolvedValueOnce(undefined);
    const context = makeContext();

    await apply(context as never, { canonProfile: 'my-dsh', workspaceRoot });
    stream.reject(new Error('authentication failed'));

    const agent = agentSdk.instances[0];
    if (!agent) throw new Error('expected Canon agent instance');
    await vi.waitFor(() => expect(agent.stop).toHaveBeenCalledTimes(1));
    expect(release).toHaveBeenCalledTimes(1);
    expect(context.logger).toHaveBeenCalledWith('canon-dsh');
  });
});
