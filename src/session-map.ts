import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';

export interface StoredCanonSession {
  generation: number;
  sessionId: string;
  /** False until DSH confirms the allocated session exists. */
  confirmed?: boolean;
  updatedAt: string;
}

interface SessionMapFile {
  version: 1;
  conversations: Record<string, StoredCanonSession>;
}

export function sessionIdForConversation(
  conversationId: string,
  generation: number,
  namespace = '',
): string {
  const digest = createHash('sha256')
    .update(namespace)
    .update(conversationId)
    .update(`\0${generation}`)
    .digest('hex');
  return `canon-${digest}-${generation}`;
}

export class CanonSessionMap {
  private data: SessionMapFile = { version: 1, conversations: {} };
  private loaded = false;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly namespace = '',
  ) {}

  async load(): Promise<void> {
    return this.transaction(() => this.loadNow());
  }

  async getOrCreate(conversationId: string, now = (): Date => new Date()): Promise<StoredCanonSession> {
    return this.transaction(async () => {
      await this.loadNow();
      const existing = this.data.conversations[conversationId];
      const validExisting = storedSessionFor(conversationId, existing, this.path, this.namespace);
      if (validExisting) return validExisting;

      return this.writeAllocated(conversationId, 0, now);
    });
  }

  async confirm(
    conversationId: string,
    expectedSessionId: string,
    now = (): Date => new Date(),
  ): Promise<StoredCanonSession> {
    return this.transaction(async () => {
      await this.loadNow();
      const current = storedSessionFor(
        conversationId,
        this.data.conversations[conversationId],
        this.path,
        this.namespace,
      );
      if (!current) {
        throw new Error(`canon-dsh: no valid session mapping for conversation ${conversationId}`);
      }
      if (current.sessionId !== expectedSessionId) {
        throw new Error(`canon-dsh: session mapping changed during acquisition for conversation ${conversationId}`);
      }
      if (current.confirmed) return current;
      const confirmed = { ...current, confirmed: true, updatedAt: now().toISOString() };
      this.data.conversations[conversationId] = confirmed;
      await this.write();
      return confirmed;
    });
  }

  async assertCurrent(
    conversationId: string,
    expectedSessionId: string,
  ): Promise<StoredCanonSession> {
    return this.transaction(async () => {
      await this.loadNow();
      const current = storedSessionFor(
        conversationId,
        this.data.conversations[conversationId],
        this.path,
        this.namespace,
      );
      if (!current) {
        throw new Error(`canon-dsh: no valid session mapping for conversation ${conversationId}`);
      }
      if (current.sessionId !== expectedSessionId) {
        throw new Error(`canon-dsh: session mapping changed during acquisition for conversation ${conversationId}`);
      }
      return current;
    });
  }

  async advance(conversationId: string, now = (): Date => new Date()): Promise<StoredCanonSession> {
    return this.transaction(async () => {
      await this.loadNow();
      const current = storedSessionFor(
        conversationId,
        this.data.conversations[conversationId],
        this.path,
        this.namespace,
      );
      if (!current) {
        throw new Error(`canon-dsh: no valid session mapping for conversation ${conversationId}`);
      }
      return this.writeAllocated(conversationId, current.generation + 1, now);
    });
  }

  async advanceOrCreate(
    conversationId: string,
    now = (): Date => new Date(),
  ): Promise<StoredCanonSession> {
    return this.transaction(async () => {
      await this.loadNow();
      const current = storedSessionFor(
        conversationId,
        this.data.conversations[conversationId],
        this.path,
        this.namespace,
      );
      if (!current) {
        return this.writeAllocated(conversationId, 0, now);
      }

      return this.writeAllocated(conversationId, current.generation + 1, now);
    });
  }

  private async writeAllocated(
    conversationId: string,
    generation: number,
    now: () => Date,
  ): Promise<StoredCanonSession> {
    const allocated: StoredCanonSession = {
      generation,
      sessionId: this.sessionIdFor(conversationId, generation),
      confirmed: false,
      updatedAt: now().toISOString(),
    };
    this.data.conversations[conversationId] = allocated;
    await this.write();
    return allocated;
  }

  async flush(): Promise<void> {
    await this.transactionTail;
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transactionTail.then(operation);
    this.transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadNow(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = { version: 1, conversations: {} };
        this.loaded = true;
        return;
      }
      throw error;
    }
    this.data = parseSessionMap(raw, this.path, this.namespace);
    this.loaded = true;
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  private sessionIdFor(conversationId: string, generation: number): string {
    return sessionIdForConversation(conversationId, generation, this.namespace);
  }
}

function storedSessionFor(
  conversationId: string,
  value: unknown,
  path: string,
  namespace: string,
): StoredCanonSession | null {
  if (!isStoredSession(value)) return null;
  if (value.sessionId !== sessionIdForConversation(conversationId, value.generation, namespace)) {
    throw new Error(`canon-dsh: invalid session mapping for ${conversationId} in ${path}`);
  }
  return value;
}

function parseSessionMap(raw: string, path: string, namespace: string): SessionMapFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`canon-dsh: cannot parse session map ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || typeof (parsed as { conversations?: unknown }).conversations !== 'object'
    || Array.isArray((parsed as { conversations?: unknown }).conversations)
  ) {
    throw new Error(`canon-dsh: invalid session map ${path}`);
  }

  const conversations: Record<string, StoredCanonSession> = {};
  for (const [conversationId, value] of Object.entries((parsed as { conversations: Record<string, unknown> }).conversations)) {
    if (!isStoredSession(value)) {
      throw new Error(`canon-dsh: invalid session mapping for ${conversationId} in ${path}`);
    }
    const expected = sessionIdForConversation(conversationId, value.generation, namespace);
    if (value.sessionId !== expected) {
      throw new Error(`canon-dsh: session mapping for ${conversationId} does not match its generation in ${path}`);
    }
    conversations[conversationId] = value;
  }
  return { version: 1, conversations };
}

function isStoredSession(value: unknown): value is StoredCanonSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.generation === 'number'
    && Number.isInteger(record.generation)
    && record.generation >= 0
    && typeof record.sessionId === 'string'
    && (record.confirmed === undefined || typeof record.confirmed === 'boolean')
    && typeof record.updatedAt === 'string';
}

export function dshSessionId(value: string): ReturnType<typeof SessionId> {
  return SessionId(value);
}
