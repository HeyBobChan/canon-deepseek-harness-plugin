import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';

import {
  TurnProjection,
  activityForSessionEvent,
  mapCanonApprovalDecision,
} from './event-mapping.js';

function assistant(text: string): AssistantMessage {
  return {
    id: 'assistant-1' as AssistantMessage['id'],
    role: 'assistant',
    content: [{ type: 'text', text } as ContentBlock],
    source: { kind: 'model', provider: 'deepseek', model: 'v4' },
  };
}

function event(type: string, data: unknown): SessionEvent {
  return { type, seq: 1, time: 1, data } as SessionEvent;
}

describe('DSH event mapping', () => {
  it('streams visible text but not reasoning', () => {
    const projection = new TurnProjection();
    const turn = { appendDelta: vi.fn(), appendBlock: vi.fn() };
    projection.applyStreamChunk({ type: 'text-delta', index: 0, text: 'Hel' }, turn, '1:0');
    projection.applyStreamChunk({ type: 'reasoning-delta', index: 1, text: 'secret' }, turn, '1:0');
    projection.applyStreamChunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'ignored duplicate' } }, turn, '1:0');

    expect(turn.appendDelta).toHaveBeenCalledWith('Hel');
    expect(turn.appendBlock).not.toHaveBeenCalled();
    expect(turn.appendDelta).not.toHaveBeenCalledWith('secret');
  });

  it('uses assembled text when an adapter emits no text delta', () => {
    const projection = new TurnProjection();
    const turn = { appendDelta: vi.fn(), appendBlock: vi.fn() };
    projection.applyStreamChunk({ type: 'block-end', index: 2, block: { type: 'text', text: 'assembled' } }, turn, '1:0');
    expect(turn.appendBlock).toHaveBeenCalledWith('assembled');
  });

  it('derives safe final text for completion, truncation, interruption, and failure', () => {
    const completed = new TurnProjection();
    completed.applyAssistantMessage(assistant('Done.'));
    completed.finish({ kind: 'completed' } as TurnEndReason);
    expect(completed.finalText()).toBe('Done.');

    const truncated = new TurnProjection();
    truncated.applyAssistantMessage(assistant('Partial.'));
    truncated.finish({ kind: 'max-tokens' } as TurnEndReason);
    expect(truncated.finalText()).toContain('output-token limit');

    const interrupted = new TurnProjection();
    interrupted.applyAssistantMessage(assistant('Partial.'), true);
    interrupted.finish({ kind: 'aborted', reason: { kind: 'user' } } as TurnEndReason);
    expect(interrupted.finalText()).toContain('interrupted');
    expect(interrupted.finalText()).toContain('partial response');

    const failed = new TurnProjection();
    failed.finish({ kind: 'error', error: { message: 'provider secret', code: 'SECRET' } } as TurnEndReason);
    expect(failed.finalText()).not.toContain('provider secret');

    const interruptedMarker = new TurnProjection();
    interruptedMarker.applyAssistantMessage(assistant('Prefix.'), true);
    interruptedMarker.finish({ kind: 'completed' } as TurnEndReason);
    expect(interruptedMarker.finalText()).toContain('interrupted this response');
  });

  it('maps tool lifecycle without raw arguments', () => {
    const started = activityForSessionEvent(event('tool/call', {
      turn: 1,
      step: 2,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"secret":"do-not-leak"}',
    }), 'conversation-1', 123);
    expect(started).toMatchObject({
      id: 'dsh-tool:call-1',
      kind: 'tool',
      status: 'running',
      title: 'bash',
    });
    expect(JSON.stringify(started)).not.toContain('do-not-leak');

    const ended = activityForSessionEvent(event('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    }), 'conversation-1', 124);
    expect(ended).toMatchObject({ status: 'completed', endedAt: 124 });
  });

  it('preserves one-shot and human denial approval semantics', () => {
    expect(mapCanonApprovalDecision('allow', 'human-1')).toBe('allowed-once');
    expect(mapCanonApprovalDecision('deny', 'human-1')).toBe('rejected');
    expect(mapCanonApprovalDecision('deny')).toBe('unavailable');
  });
});
