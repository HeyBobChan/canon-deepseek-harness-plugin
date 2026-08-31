import type {
  AssistantMessage,
  ContentBlock,
  LlmFailure,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { CanonRuntimeActivityItem } from '@canonmsg/core';

export interface StreamingTurnController {
  appendDelta(delta: string): void;
  appendBlock(block: string): void;
}

export type BridgeTurnStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'blocked';

export interface SessionActivityOptions {
  activeTurn?: number;
  toolNamesByCallId?: ReadonlyMap<string, string>;
}

export class TurnProjection {
  private readonly output: string[] = [];
  private readonly textDeltaIndexes = new Set<string>();
  private status: BridgeTurnStatus = 'running';
  private interrupted = false;
  private hitTokenLimit = false;
  private failureNotice: string | undefined;

  get currentState(): BridgeTurnStatus {
    return this.status;
  }

  applyStreamChunk(
    chunk: StreamChunk,
    turn: StreamingTurnController,
    scope = '',
  ): void {
    if (chunk.type === 'text-delta') {
      this.textDeltaIndexes.add(`${scope}:${chunk.index}`);
      if (chunk.text) turn.appendDelta(chunk.text);
      return;
    }
    if (
      chunk.type === 'block-end'
      && chunk.block.type === 'text'
      && chunk.block.text
      && !this.textDeltaIndexes.has(`${scope}:${chunk.index}`)
    ) {
      turn.appendBlock(chunk.block.text);
    }
  }

  applyAssistantMessage(message: AssistantMessage, interrupted = false): void {
    if (interrupted) this.interrupted = true;
    const text = visibleText(message.content).trim();
    if (text) this.output.push(text);
  }

  finish(reason: TurnEndReason): void {
    if (reason.kind === 'completed') this.status = 'completed';
    else if (reason.kind === 'aborted' || reason.kind === 'interrupted') this.status = 'aborted';
    else if (reason.kind === 'blocked') this.status = 'blocked';
    else if (reason.kind === 'max-tokens') {
      this.status = 'completed';
      this.hitTokenLimit = true;
    }
    else {
      this.status = 'failed';
      if (reason.kind === 'error') this.failureNotice = noticeForFailure(reason.error);
    }
  }

  fail(): void {
    if (this.status === 'running') this.status = 'failed';
  }

  finalText(): string {
    if (this.status === 'failed') {
      const notice = this.failureNotice
        ?? 'DeepSeek Harness failed to complete the turn.';
      return `${notice} Retry the message or inspect the DSH surface for details.`;
    }
    const text = this.output.join('\n\n').trim();
    if (this.status === 'aborted') {
      return text
        ? `${text}\n\n[DeepSeek Harness turn was interrupted; this is a partial response.]`
        : 'DeepSeek Harness turn was interrupted.';
    }
    if (text) {
      const notices = [
        ...(this.hitTokenLimit ? ['DeepSeek Harness reached its output-token limit.'] : []),
        ...(this.interrupted
          ? ['DeepSeek Harness interrupted this response after the prefix above.']
          : []),
      ];
      return notices.length > 0 ? `${text}\n\n[${notices.join(' ')}]` : text;
    }
    if (this.status === 'blocked') {
      return 'DeepSeek Harness blocked the turn before producing a response.';
    }
    return 'DeepSeek Harness completed the turn without visible output.';
  }

  /** Synthetic status notices are terminal diagnostics, never peer prompts. */
  shouldSuppressAutoReply(): boolean {
    return this.status === 'failed'
      || this.status === 'blocked'
      || this.status === 'aborted'
      || this.interrupted
      || this.output.length === 0;
  }
}

export function visibleText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function mapCanonApprovalDecision(
  decision: 'allow' | 'deny',
  respondedBy?: string,
): ApprovalOutcome {
  if (decision === 'allow') return 'allowed-once';
  return respondedBy ? 'rejected' : 'unavailable';
}

export function activityForSessionEvent(
  event: SessionEvent,
  conversationId: string,
  now = Date.now(),
  options: SessionActivityOptions = {},
): CanonRuntimeActivityItem | null {
  const turn = 'turn' in event.data ? event.data.turn : undefined;
  const projectedTurn = turn ?? options.activeTurn;
  const runId = projectedTurn === undefined
    ? `dsh:${conversationId}:session`
    : `dsh:${conversationId}:${projectedTurn}`;

  if (event.type === 'turn/start') {
    return {
      id: `dsh-run:${conversationId}:${event.data.turn}`,
      runId,
      kind: 'run',
      title: 'DeepSeek Harness turn',
      status: 'running',
      updatedAt: now,
    };
  }

  if (event.type === 'turn/end') {
    const reason = event.data.reason.kind;
    const status: CanonRuntimeActivityItem['status'] = reason === 'completed'
      ? 'completed'
      : reason === 'blocked'
        ? 'blocked'
        : 'failed';
    return {
      id: `dsh-run:${conversationId}:${event.data.turn}`,
      runId,
      kind: 'run',
      title: 'DeepSeek Harness turn',
      status,
      updatedAt: now,
      endedAt: now,
    };
  }

  if (event.type === 'tool/call') {
    return {
      id: `dsh-tool:${event.data.callId}`,
      runId,
      kind: 'tool',
      title: safeDisplayText(event.data.name, 'DSH tool'),
      status: 'running',
      updatedAt: now,
    };
  }

  if (event.type === 'tool/result') {
    const results = event.data.message.content.filter((block) => block.type === 'tool-result');
    const failed = event.data.error !== undefined || results.some((block) => block.isError);
    const title = results
      .map((block) => options.toolNamesByCallId?.get(String(block.toolCallId)))
      .filter((name): name is string => name !== undefined)
      .join(', ');
    return {
      id: `dsh-tool:${event.data.message.content[0]?.toolCallId ?? `${event.data.turn}:${event.data.step}`}`,
      runId,
      kind: 'tool',
      title: safeDisplayText(title, 'DSH tool result'),
      status: failed ? 'failed' : 'completed',
      updatedAt: now,
      endedAt: now,
    };
  }

  if (event.type === 'todo/write') {
    const total = event.data.todos.length;
    const completed = event.data.todos.filter((todo) => todo.status === 'completed').length;
    const running = event.data.todos.some((todo) => todo.status === 'in_progress');
    const finished = total === 0 || completed === total;
    return {
      id: `dsh-plan:${conversationId}`,
      runId,
      kind: 'plan',
      title: 'DeepSeek Harness plan',
      status: finished ? 'completed' : running ? 'running' : 'pending',
      progressText: total === 0 ? 'No pending tasks' : `${completed}/${total} tasks completed`,
      updatedAt: now,
      ...(finished ? { endedAt: now } : {}),
    };
  }

  return null;
}

export function safeDisplayText(value: string, fallback: string, maxLength = 80): string {
  const title = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!title) return fallback;
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title),
    (part) => part.segment,
  );
  if (graphemes.length <= maxLength) return title;
  if (maxLength <= 3) return '.'.repeat(Math.max(0, maxLength));
  return `${graphemes.slice(0, maxLength - 3).join('')}...`;
}

