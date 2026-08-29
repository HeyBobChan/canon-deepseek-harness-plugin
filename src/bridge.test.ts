import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { CanonAgent } from '@canonmsg/agent-sdk';
import type { ResolvedAgent } from '@canonmsg/core';

import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { DeepSeekHarnessBridge } from './bridge.js';
import { TurnProjection } from './event-mapping.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const temporaryDirectories: string[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

function createMessageContext(input: {
  id?: string;
  text?: string;
  controller?: AbortController;
  requestedTurnMode?: string | null;
} = {}) {
  const controller = input.controller ?? new AbortController();
  const id = input.id ?? 'message-1';
  const text = input.text ?? 'Please run the tests.';
  return {
    abortSignal: controller.signal,
    controller,
    messages: [{
      id,
      senderId: 'owner-1',
      senderName: 'Owner',
      senderType: 'human' as const,
      isOwner: true,
      contentType: 'text' as const,
      text,
      attachments: [],
      mentions: [],
      replyTo: null,
      replyToPosition: null,
      status: 'sent' as const,
      deleted: false,
      createdAt: '2026-08-23T00:00:00.000Z',
    }],
    conversationId: 'conversation-1',
    requestedTurnMode: input.requestedTurnMode ?? null,
    conversation: { type: 'direct' as const, memberIds: ['owner-1', 'agent-dsh'] },
    turnContext: {
      schema: 'canon.turn.v2' as const,
      conversation: { id: 'conversation-1', type: 'direct' as const, memberCount: 2 },
      provenance: {
        sender: {
          id: 'owner-1',
          name: 'Owner',
          type: 'human' as const,
          isOwner: true,
        },
        mentionedAgent: false,
        activeSelfContext: null,
      },
      message: { id, contentType: 'text' as const, renderedContent: text },
    },
    agent: { agentId: 'agent-dsh' },
    turn: { setThinking: vi.fn(async () => undefined) },
    requestRuntimeInput: vi.fn(),
    requestPlanReview: vi.fn(),
    replyFinal: vi.fn(async () => ({ messageId: 'final', messageIds: ['final'] })),
  };
}

