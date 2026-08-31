import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { CanonMessage, CanonTurnContextV2 } from '@canonmsg/core';
import type { MessageHandlerContext } from '@canonmsg/agent-sdk';

import {
  createCanonUserMessage,
  formatCanonMessages,
  importCanonImages,
} from './messages.js';

const AGENT_ID = 'agent-dsh';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(temporaryDirectories.map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
  temporaryDirectories.length = 0;
});

function message(overrides: Partial<CanonMessage>): CanonMessage {
  return {
    id: 'message-1',
    senderId: 'user-1',
    senderName: 'Alice',
    senderType: 'human',
    isOwner: true,
    contentType: 'text',
    text: 'Please inspect the failing test.',
    attachments: [],
    mentions: [],
    replyTo: null,
    replyToPosition: null,
    status: 'sent',
    deleted: false,
    createdAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  };
}

function turnContext(
  latest: CanonMessage,
  input: {
    conversationType?: 'direct' | 'group';
    memberCount?: number;
    addressed?: boolean;
    reply?: CanonTurnContextV2['replyContext'];
  } = {},
): CanonTurnContextV2 {
  const conversationType = input.conversationType ?? 'direct';
  return {
    schema: 'canon.turn.v2',
    conversation: {
      id: 'conversation-1',
      type: conversationType,
      memberCount: input.memberCount ?? 2,
    },
    provenance: {
      sender: {
        id: latest.senderId,
        name: latest.senderName ?? latest.senderId,
        type: latest.senderType,
        isOwner: latest.isOwner,
      },
      mentionedAgent: input.addressed ?? latest.mentions.includes(AGENT_ID),
      activeSelfContext: null,
    },
    message: {
      id: latest.id,
      contentType: latest.contentType,
      renderedContent: latest.text ?? '[Empty message]',
    },
    ...(input.reply ? { replyContext: input.reply } : {}),
    ...(conversationType === 'group'
      ? {
        group: {
          context: {
            memberCount: input.memberCount ?? 4,
            memberIds: ['owner-1', 'user-1', AGENT_ID, 'other'],
            ownerId: 'owner-1',
            ownerName: 'Owner',
            ownerPresent: true,
            knownRecentParticipants: [],
          },
          mode: 'initial' as const,
        },
      }
      : {}),
  };
}

function handlerContext(
  messages: CanonMessage[],
  turnContextOverride?: CanonTurnContextV2,
): MessageHandlerContext {
  return {
    messages,
    turnContext: turnContextOverride
      ?? turnContext(messages[messages.length - 1]),
    agent: { agentId: AGENT_ID },
  } as unknown as MessageHandlerContext;
}