function noticeForFailure(failure: LlmFailure): string | undefined {
  if (failure.code === 'AUTH' || failure.code === 'INVALID_CREDENTIAL' || failure.code === 'MISSING_CREDENTIAL') {
    return 'DeepSeek Harness could not authenticate with the model provider.';
  }
  if (failure.code === 'RATE_LIMIT' || failure.status === 429) {
    return 'The model provider rate-limited the DeepSeek Harness request.';
  }
  if (failure.code === 'QUOTA') {
    return 'The model provider reported that its quota is exhausted.';
  }
  if (
    failure.code === 'TIMEOUT'
    || failure.code === 'TRANSPORT'
    || failure.code === 'ECONNRESET'
    || failure.code === 'STREAM_CLOSED'
  ) {
    return 'DeepSeek Harness lost its connection to the model provider.';
  }
  if (failure.code === 'SERVER' || (failure.status !== undefined && failure.status >= 500)) {
    return 'The model provider returned a server error to DeepSeek Harness.';
  }
  if (
    failure.code === 'INVALID_REQUEST'
    || failure.code === 'UNSUPPORTED_CONTENT'
    || failure.code === 'UNSUPPORTED_OPTION'
    || failure.code === 'UNSUPPORTED_REASONING_EFFORT'
    || failure.code === 'UNKNOWN_MODEL'
  ) {
    return 'DeepSeek Harness could not submit this request to the selected model.';
  }
  return undefined;
}
