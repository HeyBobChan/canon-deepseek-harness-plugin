import type { CanonRuntimeDescriptor } from '@canonmsg/core';
import { DEFAULT_FIRST_PARTY_RUNTIME_PRESENTATION } from '@canonmsg/core';
import { basename } from 'node:path';

export function createDeepSeekHarnessRuntimeDescriptor(
  workspaceRoot: string,
  planMode = false,
): CanonRuntimeDescriptor {
  const workspaceId = 'dsh-workspace-root';
  const workspaceLabel = basename(workspaceRoot) || 'DSH workspace';

  return {
    coreControls: [
      {
        id: 'workspace',
        label: 'Project',
        options: [
          {
            value: workspaceId,
            label: workspaceLabel,
            description: 'The DSH project configured for this Canon agent.',
            source: 'explicit',
          },
        ],
        defaultValue: workspaceId,
        availability: 'setup',
        liveBehavior: 'none',
        selectionPolicy: 'inherit',
      },
    ],
    runtimeControls: [],
    commands: [],
    ...(planMode
      ? {
        turnModes: [
          {
            id: 'normal',
            label: 'Normal',
            description: 'Let DeepSeek Harness answer or act normally.',
            scope: 'next_turn' as const,
            default: true,
            activation: { kind: 'message_metadata' as const, value: 'normal' },
          },
          {
            id: 'plan',
            label: 'Plan',
            description: 'Ask DeepSeek Harness to plan before implementing.',
            scope: 'next_turn' as const,
            ownerOnly: true,
            activation: { kind: 'message_metadata' as const, value: 'plan' },
          },
        ],
      }
      : {}),
    workspaceRoots: [
      {
        id: workspaceId,
        label: workspaceLabel,
        description: 'The DSH project configured for this Canon agent.',
      },
    ],
    supportsInterrupt: true,
    supportsInputInterrupt: true,
    streamingTextMode: 'delta',
    presentation: DEFAULT_FIRST_PARTY_RUNTIME_PRESENTATION,
  };
}
