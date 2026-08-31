import { readFile } from 'node:fs/promises';

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type {
  AttachmentStore,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment';
import {
  MAX_CANON_MEDIA_BYTES,
  materializeAttachment,
  resolveAttachmentMimeType,
} from '@canonmsg/agent-sdk';
import type { MessageHandlerContext } from '@canonmsg/agent-sdk';
import {
  buildCanonInboundFrameV1,
  renderCanonHostInboundContent,
  renderCodingHostInboundPrompt,
} from '@canonmsg/core';

import { CANON_NO_REPLY_TOOL_NAME } from './no-reply-tool.js';

type DshAttachmentWriter = Pick<AttachmentStore, 'imageLimits' | 'saveImages'>;

export interface CanonImageImport {
  readonly refs: readonly ImageAttachmentRef[];
  readonly skipped: number;
}

export function createCanonUserMessage(
  context: MessageHandlerContext,
  images: readonly ImageAttachmentRef[] = [],
): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text: formatCanonMessages(context) },
      ...images.map((attachment) => ({ type: 'image' as const, attachment })),
    ],
    source: { kind: 'user' },
  });
}

/**
 * Move supported Canon images through DSH's durable attachment seam before
 * their owning user message is appended. Unsupported or refused images stay
 * represented by the safe placeholders in the Canon prompt.
 */
export async function importCanonImages(
  context: MessageHandlerContext,
  attachments: DshAttachmentWriter,
  materialize: typeof materializeAttachment = materializeAttachment,
): Promise<CanonImageImport> {
  const total = context.messages.reduce(
    (count, message) => count + message.attachments.filter((item) => item.kind === 'image').length,
    0,
  );
  if (total === 0) return { refs: [], skipped: 0 };

  const limits = attachments.imageLimits;
  const selected: Array<{
    attachment: MessageHandlerContext['messages'][number]['attachments'][number];
    index: number;
    messageId: string;
  }> = [];
  let remaining = limits.maxImagesPerMessage;

  for (const message of context.messages) {
    if (remaining === 0) break;
    message.attachments.forEach((attachment, index) => {
      if (attachment.kind !== 'image' || remaining === 0) return;
      const declaredType = imageMediaType(attachment.mimeType);
      if (
        attachment.mimeType
        && (!declaredType || !limits.mediaTypes.includes(declaredType))
      ) {
        return;
      }
      selected.push({ attachment, index, messageId: message.id });
      remaining -= 1;
    });
  }

  const maxBytes = Math.min(limits.maxImageBytes, MAX_CANON_MEDIA_BYTES);
  const settled = await Promise.allSettled(selected.map((input) => materialize(
    input.attachment,
    {
      agentId: context.agent.agentId,
      conversationId: context.conversationId,
      messageId: input.messageId,
      index: input.index,
      maxBytes,
      signal: context.abortSignal,
    },
  )));
  context.abortSignal.throwIfAborted();
  const materialized = settled.flatMap((result) => (
    result.status === 'fulfilled' ? [result.value] : []
  ));

  const inputs: SaveImageAttachment[] = [];
  let aggregateBytes = 0;
  for (const attachment of materialized) {
    const mediaType = imageMediaType(resolveAttachmentMimeType(attachment));
    if (!mediaType || !limits.mediaTypes.includes(mediaType)) continue;
    try {
      context.abortSignal.throwIfAborted();
      const data = await readFile(attachment.path);
      context.abortSignal.throwIfAborted();
      if (
        data.byteLength === 0
        || data.byteLength > limits.maxImageBytes
        || aggregateBytes + data.byteLength > limits.maxMessageImageBytes
      ) {
        continue;
      }
      inputs.push({
        data,
        mediaType,
        ...(attachment.fileName ? { name: attachment.fileName } : {}),
      });
      aggregateBytes += data.byteLength;
    } catch {
      context.abortSignal.throwIfAborted();
    }
  }

  if (inputs.length === 0) return { refs: [], skipped: total };
  try {
    const refs = await attachments.saveImages(inputs);
    return { refs, skipped: Math.max(0, total - refs.length) };
  } catch {
    context.abortSignal.throwIfAborted();
    return { refs: [], skipped: total };
  }
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
    const prompt = renderCodingHostInboundPrompt(frame, {
      noReplyToolName: CANON_NO_REPLY_TOOL_NAME,
    });
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

function imageMediaType(value: string | null | undefined): ImageMediaType | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    normalized === 'image/png'
    || normalized === 'image/jpeg'
    || normalized === 'image/webp'
    || normalized === 'image/gif'
  ) {
    return normalized;
  }
  return null;
}
