import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import {
  buildCanonInboundFrameV1,
  renderCanonHostInboundContent,
  renderCodingHostInboundPrompt,
} from '@canonmsg/core';
import type { MessageHandlerContext } from '@canonmsg/agent-sdk';

export function createCanonUserMessage(context: MessageHandlerContext): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: formatCanonMessages(context) }],
    source: { kind: 'user' },
  });
}

export function formatCanonMessages(context: MessageHandlerContext): string {
  const messages = context.messages;
  if (messages.length === 0) {
    throw new Error('canon-dsh: cannot create an empty DSH user message');
  }

  return messages.map((message, index) => {
    const turnContext = index === messages.length - 1
      ? context.turnContext
      : frameTurnContextForEarlierMessage(context, message);
    const frame = buildCanonInboundFrameV1(turnContext);
    const prompt = renderCodingHostInboundPrompt(frame);
    return frame.shape === 'direct_owner'
      ? `Message from your Canon owner:\n\n${prompt}`
      : prompt;
  }).join('\n\n');
}

function frameTurnContextForEarlierMessage(
  context: MessageHandlerContext,
  message: MessageHandlerContext['messages'][number],
): MessageHandlerContext['turnContext'] {
  return {
    ...context.turnContext,
    provenance: {
      ...context.turnContext.provenance,
      sender: {
        id: message.senderId,
        name: message.senderName ?? message.senderId,
        type: message.senderType,
        isOwner: message.isOwner,
      },
      mentionedAgent: message.mentions.includes(context.agent.agentId),
      activeSelfContext: null,
    },
    selfContext: undefined,
    replyContext: undefined,
    message: {
      ...context.turnContext.message,
      id: message.id,
      contentType: message.contentType,
      renderedContent: renderCanonHostInboundContent(message),
    },
  };
}
