import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CanonSessionMap,
  sessionIdForConversation,
} from './session-map.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.length = 0;
});

async function temporaryMap() {
  const directory = await mkdtemp(join(tmpdir(), 'canon-dsh-map-'));
  temporaryDirectories.push(directory);
  return new CanonSessionMap(join(directory, 'sessions.json'));
}

describe('Canon DSH session mapping', () => {
  it('creates filesystem-safe deterministic session identities', () => {
    const id = sessionIdForConversation('conversation/../unsafe', 0);
    expect(id).toMatch(/^canon-[0-9a-f]{64}-0$/);
  });

  it('namespaces identities by Canon profile and workspace', () => {
    const first = sessionIdForConversation('conversation-1', 0, 'profile-a\0/workspace-a');
    const second = sessionIdForConversation('conversation-1', 0, 'profile-b\0/workspace-b');
    expect(first).not.toBe(second);
  });

  it('persists and resumes the active mapping across plugin restarts', async () => {
    const path = join((await mkdtemp(join(tmpdir(), 'canon-dsh-map-'))), 'sessions.json');
    temporaryDirectories.push(join(path, '..'));
    const first = new CanonSessionMap(path);
    const created = await first.getOrCreate('conversation-1');
    await first.flush();

    const second = new CanonSessionMap(path);
    await expect(second.getOrCreate('conversation-1')).resolves.toEqual(created);
  });

  it('advances generation for a new session without deleting old history', async () => {
    const map = await temporaryMap();
    const first = await map.getOrCreate('conversation-1');
    const second = await map.advance('conversation-1');

    expect(second.generation).toBe(1);
    expect(second.sessionId).not.toBe(first.sessionId);
    await expect(map.advance('missing')).rejects.toThrow(/no valid session mapping/);
  });

  it('does not lose concurrent first-use mappings', async () => {
    const map = await temporaryMap();
    const conversationIds = Array.from({ length: 8 }, (_, index) => `conversation-${index}`);
    const stored = await Promise.all(conversationIds.map((id) => map.getOrCreate(id)));
    await map.flush();

    const reloaded = new CanonSessionMap(
      (map as unknown as { path: string }).path,
      (map as unknown as { namespace: string }).namespace,
    );
    await expect(Promise.all(conversationIds.map((id) => reloaded.getOrCreate(id))))
      .resolves.toEqual(expect.arrayContaining(stored));
  });

  it('persists confirmation separately from allocation', async () => {
    const map = await temporaryMap();
    const allocated = await map.getOrCreate('conversation-1');
    expect(allocated.confirmed).toBe(false);

    const confirmed = await map.confirm('conversation-1', allocated.sessionId);
    expect(confirmed.confirmed).toBe(true);
    await map.flush();

    const reloaded = new CanonSessionMap(
      (map as unknown as { path: string }).path,
      (map as unknown as { namespace: string }).namespace,
    );
    await expect(reloaded.getOrCreate('conversation-1')).resolves.toMatchObject({
      confirmed: true,
    });
  });

  it('advances an existing active mapping in one atomic operation', async () => {
    const map = await temporaryMap();
    const allocated = await map.getOrCreate('conversation-1');
    await map.confirm('conversation-1', allocated.sessionId);

    await expect(map.advanceOrCreate('conversation-1')).resolves.toMatchObject({
      generation: 1,
      confirmed: false,
    });
  });

  it('does not confirm a session after its mapping advances', async () => {
    const map = await temporaryMap();
    const allocated = await map.getOrCreate('conversation-1');
    await map.advance('conversation-1');

    await expect(map.confirm('conversation-1', allocated.sessionId))
      .rejects.toThrow(/mapping changed during acquisition/);
  });

  it('advances a persisted mapping that is not loaded in memory', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'canon-dsh-map-')), 'sessions.json');
    temporaryDirectories.push(join(path, '..'));
    const first = new CanonSessionMap(path, 'profile-a\0/workspace-a');
    const allocated = await first.getOrCreate('conversation-1');
    await first.confirm('conversation-1', allocated.sessionId);
    await first.flush();

    const reloaded = new CanonSessionMap(path, 'profile-a\0/workspace-a');
    await expect(reloaded.advanceOrCreate('conversation-1')).resolves.toMatchObject({
      generation: 1,
      confirmed: false,
    });
  });

  it('creates generation zero for a first-use conversation', async () => {
    const map = await temporaryMap();
    await expect(map.advanceOrCreate('conversation-1')).resolves.toMatchObject({
      generation: 0,
      confirmed: false,
    });
  });

  it('fails closed on a corrupt mapping', async () => {
    const map = await temporaryMap();
    await map.getOrCreate('conversation-1');
    await map.flush();
    const raw = await readFile((map as unknown as { path: string }).path, 'utf8');
    const corrupt = new CanonSessionMap((map as unknown as { path: string }).path);
    (corrupt as unknown as { data: unknown }).data = {
      ...JSON.parse(raw),
      conversations: {
        'conversation-1': { generation: 0, sessionId: 'not-canonical', updatedAt: 'now' },
      },
    };
    (corrupt as unknown as { loaded: boolean }).loaded = true;
    await expect(corrupt.getOrCreate('conversation-1')).rejects.toThrow(/invalid session mapping/);
  });
});
