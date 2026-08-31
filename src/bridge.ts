import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type { MessageId } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type {
  ApprovalOutcome,
  ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval';
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions';
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { CanonAgent } from '@canonmsg/agent-sdk';
import type { MessageHandlerContext } from '@canonmsg/agent-sdk';
import { CANON_DIR, type ResolvedAgent } from '@canonmsg/core';

import {
  TurnProjection,
  activityForSessionEvent,
  safeDisplayText,
} from './event-mapping.js';
import { createCanonUserMessage, importCanonImages } from './messages.js';
import {
  CanonSessionMap,
  dshSessionId,
} from './session-map.js';
import type { PluginConfig } from './config.js';
import {
  planReviewQuestion,
  toCanonQuestionBatch,
  toDshPlanAnswer,
  toDshQuestionAnswer,
} from './user-questions.js';
import {
  communicationIsEnabled,
  createDeepSeekHarnessCommunicationTool,
} from './communication-tool.js';
import { createDeepSeekHarnessNoReplyTool } from './no-reply-tool.js';

interface ActiveCanonTurn {
  conversationId: string;
  canonContext: MessageHandlerContext;
  projection: TurnProjection;
  submittedMessageId?: MessageId;
  dshTurn?: number;
  readonly toolCallIds: Set<string>;
  readonly toolNamesByCallId: Map<string, string>;
  disposeCommunicationTool?: () => void;
  disposeNoReplyTool?: () => void;
  noReplyRequested?: boolean;
}

interface OwnedDshSession {
  conversationId: string;
  sessionId: string;
  confirmed: boolean;
  handle: AgentHandle;
}

interface SessionAcquisition {
  conversationId: string;
  controller: AbortController;
  promise: Promise<OwnedDshSession>;
}

interface RuntimeSignalContext {
  conversationId: string;
  signal: 'interrupt' | 'stop_and_drop' | 'new_session';
  updatedAt?: number;
  abortSignal?: AbortSignal;
  droppedMessageIds: string[];
}

interface BridgeDeps {
  context: Context;
  config: PluginConfig;
  profile: ResolvedAgent;
  canonAgent: CanonAgent;
  getPlanMode?: () => Pick<PlanModeController, 'set'> | undefined;
  /** Test seam; production state belongs under CANON_HOME. */
  stateRoot?: string;
}

export class DeepSeekHarnessBridge {
  private readonly sessions = new Map<string, OwnedDshSession>();
  private readonly conversationsBySessionId = new Map<string, string>();
  private readonly activeTurns = new Map<string, ActiveCanonTurn>();
  private readonly sessionAcquisitions = new Map<string, SessionAcquisition>();
  private readonly sessionLifecycleTails = new Map<string, Promise<void>>();
  private readonly pendingActivityPublishes = new Set<Promise<void>>();
  private readonly pendingApprovalCancellers = new Set<AbortController>();
  private readonly sessionMap: CanonSessionMap;
  private readonly communicationTool: ToolDefinition;
  private readonly noReplyTool: ToolDefinition;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly deps: BridgeDeps) {
    const namespace = `${deps.profile.profile ?? deps.profile.agentId ?? 'default'}\0${deps.config.workspaceRoot}`;
    const namespaceHash = createHash('sha256').update(namespace).digest('hex');
    this.sessionMap = new CanonSessionMap(join(
      deps.stateRoot ?? CANON_DIR,
      'deepseek-harness',
      'session-maps',
      `${namespaceHash}.json`,
    ), namespace);
    this.communicationTool = createDeepSeekHarnessCommunicationTool((sessionId) => {
      const conversationId = this.conversationsBySessionId.get(sessionId);
      return conversationId === undefined
        ? undefined
        : this.activeTurns.get(conversationId)?.canonContext;
    });
    this.noReplyTool = createDeepSeekHarnessNoReplyTool(
      (sessionId) => {
        const conversationId = this.conversationsBySessionId.get(sessionId);
        return conversationId === undefined
          ? undefined
          : this.activeTurns.get(conversationId)?.canonContext;
      },
      (sessionId) => {
        const conversationId = this.conversationsBySessionId.get(sessionId);
        const active = conversationId === undefined
          ? undefined
          : this.activeTurns.get(conversationId);
        if (active) active.noReplyRequested = true;
      },
    );

    deps.context.on('session/event', (session: Session, event: SessionEvent) => {
      this.handleSessionEvent(session, event);
    });
    deps.context.on('agent/error', (payload: { agent: { id: SessionId } }) => {
      const conversationId = this.conversationsBySessionId.get(String(payload.agent.id));
      const active = conversationId === undefined
        ? undefined
        : this.activeTurns.get(conversationId);
      active?.projection.fail();
    });
    deps.context.on(
      'agent/inbox/claimed',
      (payload: { agent: { id: SessionId }; message: { id: string }; turn: number }) => {
        const conversationId = this.conversationsBySessionId.get(String(payload.agent.id));
        const active = conversationId === undefined
          ? undefined
          : this.activeTurns.get(conversationId);
        if (active?.submittedMessageId === payload.message.id) {
          active.dshTurn = payload.turn;
        }
      },
    );
    deps.context.on(
      'approval/request',
      (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => this.answerApproval(request, next),
    );
  }

  async start(): Promise<void> {
    this.deps.canonAgent.on('message', (context) => this.handleCanonMessage(context));
    await this.deps.canonAgent.start();
  }

  async answerUserQuestions(
    request: AskUserQuestionRequest,
  ): Promise<AskUserQuestionAnswer> {
    const sessionId = request.agent?.id;
    const conversationId = sessionId === undefined
      ? undefined
      : this.conversationsBySessionId.get(String(sessionId));
    const active = conversationId === undefined
      ? undefined
      : this.activeTurns.get(conversationId);
    if (sessionId === undefined || !active) {
      throw new UserQuestionError(
        'no active Canon turn owns this DSH user question',
        'NO_CANON_ROUTE',
      );
    }
    if (request.signal?.aborted || active.canonContext.abortSignal.aborted) {
      throw new UserQuestionError(
        'ask_user_question was aborted before the user answered',
        'ASK_ABORTED',
      );
    }

    const planQuestion = planReviewQuestion(request);
    if (planQuestion) {
      const result = await active.canonContext.requestPlanReview({
        planId: randomUUID(),
        title: safeDisplayText(planQuestion.header ?? 'Plan review', 'Plan review', 160),
        summary: safeDisplayText(planQuestion.question, 'Review the proposed plan.', 2_000),
        body: planQuestion.detail,
        turnId: active.canonContext.turn?.id,
        timeoutMs: 10 * 60_000,
        signal: request.signal,
      });
      if (result.status === 'approve' || result.status === 'revise' || result.status === 'reject') {
        return toDshPlanAnswer(planQuestion, result);
      }
      throw this.questionClosed(result.status);
    }

    const batch = toCanonQuestionBatch(request);
    const inputId = randomUUID();
    const result = await active.canonContext.requestRuntimeInput({
      inputId,
      kind: 'clarify',
      title: 'DeepSeek Harness needs input',
      prompt: 'Answer to continue the current DSH turn.',
      questions: batch.questions,
      native: {
        runtime: 'deepseek-harness',
        method: 'ask_user_question',
        requestId: inputId,
        sessionKey: String(sessionId),
        turnId: active.canonContext.turn?.id,
        handles: {},
      },
      turnId: active.canonContext.turn?.id,
      timeoutMs: 10 * 60_000,
      signal: request.signal,
    });
    if (result.status === 'submitted') {
      return toDshQuestionAnswer(batch, result.answers);
    }
    throw this.questionClosed(result.status);
  }

  async interrupt({ conversationId }: RuntimeSignalContext): Promise<void> {
    const session = this.sessions.get(conversationId);
    session?.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
  }

  async stopAndDrop({ conversationId }: RuntimeSignalContext): Promise<void> {
    const session = this.sessions.get(conversationId);
    session?.handle.agent.cancel({ kind: 'user' });
  }

  async newSession({ conversationId }: RuntimeSignalContext): Promise<void> {
    if (this.disposed) return;
    let retired: OwnedDshSession | undefined;
    await this.enqueueSessionLifecycle(conversationId, async () => {
      if (this.disposed) return;
      this.abortSessionAcquisitions(
        (acquisition) => acquisition.conversationId === conversationId,
        new Error(`canon-dsh: session acquisition superseded for ${conversationId}`),
      );
      retired = this.sessions.get(conversationId);
      if (retired) {
        this.sessions.delete(conversationId);
        this.conversationsBySessionId.delete(retired.sessionId);
        this.activeTurns.delete(conversationId);
      }
      await this.sessionMap.advanceOrCreate(conversationId);
    });

    let cleanupError: unknown;
    if (retired) {
      try {
        retired.handle.agent.cancel({ kind: 'user' });
        await retired.handle.dispose();
      } catch (error) {
        cleanupError = error;
      }
    }
    await this.deps.canonAgent.clearRuntimeActivity(conversationId, { all: true }).catch(() => undefined);
    if (cleanupError) {
      throw new Error(`canon-dsh: failed to dispose old DSH session: ${errorMessage(cleanupError)}`);
    }
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= this.disposeNow();
    return this.disposePromise;
  }

  private async disposeNow(): Promise<void> {
    this.disposed = true;
    this.abortSessionAcquisitions(
      () => true,
      new Error('canon-dsh: plugin disposed during session acquisition'),
    );

    await Promise.allSettled(Array.from(this.pendingActivityPublishes));
    for (const canceller of this.pendingApprovalCancellers) canceller.abort();
    try {
      await this.deps.canonAgent.stop();
    } catch (error) {
      this.log.warn('Canon SDK shutdown failed: %s', errorMessage(error));
    }

    await Promise.allSettled([
      ...Array.from(this.sessionAcquisitions.values(), (acquisition) => acquisition.promise),
      ...this.sessionLifecycleTails.values(),
    ]);

    await Promise.allSettled(Array.from(this.sessions.values(), async (session) => {
      try {
        session.handle.agent.cancel({ kind: 'disposed' });
        await session.handle.dispose();
      } catch (error) {
        this.log.warn('failed to dispose DSH session: %s', errorMessage(error));
      }
    }));
    this.sessions.clear();
    this.conversationsBySessionId.clear();
    this.activeTurns.clear();

    try {
      await this.sessionMap.flush();
    } catch {
      // Writes are atomic; a failed final flush must not prevent lock release.
    }
    this.deps.profile.lockHandle?.release();
  }

  private async handleCanonMessage(context: MessageHandlerContext): Promise<void> {
    if (this.disposed) {
      throw new Error('canon-dsh: plugin is disposed');
    }

    let active: ActiveCanonTurn | undefined;
    let submitted = false;
    let abortListenerAdded = false;
    let owned: OwnedDshSession | null = null;
    const abortHandler = () => {
      if (!submitted || !owned) return;
      const messageId = active?.submittedMessageId;
      try {
        if (messageId && owned.handle.agent.inbox.remove(messageId)) return;
      } catch (error) {
        this.log.warn('failed to withdraw pending Canon input: %s', errorMessage(error));
      }
      owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    };

    try {
      owned = await waitForSessionOrAbort(
        this.acquireSession(context.conversationId),
        context.abortSignal,
      );
      if (!owned || this.disposed || context.abortSignal.aborted) return;
      context.abortSignal.addEventListener('abort', abortHandler, { once: true });
      abortListenerAdded = true;
      if (this.activeTurns.has(context.conversationId)) {
        throw new Error(`canon-dsh: conversation ${context.conversationId} already has an active Canon turn`);
      }
      active = {
        conversationId: context.conversationId,
        canonContext: context,
        projection: new TurnProjection(),
        toolCallIds: new Set(),
        toolNamesByCallId: new Map(),
      };
      this.activeTurns.set(context.conversationId, active);
      const turnSession = owned;
      const activeTurn = active;

      active.disposeNoReplyTool = turnSession.handle.agent.ctx.tools.register(
        this.noReplyTool,
      );

      if (communicationIsEnabled(context)) {
        active.disposeCommunicationTool = turnSession.handle.agent.ctx.tools.register(
          this.communicationTool,
        );
      }

      if (this.deps.config.planMode) {
        const planMode = this.deps.getPlanMode?.();
        if (!planMode) {
          throw new Error('canon-dsh: planMode is enabled but the DSH planMode service is unavailable');
        }
        planMode.set(turnSession.handle.agent, context.requestedTurnMode === 'plan');
      }

      await context.turn?.setThinking('DeepSeek Harness is working…');
      if (context.abortSignal.aborted) return;
      const importedImages = await importCanonImages(context, this.deps.context.attachments);
      if (importedImages.skipped > 0) {
        this.log.warn(
          'skipped %d Canon image attachment(s) that DSH could not accept',
          importedImages.skipped,
        );
      }
      const dshMessage = createCanonUserMessage(context, importedImages.refs);
      await this.enqueueSessionLifecycle(context.conversationId, async () => {
        if (context.abortSignal.aborted) return;
        await this.sessionMap.assertCurrent(context.conversationId, turnSession.sessionId);
        activeTurn.submittedMessageId = dshMessage.id;
        submitted = true;
        turnSession.handle.agent.followup(dshMessage);
      });
      if (!submitted) return;
      await turnSession.handle.agent.whenIdle();
      await this.deps.context.sessions.flush(turnSession.handle.agent.session);
      if (!turnSession.confirmed) {
        const persisted = await this.hasPersistedSession(dshSessionId(turnSession.sessionId));
        if (!persisted) {
          throw new Error(`canon-dsh: DSH session ${turnSession.sessionId} was not persisted after flush`);
        }
        await this.sessionMap.confirm(context.conversationId, turnSession.sessionId);
        turnSession.confirmed = true;
      }

      if (!context.abortSignal.aborted && !activeTurn.noReplyRequested) {
        await context.replyFinal(
          activeTurn.projection.finalText(),
          activeTurn.projection.shouldSuppressAutoReply()
            ? { metadata: { replyBehavior: 'suppress_auto_reply' } }
            : undefined,
        );
      }
    } catch (error) {
      if (!active) throw error;
      active.projection.fail();
      if (!context.abortSignal.aborted && !active.noReplyRequested) {
        await context.replyFinal(active.projection.finalText(), {
          metadata: { replyBehavior: 'suppress_auto_reply' },
        });
      }
    } finally {
      if (abortListenerAdded) context.abortSignal.removeEventListener('abort', abortHandler);
      active?.disposeCommunicationTool?.();
      active?.disposeNoReplyTool?.();
      if (active && this.activeTurns.get(context.conversationId) === active) {
        this.activeTurns.delete(context.conversationId);
      }
    }
  }

  private async acquireSession(conversationId: string): Promise<OwnedDshSession> {
    if (this.disposed) throw new Error('canon-dsh: plugin is disposed');
    const stored = await this.sessionMap.getOrCreate(conversationId);
    const existing = this.sessions.get(conversationId);
    if (existing?.sessionId === stored.sessionId) return existing;

    const inFlight = this.sessionAcquisitions.get(stored.sessionId);
    if (inFlight) return inFlight.promise;

    const controller = new AbortController();
    const promise = this.acquireSessionUncached(conversationId, stored, controller.signal)
      .finally(() => {
        if (this.sessionAcquisitions.get(stored.sessionId)?.promise === promise) {
          this.sessionAcquisitions.delete(stored.sessionId);
        }
      });
    const acquisition: SessionAcquisition = {
      conversationId,
      controller,
      promise,
    };
    this.sessionAcquisitions.set(stored.sessionId, acquisition);
    return promise;
  }

  private async acquireSessionUncached(
    conversationId: string,
    stored: Awaited<ReturnType<CanonSessionMap['getOrCreate']>>,
    signal: AbortSignal,
  ): Promise<OwnedDshSession> {
    this.assertAcquisitionActive(signal);

    const sessionId = dshSessionId(stored.sessionId);
    const agentOptions = this.agentOptions();

    const persisted = await this.hasPersistedSession(sessionId, signal);
    this.assertAcquisitionActive(signal);
    if (!persisted && stored.confirmed) {
      throw new Error(`canon-dsh: persisted DSH session ${stored.sessionId} is missing`);
    }
    const handle = persisted
      ? await this.deps.context.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        signal,
      })
      : await this.deps.context.agents.create({
        sessionId,
        meta: { cwd: this.deps.config.workspaceRoot },
        agentOptions,
        signal,
      });
    if (this.disposed || signal.aborted) {
      await handle.dispose().catch(() => undefined);
      this.assertAcquisitionActive(signal);
    }

    const owned: OwnedDshSession = {
      conversationId,
      sessionId: stored.sessionId,
      confirmed: stored.confirmed === true,
      handle,
    };
    try {
      await this.enqueueSessionLifecycle(conversationId, async () => {
        this.assertAcquisitionActive(signal);
        await this.sessionMap.assertCurrent(conversationId, stored.sessionId);
        const current = this.sessions.get(conversationId);
        if (current && current.sessionId !== stored.sessionId) {
          throw new Error(`canon-dsh: conversation ${conversationId} already owns another DSH session`);
        }
        this.sessions.set(conversationId, owned);
        this.conversationsBySessionId.set(stored.sessionId, conversationId);
      });
    } catch (error) {
      await handle.dispose().catch(() => undefined);
      throw error;
    }
    return owned;
  }

  private enqueueSessionLifecycle<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLifecycleTails.get(conversationId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.sessionLifecycleTails.set(conversationId, tail);
    void tail.finally(() => {
      if (this.sessionLifecycleTails.get(conversationId) === tail) {
        this.sessionLifecycleTails.delete(conversationId);
      }
    });
    return result;
  }

  private agentOptions(): { provider?: string; model?: string } {
    return {
      ...(this.deps.config.provider ? { provider: this.deps.config.provider } : {}),
      ...(this.deps.config.model ? { model: this.deps.config.model } : {}),
    };
  }

  private assertAcquisitionActive(signal: AbortSignal): void {
    if (this.disposed) throw new Error('canon-dsh: plugin is disposed');
    signal.throwIfAborted();
  }

  private abortSessionAcquisitions(
    predicate: (acquisition: SessionAcquisition) => boolean,
    reason: Error,
  ): void {
    for (const acquisition of this.sessionAcquisitions.values()) {
      if (predicate(acquisition)) acquisition.controller.abort(reason);
    }
  }

  private async hasPersistedSession(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    try {
      const headers = await this.deps.context.sessionPersistence.list(signal);
      signal?.throwIfAborted();
      return headers.some((header) => header.id === sessionId);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw new Error(`canon-dsh: cannot inspect persisted DSH sessions: ${errorMessage(error)}`);
    }
  }

  private handleSessionEvent(
    session: Session,
    event: SessionEvent,
  ): void {
    const conversationId = this.conversationsBySessionId.get(String(session.id));
    if (conversationId === undefined) return;
    const active = this.activeTurns.get(conversationId);
    if (!active) return;
    if (active.dshTurn === undefined) return;
    const eventTurn = 'turn' in event.data ? event.data.turn : undefined;
    if (eventTurn !== undefined && eventTurn !== active.dshTurn) return;

    if (event.type === 'tool/call') {
      const callId = String(event.data.callId);
      active.toolCallIds.add(callId);
      active.toolNamesByCallId.set(callId, event.data.name);
    }

    if (event.type === 'assistant/chunk') {
      active.projection.applyStreamChunk(
        event.data.chunk,
        active.canonContext.turn ?? { appendDelta: () => undefined, appendBlock: () => undefined },
        `${event.data.turn}:${event.data.step}`,
      );
    } else if (event.type === 'assistant/message') {
      active.projection.applyAssistantMessage(
        event.data.message,
        'interrupted' in event.data ? event.data.interrupted === true : false,
      );
    } else if (event.type === 'turn/end') {
      active.projection.finish(event.data.reason);
    }

    const activity = activityForSessionEvent(event, conversationId, Date.now(), {
      activeTurn: active.dshTurn,
      toolNamesByCallId: active.toolNamesByCallId,
    });
    if (activity) {
      const publish = this.deps.canonAgent.publishRuntimeActivity(conversationId, activity)
        .catch((error: unknown) => {
          this.log.warn('failed to publish DSH runtime activity: %s', errorMessage(error));
        })
        .finally(() => this.pendingActivityPublishes.delete(publish));
      this.pendingActivityPublishes.add(publish);
    }
  }

  private async answerApproval(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const conversationId = this.conversationsBySessionId.get(String(request.agent.id));
    const active = conversationId === undefined
      ? undefined
      : this.activeTurns.get(conversationId);
    if (!active) return next();
    if (!request.callId || !active.toolCallIds.has(String(request.callId))) {
      return next();
    }
    if (request.signal?.aborted || active.canonContext.abortSignal.aborted) {
      return 'cancelled';
    }

    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    request.signal?.addEventListener('abort', cancel, { once: true });
    active.canonContext.abortSignal.addEventListener('abort', cancel, { once: true });
    this.pendingApprovalCancellers.add(cancellation);

    try {
      const result = await active.canonContext.requestApproval({
        toolName: safeDisplayText(request.toolName, 'DSH tool', 120),
        toolSummary: safeDisplayText(
          request.reason ?? `Allow ${request.toolName} once`,
          `Allow ${safeDisplayText(request.toolName, 'DSH tool', 120)} once`,
          300,
        ),
        category: 'tool',
        risk: 'normal',
        runtimeId: 'deepseek-harness',
        turnId: active.canonContext.turn?.id,
        ignoreSessionRules: true,
        allowSessionRule: false,
        signal: cancellation.signal,
      });
      if (cancellation.signal.aborted) return 'cancelled';
      if (result.decision === 'allow') return 'allowed-once';
      if (result.decision === 'deny' && result.respondedBy) return 'rejected';
      return 'unavailable';
    } catch (error) {
      if (cancellation.signal.aborted) {
        return 'cancelled';
      }
      this.log.warn('Canon approval failed; failing closed: %s', errorMessage(error));
      return 'unavailable';
    } finally {
      request.signal?.removeEventListener('abort', cancel);
      active.canonContext.abortSignal.removeEventListener('abort', cancel);
      this.pendingApprovalCancellers.delete(cancellation);
    }
  }

  private get log() {
    return this.deps.context.logger('canon-dsh');
  }

  private questionClosed(status: 'cancelled' | 'timeout'): UserQuestionError {
    return new UserQuestionError(
      status === 'timeout'
        ? 'Canon user question timed out before the user answered'
        : 'The user cancelled the Canon question',
      status === 'timeout' ? 'ASK_TIMEOUT' : 'ASK_CANCELLED',
    );
  }
}

export function createRuntimeSignalHandlers(
  getBridge: () => DeepSeekHarnessBridge | undefined,
): {
  onInterrupt: (context: RuntimeSignalContext) => Promise<void>;
  onStopAndDrop: (context: RuntimeSignalContext) => Promise<void>;
  onNewSession: (context: RuntimeSignalContext) => Promise<void>;
} {
  return {
    onInterrupt: async (context) => getBridge()?.interrupt(context),
    onStopAndDrop: async (context) => getBridge()?.stopAndDrop(context),
    onNewSession: async (context) => getBridge()?.newSession(context),
  };
}

function waitForSessionOrAbort(
  session: Promise<OwnedDshSession>,
  signal: AbortSignal,
): Promise<OwnedDshSession | null> {
  if (signal.aborted) {
    void session.catch(() => undefined);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      resolve(null);
    };
    signal.addEventListener('abort', abort, { once: true });
    void session.then(
      (owned) => {
        signal.removeEventListener('abort', abort);
        resolve(owned);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
