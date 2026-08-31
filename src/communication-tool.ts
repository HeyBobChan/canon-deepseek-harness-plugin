import {
  canonCommunicateToolDefinition,
  parseCommunicateToolInput,
} from '@canonmsg/agent-tools';
import type {
  CommunicateResult,
  MessageHandlerContext,
} from '@canonmsg/agent-sdk';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

export const CANON_COMMUNICATE_TOOL_NAME = 'communicate';

export type ActiveCommunicationContext = Pick<
  MessageHandlerContext,
  'agent' | 'communicate'
>;

export function communicationIsEnabled(
  context: ActiveCommunicationContext,
): boolean {
  return context.agent.outboundPolicy === 'open'
    || context.agent.outboundPolicy === 'approval-required';
}

function resultText(result: CommunicateResult): string {
  return `communicate: ${result.status}\n${JSON.stringify(result, null, 2)}`;
}

/**
 * Project Canon's canonical communication contract into one DSH-native tool.
 * The resolver is adapter-private: the model never supplies the current Canon
 * conversation, message, turn, or reply authority.
 */
export function createDeepSeekHarnessCommunicationTool(
  resolveContext: (dshSessionId: string) => ActiveCommunicationContext | undefined,
): ToolDefinition {
  const canonical = canonCommunicateToolDefinition(CANON_COMMUNICATE_TOOL_NAME);
  return {
    name: canonical.name,
    description: canonical.description,
    parameters: canonical.inputSchema,
    output: {
      // CommunicateResult is a server-owned discriminated union. Runtime
      // validation belongs to the updated Canon core client.
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: resultText(value as CommunicateResult),
      }],
    },
    async execute(args: unknown, execution: ToolRunContext) {
      execution.signal.throwIfAborted();
      const sessionId = execution.agent?.id;
      const context = sessionId === undefined
        ? undefined
        : resolveContext(String(sessionId));
      if (!context) {
        throw new Error('communicate is available only during its active Canon turn');
      }
      if (!communicationIsEnabled(context)) {
        throw new Error('this Canon agent is not allowed to communicate proactively');
      }
      return context.communicate(parseCommunicateToolInput(args));
    },
  };
}
