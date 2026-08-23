import type { CanonRuntimeDescriptor } from '@canonmsg/core';
import { DEFAULT_FIRST_PARTY_RUNTIME_PRESENTATION } from '@canonmsg/core';
import { basename } from 'node:path';

export function createDeepSeekHarnessRuntimeDescriptor(
  workspaceRoot: string,
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
