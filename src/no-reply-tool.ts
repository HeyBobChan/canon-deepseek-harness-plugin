import { canonVerbToolDefinitions } from '@canonmsg/agent-tools';
import type { MessageHandlerContext } from '@canonmsg/agent-sdk';
import { NO_REPLY_ACK_NOTE } from '@canonmsg/core';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

export const CANON_NO_REPLY_TOOL_NAME = 'no_reply';

type ActiveNoReplyContext = Pick<MessageHandlerContext, 'turn'>;

const canonicalNoReply = (() => {
  const definition = canonVerbToolDefinitions({
    compactCommunication: true,
    conversationScoped: true,
  }).find((candidate) => candidate.name === CANON_NO_REPLY_TOOL_NAME);
  if (!definition) {
    throw new Error('canon-dsh: Canon no_reply tool contract is unavailable');
  }
  return definition;
})();

/** Project Canon's standard deliberate-silence verb into the active DSH turn. */
export function createDeepSeekHarnessNoReplyTool(
  resolveContext: (dshSessionId: string) => ActiveNoReplyContext | undefined,
  onNoReply: (dshSessionId: string) => void,
): ToolDefinition {
  return {
    name: canonicalNoReply.name,
    description: canonicalNoReply.description,
    parameters: canonicalNoReply.inputSchema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', const: 'acknowledged' },
          note: { type: 'string' },
        },
        required: ['status', 'note'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value as { note: string }).note,
      }],
    },
    async execute(args: unknown, execution: ToolRunContext) {
      execution.signal.throwIfAborted();
      const sessionId = execution.agent?.id;
      const context = sessionId === undefined
        ? undefined
        : resolveContext(String(sessionId));
      if (!context?.turn) {
        throw new Error('no_reply is available only during its active Canon turn');
      }
      const reason = isRecord(args) && typeof args.reason === 'string'
        ? args.reason
        : undefined;
      await context.turn.noReply(reason);
      onNoReply(String(sessionId));
      return { status: 'acknowledged', note: NO_REPLY_ACK_NOTE };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
