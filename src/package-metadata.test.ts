import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REGISTRATION_CLI_OPTIONS } from './register.js';

const packageRoot = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  version: string;
  private?: boolean;
  files: string[];
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  publishConfig: { access: string };
  repository: { type: string; url: string };
  homepage: string;
};

describe('Canon DSH package metadata', () => {
  it('is release-ready as a public DSH bundle', () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/HeyBobChan/canon-deepseek-harness-plugin.git',
    });
    expect(manifest.homepage).toBe('https://github.com/HeyBobChan/canon-deepseek-harness-plugin#readme');
    expect(manifest.files).toEqual(['dist', 'cordis.patch.yml', 'README.md', 'LICENSE']);
    expect(manifest.dependencies).toMatchObject({
      '@canonmsg/agent-sdk': '^8.8.0',
      '@canonmsg/core': '^10.6.0',
    });
    expect(manifest.peerDependencies).toMatchObject({
      '@deepseek-ai/dsh-agent': '0.1.1-rc.2',
      '@deepseek-ai/dsh-llm': '0.1.1-rc.2',
      '@deepseek-ai/dsh-session': '0.1.1-rc.2',
      '@deepseek-ai/dsh-session-persistence': '0.1.1-rc.2',
      '@deepseek-ai/dsh-user-approval': '0.1.1-rc.2',
    });
    expect(manifest.peerDependencies['@deepseek-ai/dsh-tools']).toBeUndefined();
  });

  it('declares source entry points and a DSH-specific registration CLI', () => {
    for (const source of ['index.ts', 'register.ts', 'bridge.ts']) {
      expect(existsSync(join(packageRoot, 'src', source))).toBe(true);
    }
    expect(REGISTRATION_CLI_OPTIONS.clientType).toBe('deepseek-harness');
    expect(REGISTRATION_CLI_OPTIONS.cliName).toBe('canon-dsh-register');
    const instructions = REGISTRATION_CLI_OPTIONS.approvedInstructions?.('my-dsh') ?? [];
    expect(instructions.join('\n')).toContain('dsh plugin --profile <dsh-profile>');
    expect(instructions.join('\n')).toContain('--dump-config');
    expect(instructions.join('\n')).not.toContain('--cwd');
  });
});
