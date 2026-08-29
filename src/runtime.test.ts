import { describe, expect, it } from 'vitest';
import { redactAgentRuntimeForConversation } from '@canonmsg/core';

import { createDeepSeekHarnessRuntimeDescriptor } from './runtime.js';

describe('DeepSeek Harness runtime descriptor', () => {
  it('proves only controls enforced by the bridge', () => {
    const descriptor = createDeepSeekHarnessRuntimeDescriptor('/private/canon-secret-project');

    expect(descriptor.coreControls).toEqual([
      expect.objectContaining({
        id: 'workspace',
        defaultValue: 'dsh-workspace-root',
        availability: 'setup',
        liveBehavior: 'none',
        selectionPolicy: 'inherit',
      }),
    ]);
    expect(descriptor.coreControls[0]?.options).toEqual([
      expect.objectContaining({
        value: 'dsh-workspace-root',
        source: 'explicit',
      }),
    ]);
    expect(descriptor.workspaceRoots).toEqual([
      expect.objectContaining({ id: 'dsh-workspace-root' }),
    ]);
    expect(descriptor.runtimeControls).toEqual([]);
    expect(descriptor.commands).toEqual([]);
    expect(descriptor.streamingTextMode).toBe('delta');
    expect(descriptor.supportsInterrupt).toBe(true);
    expect(descriptor.supportsInputInterrupt).toBe(true);
    expect(descriptor.runtimeControls).toEqual([]);
    expect(descriptor.commands).toEqual([]);
  });

  it('redacts absolute workspace paths from conversation-visible descriptors', () => {
    const descriptor = createDeepSeekHarnessRuntimeDescriptor('/private/canon-secret-project');
    const redacted = redactAgentRuntimeForConversation({ runtimeDescriptor: descriptor });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('/private/canon-secret-project');
    expect(serialized).not.toContain('/private/');
    expect(redacted.runtimeDescriptor?.presentation?.fields?.cwd).toEqual({ visibility: 'hidden' });
    expect(redacted.runtimeDescriptor?.presentation?.fields?.workspaceRoot)
      .toEqual({ visibility: 'hidden' });
  });

  it('advertises only the DSH plan mode that the bridge explicitly enables', () => {
    expect(createDeepSeekHarnessRuntimeDescriptor('/workspace').turnModes).toBeUndefined();
    expect(createDeepSeekHarnessRuntimeDescriptor('/workspace', true).turnModes).toEqual([
      expect.objectContaining({ id: 'normal', default: true }),
      expect.objectContaining({ id: 'plan', ownerOnly: true }),
    ]);
  });
});