describe('Canon to DSH messages', () => {
  it('creates one immutable DSH user message from the trusted Canon frame', () => {
    const userMessage = createCanonUserMessage(handlerContext([message({})]));

    expect(userMessage.role).toBe('user');
    expect(userMessage.source).toEqual({ kind: 'user' });
    expect(userMessage.content).toEqual([
      { type: 'text', text: expect.stringContaining('Please inspect the failing test.') },
    ]);
    expect(Object.isFrozen(userMessage)).toBe(true);
    expect(Object.isFrozen(userMessage.content[0])).toBe(true);
  });

  it('appends durable DSH image references without exposing source URLs', () => {
    const image = {
      attachmentId: 'sha256:abc' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
      name: 'diagram.png',
    };
    const userMessage = createCanonUserMessage(handlerContext([message({})]), [image]);

    expect(userMessage.content).toEqual([
      { type: 'text', text: expect.stringContaining('Please inspect the failing test.') },
      { type: 'image', attachment: image },
    ]);
    expect(JSON.stringify(userMessage)).not.toContain('http');
  });

  it('materializes only accepted Canon images and commits one ordered DSH batch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canon-dsh-images-'));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, 'diagram.png');
    await writeFile(imagePath, Buffer.from([1, 2, 3]));

    const latest = message({
      contentType: 'image',
      text: 'Inspect these.',
      attachments: [
        {
          kind: 'audio',
          fileName: 'note.mp3',
          mimeType: 'audio/mpeg',
          url: 'https://secret.example/note.mp3',
        },
        {
          kind: 'image',
          fileName: 'diagram.png',
          mimeType: 'image/png',
          url: 'https://secret.example/diagram.png',
        },
        {
          kind: 'image',
          fileName: 'vector.svg',
          mimeType: 'image/svg+xml',
          url: 'https://secret.example/vector.svg',
        },
      ],
    });
    const materialize = vi.fn(async (
      attachment: CanonMessage['attachments'][number],
      options: { index?: number; messageId: string; conversationId: string },
    ) => ({
      ...attachment,
      index: options.index ?? 0,
      path: imagePath,
      sourceUrl: attachment.url,
      conversationId: options.conversationId,
      messageId: options.messageId,
    }));
    const context = {
      ...handlerContext([latest]),
      conversationId: 'conversation-1',
      abortSignal: new AbortController().signal,
    } as unknown as MessageHandlerContext;
    const ref = {
      attachmentId: 'sha256:def' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
      name: 'diagram.png',
    };
    const saveImages = vi.fn(async () => [ref]);
    const store = {
      imageLimits: {
        maxImageBytes: 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 2048,
        maxImagePixels: 1_000_000,
        maxImageDimension: 1000,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      saveImages,
    } as unknown as Pick<AttachmentStore, 'imageLimits' | 'saveImages'>;

    await expect(importCanonImages(context, store, materialize)).resolves.toEqual({
      refs: [ref],
      skipped: 1,
    });
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'diagram.png' }),
      expect.objectContaining({
        agentId: AGENT_ID,
        conversationId: 'conversation-1',
        messageId: latest.id,
        index: 1,
        maxBytes: 1024,
        signal: context.abortSignal,
      }),
    );
    expect(saveImages).toHaveBeenCalledWith([{
      data: Buffer.from([1, 2, 3]),
      mediaType: 'image/png',
      name: 'diagram.png',
    }]);
    expect(JSON.stringify(saveImages.mock.calls)).not.toContain('secret.example');
  });

  it('preserves owner status in a direct owner DM', () => {
    const prompt = formatCanonMessages(handlerContext([
      message({ senderName: 'Alice', isOwner: true, text: 'Run the tests.' }),
    ]));
    expect(prompt).toContain('Message from your Canon owner:');
    expect(prompt).toContain('Run the tests.');
  });

  it('preserves non-owner identity in a direct DM', () => {
    const prompt = formatCanonMessages(handlerContext([
      message({
        senderId: 'user-2',
        senderName: 'Bob',
        isOwner: false,
        text: 'Please summarize this branch.',
      }),
    ]));
    expect(prompt).toContain('Bob sent you a direct message.');
    expect(prompt).toContain('They are not your owner');
    expect(prompt).toContain('Bob:');
    expect(prompt).toContain('Please summarize this branch.');
  });

  it('preserves addressing state in a group message', () => {
    const latest = message({
      senderId: 'user-2',
      senderName: 'Bob',
      isOwner: false,
      mentions: [AGENT_ID],
      text: 'DSH, inspect the flaky test.',
    });
    const prompt = formatCanonMessages(handlerContext(
      [latest],
      turnContext(latest, { conversationType: 'group', addressed: true }),
    ));

    expect(prompt).toContain('Bob spoke in a group.');
    expect(prompt).toContain('They addressed you.');
    expect(prompt).toContain('call `no_reply` to stay silent');
    expect(prompt).toContain('DSH, inspect the flaky test.');
  });

  it('preserves reply context', () => {
    const replyTurnContext: CanonTurnContextV2 = {
      ...turnContext(message({ text: 'What did that failure mean?' })),
      replyContext: {
        messageId: 'message-old',
        found: true,
        senderId: 'user-1',
        senderName: 'Alice',
        senderType: 'human',
        contentType: 'text',
        text: 'The build failed.',
        body: 'The build failed.',
        replyToPosition: 1,
        attachments: [],
        contactCard: null,
      },
    };
    const prompt = formatCanonMessages(handlerContext([
      message({ text: 'What did that failure mean?' }),
    ], replyTurnContext));

    expect(prompt).toContain('This message replies to Alice:');
    expect(prompt).toContain('The build failed.');
    expect(prompt).toContain('What did that failure mean?');
  });

  it('preserves all senders and owner/addressing state in a batch', () => {
    const latest = message({
      id: 'message-3',
      senderId: 'owner-1',
      senderName: 'Owner',
      isOwner: true,
      mentions: [AGENT_ID],
      text: 'Please finish the review.',
    });
    const prompt = formatCanonMessages({
      messages: [
        message({
          id: 'message-1',
          senderId: 'user-2',
          senderName: 'Bob',
          isOwner: false,
          text: 'First request.',
        }),
        message({
          id: 'message-2',
          senderId: 'agent-other',
          senderName: 'Other Agent',
          senderType: 'ai_agent',
          isOwner: false,
          mentions: [AGENT_ID],
          text: 'Second request.',
        }),
        latest,
      ],
      turnContext: turnContext(latest, { conversationType: 'group', addressed: true }),
      agent: { agentId: AGENT_ID },
    } as unknown as MessageHandlerContext);

    expect(prompt).toContain('Bob spoke in a group.');
    expect(prompt).toContain('Bob:');
    expect(prompt).toContain('First request.');
    expect(prompt).toContain('Other Agent spoke in a group. They addressed you.');
    expect(prompt).toContain('Other Agent:');
    expect(prompt).toContain('Second request.');
    expect(prompt).toContain('Owner, your owner, spoke in a group. They addressed you.');
    expect(prompt).toContain('Owner:');
    expect(prompt).toContain('Please finish the review.');
  });

  it('does not expose attachment URLs in unsupported media', () => {
    const latest = message({
      contentType: 'image',
      text: null,
      attachments: [{
        id: 'attachment-1',
        kind: 'image',
        fileName: 'diagram.png',
        mimeType: 'image/png',
        url: 'https://secret.example/diagram.png',
      } as CanonMessage['attachments'][number]],
    });
    const context = handlerContext([latest]);
    context.turnContext.message.renderedContent = '[Image: diagram.png]';
    const prompt = formatCanonMessages(context);

    expect(prompt).toContain('[Image: diagram.png]');
    expect(prompt).not.toContain('https://secret.example');
  });
});
