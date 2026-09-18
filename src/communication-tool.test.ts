import { describe, expect, it, vi } from 'vitest';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

import {
  communicationIsEnabled,
  createDeepSeekHarnessCommunicationTool,
} from './communication-tool.js';

function execution(sessionId?: string): ToolRunContext {
  return {
    signal: new AbortController().signal,
    ...(sessionId ? { agent: { id: sessionId } } : {}),
  } as unknown as ToolRunContext;
}

function active(
  outboundPolicy: 'open' | 'approval-required' | 'closed',
  communicate = vi.fn(),
) {
  return {
    agent: { outboundPolicy },
    communicate,
  } as never;
}

describe('DeepSeek Harness communicate tool', () => {
  it('projects the canonical action schema without trusted turn fields', () => {
    const tool = createDeepSeekHarnessCommunicationTool(() => undefined);
    const alternatives = (tool.parameters.oneOf ?? []) as Array<{
      properties?: { action?: { const?: string; enum?: string[] } };
    }>;

    expect(alternatives.flatMap((entry) => entry.properties?.action?.enum ?? [entry.properties?.action?.const])).toEqual([
      'list_conversations',
      'leave_conversation',
      'discover_agents',
      'message_existing',
      'start_conversation',
      'start_direct',
      'create_conversation',
      'create_group',
      'forward_message',
      'share_contact',
      'manage_participants',
      'manage_group_members',
    ]);
    expect(JSON.stringify(tool.parameters)).not.toMatch(
      /replyAuthority|sourceMessageId|turnId|runtimeProfile|sessionConfig|workspace|effort|model/,
    );
  });

  it('dispatches through the active Canon turn context selected by DSH session', async () => {
    const communicate = vi.fn(async () => ({
      status: 'removed' as const,
      conversationId: 'group-1',
      userId: 'human-2',
    }));
    const tool = createDeepSeekHarnessCommunicationTool((sessionId) => (
      sessionId === 'dsh-session' ? active('approval-required', communicate) : undefined
    ));

    await expect(tool.execute({
      action: 'manage_group_members',
      conversationId: 'group-1',
      userId: 'human-2',
      operation: 'remove',
    }, execution('dsh-session'))).resolves.toEqual({
      status: 'removed',
      conversationId: 'group-1',
      userId: 'human-2',
    });
    expect(communicate).toHaveBeenCalledWith({
      action: 'manage_group_members',
      conversationId: 'group-1',
      userId: 'human-2',
      operation: 'remove',
    });
  });

  it('fails closed outside the active turn and after outbound policy closes', async () => {
    const communicate = vi.fn();
    const closed = active('closed', communicate);
    const tool = createDeepSeekHarnessCommunicationTool((sessionId) => (
      sessionId === 'closed-session' ? closed : undefined
    ));

    await expect(tool.execute({
      action: 'message_existing',
      conversationId: 'conversation-2',
      text: 'hello',
    }, execution())).rejects.toThrow(/active Canon turn/);
    await expect(tool.execute({
      action: 'message_existing',
      conversationId: 'conversation-2',
      text: 'hello',
    }, execution('closed-session'))).rejects.toThrow(/not allowed/);
    expect(communicate).not.toHaveBeenCalled();
  });

  it('exposes proactive communication for open and approval-required policies only', () => {
    expect(communicationIsEnabled(active('open'))).toBe(true);
    expect(communicationIsEnabled(active('approval-required'))).toBe(true);
    expect(communicationIsEnabled(active('closed'))).toBe(false);
  });
});
