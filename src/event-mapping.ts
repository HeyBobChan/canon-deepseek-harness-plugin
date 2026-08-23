import type {
  AssistantMessage,
  ContentBlock,
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

export class TurnProjection {
  private readonly output: string[] = [];
  private readonly textDeltaIndexes = new Set<string>();
  private status: BridgeTurnStatus = 'running';
  private interrupted = false;
  private hitTokenLimit = false;

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
    else this.status = 'failed';
  }

  fail(): void {
    if (this.status === 'running') this.status = 'failed';
  }

  finalText(): string {
    if (this.status === 'failed') {
      return 'DeepSeek Harness failed to complete the turn. Check the DSH logs for details.';
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
): CanonRuntimeActivityItem | null {
  const turn = 'turn' in event.data ? event.data.turn : undefined;
  const runId = turn === undefined ? conversationId : `dsh:${conversationId}:${turn}`;

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
    const failed = event.data.error !== undefined || event.data.message.content.some((block) => block.type === 'tool-result' && block.isError);
    return {
      id: `dsh-tool:${event.data.message.content[0]?.toolCallId ?? `${event.data.turn}:${event.data.step}`}`,
      runId,
      kind: 'tool',
      title: safeDisplayText(event.data.message.content
        .filter((block) => block.type === 'tool-result')
        .map((block) => block.toolCallId)
        .join(', '), 'DSH tool result'),
      status: failed ? 'failed' : 'completed',
      updatedAt: now,
      endedAt: now,
    };
  }

  return null;
}

export function safeDisplayText(value: string, fallback: string, maxLength = 80): string {
  const title = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!title) return fallback;
  return title.length <= maxLength ? title : `${title.slice(0, maxLength - 3)}...`;
}