afterEach(async () => {
  await Promise.allSettled(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
  temporaryDirectories.length = 0;
});

async function createBridge(
  directoryOverride?: string,
  profileName = 'my-dsh',
  planMode?: { set: ReturnType<typeof vi.fn> },
) {
  const directory = directoryOverride ?? await mkdtemp(join(tmpdir(), 'canon-dsh-bridge-'));
  if (directoryOverride === undefined) temporaryDirectories.push(directory);
  const listeners = new Map<string, unknown>();
  const context = {
    on: vi.fn((name: string, listener: unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
    logger: () => ({ warn: vi.fn() }),
    sessions: {},
    agents: {},
    sessionPersistence: {},
  } as unknown as Context & {
    on: Context['on'];
    sessions: Context['sessions'];
    agents: Context['agents'];
    sessionPersistence: Context['sessionPersistence'];
  };
  const stop = vi.fn(async () => undefined);
  const clearRuntimeActivity = vi.fn(async () => undefined);
  const publishRuntimeActivity = vi.fn(async () => undefined);
  const canonAgent = {
    stop,
    clearRuntimeActivity,
    publishRuntimeActivity,
  } as unknown as CanonAgent;
  const release = vi.fn();
  const profile = {
    profile: profileName,
    agentId: `agent-${profileName}`,
    lockHandle: { release },
  } as unknown as ResolvedAgent;
  const bridge = new DeepSeekHarnessBridge({
    context,
    config: {
      canonProfile: profileName,
      workspaceRoot: directory,
      ...(planMode ? { planMode: true } : {}),
    },
    profile,
    canonAgent,
    ...(planMode ? { getPlanMode: () => planMode } : {}),
    stateRoot: join(directory, '.test-canon-home'),
  });
  return { bridge, context, canonAgent, listeners, release, directory, publishRuntimeActivity };
}

describe('DeepSeek Harness bridge lifecycle', () => {
  it('answers DSH questions through Canon structured input cards', async () => {
    const { bridge } = await createBridge();
    const canonContext = createMessageContext();
    canonContext.requestRuntimeInput.mockResolvedValueOnce({
      status: 'submitted',
      inputId: 'input-1',
      answers: {
        color: { answers: ['dsh-option-1-1', 'Muted accents'] },
      },
    });
    const internals = bridge as unknown as {
      conversationsBySessionId: Map<string, string>;
      activeTurns: Map<string, unknown>;
    };
    internals.conversationsBySessionId.set('session-1', 'conversation-1');
    internals.activeTurns.set('conversation-1', {
      conversationId: 'conversation-1',
      canonContext,
      projection: new TurnProjection(),
      toolCallIds: new Set(),
      toolNamesByCallId: new Map(),
    });

    const answer = await bridge.answerUserQuestions({
      agent: { id: 'session-1' } as never,
      questions: [{
        id: 'color',
        question: 'Pick colors',
        options: [{ label: 'Blue' }, { label: 'Green' }],
        multiSelect: true,
      }],
    });

    expect(canonContext.requestRuntimeInput).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'clarify',
      title: 'DeepSeek Harness needs input',
      questions: [expect.objectContaining({
        id: 'color',
        allowOther: true,
        choices: [
          expect.objectContaining({ label: 'Blue', value: 'dsh-option-1-1' }),
          expect.objectContaining({ label: 'Green', value: 'dsh-option-1-2' }),
        ],
      })],
    }));
    expect(answer).toEqual({
      answers: [{ id: 'color', selected: ['Blue'], custom: 'Muted accents' }],
    });
  });

  it('renders DSH plan review through Canon native plan cards', async () => {
    const { bridge } = await createBridge();
    const canonContext = createMessageContext();
    canonContext.requestPlanReview.mockResolvedValueOnce({
      status: 'revise',
      planId: 'plan-1',
      feedback: 'Include rollback.',
    });
    const internals = bridge as unknown as {
      conversationsBySessionId: Map<string, string>;
      activeTurns: Map<string, unknown>;
    };
    internals.conversationsBySessionId.set('session-1', 'conversation-1');
    internals.activeTurns.set('conversation-1', {
      conversationId: 'conversation-1',
      canonContext,
      projection: new TurnProjection(),
      toolCallIds: new Set(),
      toolNamesByCallId: new Map(),
    });

    const answer = await bridge.answerUserQuestions({
      agent: { id: 'session-1' } as never,
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan?',
        detail: '# Plan\n\n1. Change the adapter.',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    });

    expect(canonContext.requestPlanReview).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Plan review',
      summary: 'Approve this plan?',
      body: '# Plan\n\n1. Change the adapter.',
    }));
    expect(answer).toEqual({
      answers: [{ id: 'plan-review', selected: [], custom: 'Include rollback.' }],
    });
  });

  it('applies Canon next-turn plan mode and restores the default on the next message', async () => {
    const planMode = { set: vi.fn() };
    const { bridge, context } = await createBridge(undefined, 'my-dsh', planMode);
    let sessionId = '';
    let persisted = false;
    const agent = {
      id: '',
      followup: vi.fn(),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => undefined),
      session: { id: '' },
    };
    (context.agents as Mutable<Context['agents']>).create = vi.fn(async (options: { sessionId: string }) => {
      sessionId = options.sessionId;
      agent.id = sessionId;
      agent.session.id = sessionId;
      return { agent, dispose: vi.fn(async () => undefined) };
    });
    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => (
      persisted ? [{ id: sessionId }] : []
    ));
    (context.sessions as Mutable<Context['sessions']>).flush = vi.fn(async () => {
      persisted = true;
      return true;
    });

    await (bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(createMessageContext({ requestedTurnMode: 'plan' }));
    await (bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(createMessageContext({ id: 'message-2' }));

    expect(planMode.set).toHaveBeenNthCalledWith(1, agent, true);
    expect(planMode.set).toHaveBeenNthCalledWith(2, agent, false);
  });

  it('creates a session through the agent factory', async () => {
    const { bridge, context } = await createBridge();
    const cancel = vi.fn();
    const dispose = vi.fn(async () => undefined);
    const agent = {
      id: 'session-id',
      cancel,
      whenIdle: vi.fn(async () => undefined),
      session: {},
    };
    (context.agents as Mutable<Context['agents']>).create = vi.fn(async () => ({
      agent,
      dispose,
    }));
    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);

    const owned = await (bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<{ sessionId: string }>;
    }).acquireSession('conversation-1');

    expect(owned.sessionId).toMatch(/^canon-[0-9a-f]{64}-0$/);
    expect(context.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: expect.any(String) },
      signal: expect.any(AbortSignal),
    }));
  });

  it('fails closed when a confirmed session is missing from DSH persistence', async () => {
    const first = await createBridge();
    const dispose = vi.fn(async () => undefined);
    (first.context.agents as Mutable<Context['agents']>).create = vi.fn(async () => ({
      agent: {
        id: 'session-id',
        cancel: vi.fn(),
        whenIdle: vi.fn(async () => undefined),
        session: {},
      },
      dispose,
    }));
    (first.context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);
    const owned = await (first.bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<{ sessionId: string }>;
    }).acquireSession('conversation-1');
    await (first.bridge as unknown as {
      sessionMap: { confirm: (conversationId: string, sessionId: string) => Promise<unknown> };
    }).sessionMap.confirm('conversation-1', owned.sessionId);

    const second = await createBridge(first.directory);
    (second.context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);
    await expect((second.bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<unknown>;
    }).acquireSession('conversation-1')).rejects.toThrow(/persisted DSH session .* is missing/);
  });

  it('returns an aborted turn without waiting for acquisition and preserves the session', async () => {
    const { bridge, context } = await createBridge();
    const creating = deferred<{ agent: unknown; dispose: () => Promise<void> }>();
    const followup = vi.fn();
    const cancel = vi.fn();
    const dispose = vi.fn(async () => undefined);
    let sessionId = '';
    let persisted = false;
    (context.agents as Mutable<Context['agents']>).create = vi.fn((options: { sessionId: string }) => {
      sessionId = options.sessionId;
      return creating.promise;
    });
    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => (
      persisted ? [{ id: sessionId }] : []
    ));
    (context.sessions as Mutable<Context['sessions']>).flush = vi.fn(async () => {
      persisted = true;
      return true;
    });
    const first = createMessageContext();

    const handling = (bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(first);
    await vi.waitFor(() => expect(context.agents.create).toHaveBeenCalledTimes(1));
    first.controller.abort();
    await expect(handling).resolves.toBeUndefined();

    creating.resolve({
      agent: {
        id: sessionId,
        cancel,
        followup,
        whenIdle: vi.fn(async () => undefined),
        session: { id: sessionId },
      },
      dispose,
    });
    await vi.waitFor(() => expect(
      (bridge as unknown as { sessions: Map<string, unknown> }).sessions.has('conversation-1'),
    ).toBe(true));

    expect(followup).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(first.replyFinal).not.toHaveBeenCalled();

    const second = createMessageContext({ id: 'message-2' });
    await (bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(second);
    expect(context.agents.create).toHaveBeenCalledTimes(1);
    expect(followup).toHaveBeenCalledTimes(1);
    expect(second.replyFinal).toHaveBeenCalledTimes(1);
  });

  it('withdraws an unclaimed Canon prompt without clearing unrelated DSH inbox work', async () => {
    const { bridge, context } = await createBridge();
    const stored = await (bridge as unknown as {
      sessionMap: { getOrCreate: (conversationId: string) => Promise<{ sessionId: string }> };
    }).sessionMap.getOrCreate('conversation-1');
    const idle = deferred<void>();
    const remove = vi.fn(() => true);
    const cancel = vi.fn();
    const followup = vi.fn();
    const agent = {
      id: stored.sessionId,
      inbox: { remove },
      cancel,
      followup,
      whenIdle: vi.fn(() => idle.promise),
      session: {},
    };
    (bridge as unknown as { sessions: Map<string, unknown> }).sessions.set('conversation-1', {
      conversationId: 'conversation-1',
      sessionId: stored.sessionId,
      confirmed: true,
      handle: { agent, dispose: vi.fn(async () => undefined) },
    });
    (context.sessions as Mutable<Context['sessions']>).flush = vi.fn(async () => true);
    const message = createMessageContext();

    const handling = (bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(message);
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1));
    message.controller.abort();
    idle.resolve();
    await handling;

    const submitted = followup.mock.calls[0][0] as { id: string };
    expect(remove).toHaveBeenCalledWith(submitted.id);
    expect(cancel).not.toHaveBeenCalled();
    expect(message.replyFinal).not.toHaveBeenCalled();
  });

  it('does not leak turn state for a context that is already aborted', async () => {
    const { bridge, context } = await createBridge();
    const creating = deferred<{ agent: unknown; dispose: () => Promise<void> }>();
    (context.agents as Mutable<Context['agents']>).create = vi.fn(() => creating.promise);
    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);
    const controller = new AbortController();
    controller.abort();
    const message = createMessageContext({ controller });

    await expect((bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(message)).resolves.toBeUndefined();
    expect((bridge as unknown as { activeTurns: Map<string, unknown> }).activeTurns.size).toBe(0);

    creating.resolve({
      agent: {
        id: 'session-id',
        cancel: vi.fn(),
        followup: vi.fn(),
        whenIdle: vi.fn(async () => undefined),
        session: {},
      },
      dispose: vi.fn(async () => undefined),
    });
    await vi.waitFor(() => expect(
      (bridge as unknown as { sessions: Map<string, unknown> }).sessions.size,
    ).toBe(1));
  });

  it('starts a new generation without waiting for an older acquisition', async () => {
    const { bridge, context } = await createBridge();
    const creations = [
      deferred<{ agent: unknown; dispose: () => Promise<void> }>(),
      deferred<{ agent: unknown; dispose: () => Promise<void> }>(),
    ];
    const sessionIds: string[] = [];
    const persisted = new Set<string>();
    (context.agents as Mutable<Context['agents']>).create = vi.fn((options: { sessionId: string }) => {
      sessionIds.push(options.sessionId);
      return creations[sessionIds.length - 1].promise;
    });
    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => (
      Array.from(persisted, (id) => ({ id }))
    ));
    (context.sessions as Mutable<Context['sessions']>).flush = vi.fn(async (session: { id: string }) => {
      persisted.add(session.id);
      return true;
    });

    const first = createMessageContext();
    const firstHandling = (bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(first);
    await vi.waitFor(() => expect(context.agents.create).toHaveBeenCalledTimes(1));
    first.controller.abort();
    await expect(firstHandling).resolves.toBeUndefined();
    await expect(bridge.newSession({
      conversationId: 'conversation-1',
      droppedMessageIds: [],
    })).resolves.toBeUndefined();

    const secondFollowup = vi.fn();
    const second = createMessageContext({ id: 'message-2' });
    const secondHandling = (bridge as unknown as {
      handleCanonMessage: (input: unknown) => Promise<void>;
    }).handleCanonMessage(second);
    await vi.waitFor(() => expect(context.agents.create).toHaveBeenCalledTimes(2));
    expect(sessionIds[0]).toMatch(/-0$/);
    expect(sessionIds[1]).toMatch(/-1$/);

    creations[1].resolve({
      agent: {
        id: sessionIds[1],
        cancel: vi.fn(),
        followup: secondFollowup,
        whenIdle: vi.fn(async () => undefined),
        session: { id: sessionIds[1] },
      },
      dispose: vi.fn(async () => undefined),
    });
    await secondHandling;
    expect(secondFollowup).toHaveBeenCalledTimes(1);
    expect(second.replyFinal).toHaveBeenCalledTimes(1);

    const staleDispose = vi.fn(async () => undefined);
    creations[0].resolve({
      agent: {
        id: sessionIds[0],
        cancel: vi.fn(),
        followup: vi.fn(),
        whenIdle: vi.fn(async () => undefined),
        session: { id: sessionIds[0] },
      },
      dispose: staleDispose,
    });
    await vi.waitFor(() => expect(staleDispose).toHaveBeenCalledTimes(1));
  });

  it('keeps unconfirmed empty sessions recoverable after restart', async () => {
    const first = await createBridge();
    (first.context.agents as Mutable<Context['agents']>).create = vi.fn(async () => ({
      agent: { id: 'first', cancel: vi.fn(), session: {} },
      dispose: vi.fn(async () => undefined),
    }));
    (first.context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);
    await (first.bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<unknown>;
    }).acquireSession('conversation-1');

    const restarted = await createBridge(first.directory);
    (restarted.context.agents as Mutable<Context['agents']>).create = vi.fn(async () => ({
      agent: { id: 'second', cancel: vi.fn(), session: {} },
      dispose: vi.fn(async () => undefined),
    }));
    (restarted.context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);
    await expect((restarted.bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<unknown>;
    }).acquireSession('conversation-1')).resolves.toBeDefined();
  });

  it('uses separate session maps for profiles sharing one workspace', async () => {
    const first = await createBridge(undefined, 'profile-a');
    const second = await createBridge(first.directory, 'profile-b');
    const firstPath = (first.bridge as unknown as { sessionMap: { path: string } }).sessionMap.path;
    const secondPath = (second.bridge as unknown as { sessionMap: { path: string } }).sessionMap.path;

    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).not.toContain(`${join(first.directory, '.canon')}/`);
    await expect((first.bridge as unknown as {
      sessionMap: { getOrCreate: (conversationId: string) => Promise<unknown> };
    }).sessionMap.getOrCreate('conversation-1')).resolves.toBeDefined();
    await expect((second.bridge as unknown as {
      sessionMap: { getOrCreate: (conversationId: string) => Promise<unknown> };
    }).sessionMap.getOrCreate('conversation-1')).resolves.toBeDefined();
  });

  it('keeps interrupt and stop-and-drop inbox semantics distinct', async () => {
    const { bridge, context } = await createBridge();
    const cancel = vi.fn();
    const agent = { id: 'session-id', cancel };
    (bridge as unknown as { sessions: Map<string, { handle: { agent: typeof agent } }> }).sessions
      .set('conversation-1', {
        conversationId: 'conversation-1',
        sessionId: 'session-id',
        handle: { agent },
      });

    await bridge.interrupt({ conversationId: 'conversation-1', droppedMessageIds: [] });
    await bridge.stopAndDrop({ conversationId: 'conversation-1', droppedMessageIds: [] });

    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true });
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' });
  });

  it('retires the old generation even when DSH disposal fails', async () => {
    const { bridge, context } = await createBridge();
    await (bridge as unknown as {
      sessionMap: { getOrCreate: (conversationId: string) => Promise<unknown> };
    }).sessionMap.getOrCreate('conversation-1');
    const cancel = vi.fn();
    const dispose = vi.fn(async () => {
      throw new Error('drain failed');
    });
    (bridge as unknown as { sessions: Map<string, unknown> }).sessions.set('conversation-1', {
      conversationId: 'conversation-1',
      sessionId: 'session-id',
      handle: { agent: { cancel }, dispose },
    });

    await expect(bridge.newSession({
      conversationId: 'conversation-1',
      droppedMessageIds: [],
    })).rejects.toThrow(/failed to dispose old DSH session/);

    expect((bridge as unknown as { sessions: Map<string, unknown> }).sessions.has('conversation-1'))
      .toBe(false);
    await expect((bridge as unknown as {
      sessionMap: { getOrCreate: (conversationId: string) => Promise<{ generation: number }> };
    }).sessionMap.getOrCreate('conversation-1')).resolves.toMatchObject({ generation: 1 });

    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);
    (context.agents as Mutable<Context['agents']>).create = vi.fn(async (options: { sessionId: string }) => ({
      agent: { id: options.sessionId, cancel: vi.fn(), session: {} },
      dispose: vi.fn(async () => undefined),
    }));
    await expect((bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<{ sessionId: string }>;
    }).acquireSession('conversation-1')).resolves.toMatchObject({ sessionId: expect.stringMatching(/-1$/) });
  });

  it('maps closed approval outcomes through an active Canon turn', async () => {
    const { bridge, listeners } = await createBridge();
    const answer = listeners.get('approval/request') as (
      request: {
        agent: { id: string };
        toolName: string;
        callId?: string;
        reason?: string;
        signal?: AbortSignal;
      },
      next: () => Promise<'unavailable'>,
    ) => Promise<string>;
    const requestApproval = vi.fn(async () => ({
      decision: 'allow',
      respondedBy: 'human-1',
    }));
    (bridge as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set('conversation-1', {
      conversationId: 'conversation-1',
      canonContext: {
        abortSignal: new AbortController().signal,
        requestApproval,
        turn: { id: 'turn-1' },
      },
      projection: {},
      toolCallIds: new Set(['call-canonical']),
    });
    (bridge as unknown as { conversationsBySessionId: Map<string, string> }).conversationsBySessionId.set(
      'dsh-session',
      'conversation-1',
    );
    expect(requestApproval).toHaveBeenCalledTimes(0);

    await expect(answer({
      agent: { id: 'dsh-session' },
      toolName: 'bash',
      callId: 'call-canonical',
      reason: 'Run tests',
    }, async () => 'unavailable')).resolves.toBe('allowed-once');
    expect(requestApproval).toHaveBeenCalledTimes(1);

    requestApproval.mockResolvedValueOnce({
      decision: 'deny',
      respondedBy: 'human-1',
    });
    await expect(answer({
      agent: { id: 'dsh-session' },
      toolName: 'bash',
      callId: 'call-canonical',
    }, async () => 'unavailable')).resolves.toBe('rejected');

    requestApproval.mockResolvedValueOnce({ decision: 'deny' });
    await expect(answer({
      agent: { id: 'dsh-session' },
      toolName: 'bash',
      callId: 'call-canonical',
    }, async () => 'unavailable')).resolves.toBe('unavailable');

    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      ignoreSessionRules: true,
      allowSessionRule: false,
      runtimeId: 'deepseek-harness',
    }));
  });

  it('sanitizes approval text and cancels the Canon card when DSH aborts', async () => {
    const { bridge, listeners } = await createBridge();
    const answer = listeners.get('approval/request') as (
      request: {
        agent: { id: string };
        toolName: string;
        callId?: string;
        reason?: string;
        signal?: AbortSignal;
      },
      next: () => Promise<'unavailable'>,
    ) => Promise<string>;
    const controller = new AbortController();
    const requestApproval = vi.fn((request: { signal?: AbortSignal }) => new Promise<never>(
      (_, reject) => {
        request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      },
    ));
    const activeAbort = new AbortController();
    (bridge as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set('conversation-1', {
      canonContext: {
        abortSignal: activeAbort.signal,
        requestApproval,
        turn: { id: 'turn-1' },
      },
      toolCallIds: new Set(['call-canonical']),
    });
    (bridge as unknown as { conversationsBySessionId: Map<string, string> }).conversationsBySessionId.set(
      'dsh-session',
      'conversation-1',
    );

    const pending = answer({
      agent: { id: 'dsh-session' },
      toolName: 'bash\n',
      callId: 'call-canonical',
      reason: `line one\nline two\n${'x'.repeat(400)}`,
      signal: controller.signal,
    }, async () => 'unavailable');
    controller.abort();
    await expect(pending).resolves.toBe('cancelled');

    const request = requestApproval.mock.calls[0]?.[0] as {
      toolName: string;
      toolSummary: string;
      signal?: AbortSignal;
    };
    expect(request.toolName).toBe('bash');
    expect(request.toolSummary).not.toMatch(/[\r\n\t]/);
    expect(request.toolSummary.length).toBeLessThanOrEqual(300);
    expect(request.signal?.aborted).toBe(true);
  });

  it('delegates approvals from a queued Web UI turn to the DSH answerer chain', async () => {
    const { bridge, listeners, publishRuntimeActivity } = await createBridge();
    const appendDelta = vi.fn();
    const active = {
      conversationId: 'conversation-1',
      canonContext: {
        abortSignal: new AbortController().signal,
        requestApproval: vi.fn(async () => ({
          decision: 'allow',
          respondedBy: 'human-1',
        })),
        turn: { appendDelta },
      },
      projection: new TurnProjection(),
      submittedMessageId: 'canon-message',
      dshTurn: 2,
      toolCallIds: new Set<string>(),
      toolNamesByCallId: new Map<string, string>(),
    };
    (bridge as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set('conversation-1', active);
    (bridge as unknown as { conversationsBySessionId: Map<string, string> }).conversationsBySessionId.set(
      'dsh-session',
      'conversation-1',
    );
    const claimed = listeners.get('agent/inbox/claimed') as (payload: {
      agent: { id: string };
      message: { id: string };
      turn: number;
    }) => void;
    const sessionEvent = listeners.get('session/event') as (session: {
      id: string;
    }, event: SessionEvent) => void;
    claimed({ agent: { id: 'dsh-session' }, message: { id: 'canon-message' }, turn: 2 });
    sessionEvent({ id: 'dsh-session' }, {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 0,
        callId: 'call-web',
        name: 'bash',
        arguments: '{}',
      },
    } as SessionEvent);

    const answer = listeners.get('approval/request') as (
      request: { agent: { id: string }; toolName: string; callId?: string },
      next: () => Promise<'unavailable'>,
    ) => Promise<string>;
    await expect(answer({
      agent: { id: 'dsh-session' },
      toolName: 'bash',
      callId: 'call-web',
    }, async () => 'unavailable')).resolves.toBe('unavailable');

    const canonicalContext = active.canonContext as { requestApproval: ReturnType<typeof vi.fn> };
    expect(canonicalContext.requestApproval).not.toHaveBeenCalled();
    expect(publishRuntimeActivity).not.toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ id: 'dsh-tool:call-web' }),
    );

    sessionEvent({ id: 'dsh-session' }, {
      type: 'tool/call',
      data: {
        turn: 2,
        step: 0,
        callId: 'call-canonical',
        name: 'bash',
        arguments: '{}',
      },
    } as SessionEvent);
    await expect(answer({
      agent: { id: 'dsh-session' },
      toolName: 'bash',
      callId: 'call-canonical',
    }, async () => 'unavailable')).resolves.toBe('allowed-once');
    expect(canonicalContext.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('correlates Canon output with only the claimed DSH message turn', async () => {
    const { bridge, listeners, publishRuntimeActivity } = await createBridge();
    const appendDelta = vi.fn();
    const active = {
      conversationId: 'conversation-1',
      canonContext: {
        abortSignal: new AbortController().signal,
        turn: { appendDelta },
      },
      projection: new TurnProjection(),
      submittedMessageId: 'canon-message',
    };
    (bridge as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set('conversation-1', active);
    (bridge as unknown as { conversationsBySessionId: Map<string, string> }).conversationsBySessionId.set(
      'dsh-session',
      'conversation-1',
    );

    const claimed = listeners.get('agent/inbox/claimed') as (payload: {
      agent: { id: string };
      message: { id: string };
      turn: number;
    }) => void;
    const sessionEvent = listeners.get('session/event') as (session: {
      id: string;
    }, event: unknown) => void;
    const chunk = (turn: number, text: string) => ({
      type: 'assistant/chunk',
      data: { turn, step: 0, chunk: { type: 'text-delta', index: 0, text } },
    });

    claimed({ agent: { id: 'dsh-session' }, message: { id: 'other-message' }, turn: 1 });
    sessionEvent({ id: 'dsh-session' }, chunk(1, 'web output'));
    expect(appendDelta).not.toHaveBeenCalled();
    expect(publishRuntimeActivity).not.toHaveBeenCalled();

    claimed({ agent: { id: 'dsh-session' }, message: { id: 'canon-message' }, turn: 2 });
    sessionEvent({ id: 'dsh-session' }, chunk(2, 'canon output'));
    expect(appendDelta).toHaveBeenCalledWith('canon output');
  });

  it('awaits pending runtime activity publications during disposal', async () => {
    const { bridge, canonAgent, listeners, publishRuntimeActivity } = await createBridge();
    let resolveActivity: () => void = () => undefined;
    publishRuntimeActivity.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveActivity = resolve;
    }));
    const active = {
      conversationId: 'conversation-1',
      canonContext: { abortSignal: new AbortController().signal },
      projection: new TurnProjection(),
      dshTurn: 1,
    };
    (bridge as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set('conversation-1', active);
    (bridge as unknown as { conversationsBySessionId: Map<string, string> }).conversationsBySessionId.set(
      'dsh-session',
      'conversation-1',
    );
    const sessionEvent = listeners.get('session/event') as (session: {
      id: string;
    }, event: SessionEvent) => void;
    sessionEvent({ id: 'dsh-session' }, {
      type: 'turn/start',
      data: { turn: 1 },
    } as SessionEvent);
    const dispose = bridge.dispose();
    resolveActivity();
    await dispose;
    expect(canonAgent.stop).toHaveBeenCalledTimes(1);
  });

  it('disposes Canon and DSH resources idempotently', async () => {
    const { bridge, canonAgent, release } = await createBridge();
    const dispose = vi.fn(async () => undefined);
    const cancel = vi.fn();
    (bridge as unknown as { sessions: Map<string, unknown> }).sessions.set('conversation-1', {
      handle: { agent: { cancel }, dispose },
    });

    await bridge.dispose();
    await bridge.dispose();

    expect(cancel).toHaveBeenCalledWith({ kind: 'disposed' });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(canonAgent.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('disposes an agent that finishes acquisition during plugin disposal', async () => {
    const { bridge, context } = await createBridge();
    const dispose = vi.fn(async () => undefined);
    let resolveCreate: (handle: { agent: unknown; dispose: () => Promise<void> }) => void = () => undefined;
    let acquisitionSignal: AbortSignal | undefined;
    (context.agents as Mutable<Context['agents']>).create = vi.fn((options) => new Promise((resolve) => {
      acquisitionSignal = options.signal;
      resolveCreate = resolve;
    }));
    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);

    const acquisition = (bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<unknown>;
    }).acquireSession('conversation-1');
    await vi.waitFor(() => expect(context.agents.create).toHaveBeenCalledTimes(1));
    const disposing = bridge.dispose();
    expect(acquisitionSignal?.aborted).toBe(true);
    resolveCreate({
      agent: {
        id: 'session-id',
        cancel: vi.fn(),
        whenIdle: vi.fn(async () => undefined),
        session: {},
      },
      dispose,
    });

    await expect(acquisition).rejects.toThrow(/plugin is disposed/);
    await disposing;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts an obsolete acquisition before advancing to a new session', async () => {
    const { bridge, context } = await createBridge();
    const creating = deferred<{ agent: unknown; dispose: () => Promise<void> }>();
    let acquisitionSignal: AbortSignal | undefined;
    (context.agents as Mutable<Context['agents']>).create = vi.fn((options) => {
      acquisitionSignal = options.signal;
      return creating.promise;
    });
    (context.sessionPersistence as Mutable<Context['sessionPersistence']>).list = vi.fn(async () => []);

    const acquisition = (bridge as unknown as {
      acquireSession: (conversationId: string) => Promise<unknown>;
    }).acquireSession('conversation-1');
    await vi.waitFor(() => expect(context.agents.create).toHaveBeenCalledTimes(1));

    await bridge.newSession({ conversationId: 'conversation-1', droppedMessageIds: [] });
    expect(acquisitionSignal?.aborted).toBe(true);

    const dispose = vi.fn(async () => undefined);
    creating.resolve({
      agent: { id: 'stale', cancel: vi.fn(), session: {} },
      dispose,
    });
    await expect(acquisition).rejects.toThrow(/superseded/);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
