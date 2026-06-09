// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { liveQuery } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DexieStore } from '../../src/dexie/store';
import { createEncryptedStoreContext } from '../../src/react/hooks';
import {
  defineStore,
  defineTable,
  type SyncableMeta,
  type SyncableStoreTable,
  sync,
} from '../../src/store';
import {
  type CryptoManager,
  CryptoPayload,
  createCryptoStore,
} from '../../src/store/crypto';

// ─── Server record types ──────────────────────────────────────────────────────
// The server stores raw (encrypted) data — encrypted fields are opaque blobs.

type ServerNote = SyncableMeta & {
  title: string;
  body?: unknown; // encrypted on write; absent on server-createdAt records
  createdAt: Date;
  deleted: boolean;
};

type ServerTag = SyncableMeta & {
  name: unknown; // encrypted blob
  createdAt: Date;
  deleted: boolean;
};

type ServerItem = SyncableMeta & {
  name: unknown; // encrypted blob
  createdAt: Date;
  deleted: boolean;
};

// ─── In-memory server table ───────────────────────────────────────────────────
// Implements SyncableStoreTable — same pattern as packages/store/tests/sync.test.ts.
// The `deleted: true` query option is intentionally ignored: the server has no
// soft-delete enforcement and the sync algorithm needs all rows including deleted ones.

function makeServerTable<T extends SyncableMeta>(
  initial: T[] = [],
): SyncableStoreTable<T> & { _db: Map<string, T> } {
  const db = new Map<string, T>(initial.map((i) => [i.id, i]));

  const findMany = async (query?: {
    where?: Record<string, unknown>;
    deleted?: true;
    orderBy?: Record<string, 'asc' | 'desc'>;
    limit?: number;
    offset?: number;
  }): Promise<T[]> => {
    let rows = [...db.values()];
    const where = query?.where;
    if (where) {
      const updatedAt = where.updatedAt as
        | { $gte?: Date; $lte?: Date }
        | undefined;
      if (updatedAt?.$gte)
        rows = rows.filter((r) => r.updatedAt >= updatedAt.$gte!);
      if (updatedAt?.$lte)
        rows = rows.filter((r) => r.updatedAt <= updatedAt.$lte!);

      const syncedAt = where.syncedAt as
        | { $gte?: Date; $lte?: Date }
        | undefined;
      if (syncedAt) {
        const t = (r: T) => r.syncedAt ?? r.updatedAt;
        if (syncedAt.$gte) rows = rows.filter((r) => t(r) >= syncedAt.$gte!);
        if (syncedAt.$lte) rows = rows.filter((r) => t(r) <= syncedAt.$lte!);
      }

      const idFilter = where.id as { $in?: string[] } | undefined;
      if (idFilter?.$in) {
        const ids = new Set(idFilter.$in);
        rows = rows.filter((r) => ids.has(r.id));
      }
    }

    // Apply orderBy (used by pagination)
    if (query?.orderBy) {
      const entries = Object.entries(query.orderBy);
      rows = rows.sort((a, b) => {
        for (const [col, dir] of entries) {
          const av = (a as Record<string, unknown>)[col];
          const bv = (b as Record<string, unknown>)[col];
          let cmp = 0;
          if (av instanceof Date && bv instanceof Date) {
            cmp = av.getTime() - bv.getTime();
          } else if (typeof av === 'string' && typeof bv === 'string') {
            cmp = av < bv ? -1 : av > bv ? 1 : 0;
          }
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }

    if (query?.offset) rows = rows.slice(query.offset);
    if (query?.limit != null) rows = rows.slice(0, query.limit);

    return rows;
  };

  const upsertMany = async (
    data: T[],
    _options?: { sync?: boolean },
  ): Promise<T[]> => {
    for (const item of data) db.set(item.id, item);
    return data.map((i) => ({ ...i }));
  };

  return { _db: db, findMany, upsertMany };
}

// ─── Schemas ──────────────────────────────────────────────────────────────────
// managed fields (updatedAt, createdAt, deleted) are included so Dexie auto-stamps them.

const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  updatedAt: z.date(),
  createdAt: z.date(),
  deleted: z.boolean(),
});

const NoteStorageSchema = NoteSchema.extend({
  body: CryptoPayload.optional(),
});

const TagSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.date(),
  createdAt: z.date(),
  deleted: z.boolean(),
});

const TagStorageSchema = TagSchema.extend({
  name: CryptoPayload,
});

const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.date(),
  createdAt: z.date(),
  deleted: z.boolean(),
});

const ItemStorageSchema = ItemSchema.extend({
  name: CryptoPayload,
});

const defs = defineStore({
  notes: defineTable({
    tableName: 'notes',
    schema: NoteStorageSchema,
    primaryKey: 'id',
    indexes: [{ columns: ['updatedAt'] }],
    encryptedFields: ['body'],
    decryptedSchema: NoteSchema,
  }),
  tags: defineTable({
    tableName: 'tags',
    schema: TagStorageSchema,
    primaryKey: 'id',
    indexes: [{ columns: ['updatedAt'] }],
    encryptedFields: ['name'],
    decryptedSchema: TagSchema,
  }),
  items: defineTable({
    tableName: 'items',
    schema: ItemStorageSchema,
    primaryKey: 'id',
    indexes: [{ columns: ['updatedAt'] }],
    encryptedFields: ['name'],
    decryptedSchema: ItemSchema,
  }),
});

// ─── Encryption helpers ───────────────────────────────────────────────────────

type MockKey = string;
const MOCK_KEY: MockKey = 'test-mek';

const mockManager: CryptoManager<MockKey> = {
  deriveKey: async (_config, secret, _salt) => secret.slice(0, 32),
  importKey: async (_config, _bytes) => MOCK_KEY,
  encrypt: async (_config, _key, data) => ({
    iv: 'mock-iv',
    cipher: btoa(String.fromCharCode(...data)),
  }),
  decrypt: async (_config, _key, { cipher }) =>
    Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0)),
  loadComputeKey: async (_config, mek: MockKey) => `compute:${mek}`,
  compute: async (_config, key: MockKey, data: Uint8Array) => {
    const keyBytes = new TextEncoder().encode(key);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      out[i] = data[i % data.length]! ^ keyBytes[i % keyBytes.length]!;
    return out;
  },
};

/**
 * Synchronous helper that produces the same CryptoPayload the mockManager would
 * produce for a given value — used to pre-populate server tables with ciphertext
 * and to write assertions against raw-store contents.
 */
function mockEncrypt(value: unknown): { iv: string; cipher: string } {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return { iv: 'mock-iv', cipher: btoa(String.fromCharCode(...data)) };
}

// ─── Context (module-level — createEncryptedStoreContext has no side effects) ─

const { StoreContext, useStore, useRawStore, useSync, useLiveQuery } =
  createEncryptedStoreContext<typeof defs>();

let dbCounter = 0;

// ─── Fixed timestamps ────────────────────────────────────────────────────────
// Spaced one hour apart so the sync window [T2, T4] reliably includes T3 changes.

const T1 = new Date('2024-01-01T01:00:00Z'); // client writes
const T2 = new Date('2024-01-01T02:00:00Z'); // first sync  → lastSynced = T2
const T3 = new Date('2024-01-01T03:00:00Z'); // server modifies
const T4 = new Date('2024-01-01T04:00:00Z'); // second sync → lastSynced = T4

// ─── Shared fetcher builder ───────────────────────────────────────────────────

function makeThreeTableFetcher(
  serverNotes: ReturnType<typeof makeServerTable<ServerNote>>,
  serverTags: ReturnType<typeof makeServerTable<ServerTag>>,
  serverItems: ReturnType<typeof makeServerTable<ServerItem>>,
  pageSize?: number,
) {
  return async ({
    from,
    to,
    delta,
    pageOffset = 0,
  }: {
    from: Date;
    to: Date;
    delta: Record<string, SyncableMeta[]>;
    pageOffset: number;
  }) => {
    return sync(
      { notes: serverNotes, tags: serverTags, items: serverItems },
      { current: to, from, to, delta, pageOffset },
      { pageSize },
    );
  };
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

describe('useSync — encrypted store integration demo', () => {
  let rawStore: DexieStore<typeof defs>;
  let encStore: ReturnType<
    typeof createCryptoStore<typeof defs, MockKey>
  >['store'];
  let serverNotes: ReturnType<typeof makeServerTable<ServerNote>>;
  let serverTags: ReturnType<typeof makeServerTable<ServerTag>>;
  let serverItems: ReturnType<typeof makeServerTable<ServerItem>>;

  beforeEach(() => {
    // Only fake Date — leaving setTimeout/setImmediate real so fake-indexeddb's
    // internal async operations resolve normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T1);
    rawStore = new DexieStore(`sync-demo-${++dbCounter}`, defs);
    const cs = createCryptoStore(rawStore, defs, mockManager);
    cs.setMek(MOCK_KEY);
    encStore = cs.store;
    serverNotes = makeServerTable<ServerNote>();
    serverTags = makeServerTable<ServerTag>();
    serverItems = makeServerTable<ServerItem>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Test 1: Full round-trip ────────────────────────────────────────────────

  it('full round-trip: write on client → sync to server → server modifies → sync back', async () => {
    const settings = rawStore.settings;
    const fetcher = makeThreeTableFetcher(serverNotes, serverTags, serverItems);

    const { result } = renderHook(
      () => {
        const store = useStore();
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
        } = useSync({
          store: {
            notes: raw.table.notes,
            tags: raw.table.tags,
            items: raw.table.items,
          },
          fetcher,
          defaultFrom: new Date(0),
        });
        const notes = useLiveQuery(() => store.table.notes.findMany());
        const tags = useLiveQuery(() => store.table.tags.findMany());
        const items = useLiveQuery(() => store.table.items.findMany());
        return { doSync, syncing, lastSynced, notes, tags, items, store, raw };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // ── Initial state ─────────────────────────────────────────────────────────
    // Auto-sync fires immediately on mount; wait for it to complete.
    // Server is empty so the auto-sync is a no-op for data but sets lastSynced.
    await waitFor(() => expect(result.current.syncing).toBe(false));
    expect(result.current.lastSynced).toBe(T1.toISOString());
    // liveQuery has emitted empty arrays after auto-sync drain
    expect(result.current.notes ?? []).toHaveLength(0);
    expect(result.current.tags ?? []).toHaveLength(0);
    expect(result.current.items ?? []).toHaveLength(0);
    // Settings: persisted by auto-sync
    expect(await settings.get('lastSynced')).toBe(T1.toISOString());
    // Server: still empty (no client data to push yet)
    expect(serverNotes._db.size).toBe(0);
    expect(serverTags._db.size).toBe(0);
    expect(serverItems._db.size).toBe(0);

    // ── Step 1: Write client data at T1 ──────────────────────────────────────
    // Managed fields (updatedAt, createdAt, deleted) are overridden by Dexie auto-stamp
    // to the current fake time T1; the values passed here are just placeholders.
    await act(async () => {
      await result.current.store.table.notes.insert({
        id: 'note-1',
        title: 'Hello',
        body: 'My secret',
        updatedAt: new Date(),
        createdAt: new Date(),
        deleted: false,
      });
      await result.current.store.table.tags.insert({
        id: 'tag-1',
        name: 'secret-tag',
        updatedAt: new Date(),
        createdAt: new Date(),
        deleted: false,
      });
      await result.current.store.table.items.insert({
        id: 'item-1',
        name: 'secret-item',
        updatedAt: new Date(),
        createdAt: new Date(),
        deleted: false,
      });
    });

    // ── Storage state after T1 writes ─────────────────────────────────────────

    // Enc client (decrypted via liveQuery): 1 record per table, all fields correct
    await waitFor(() => {
      expect(result.current.notes).toHaveLength(1);
      expect(result.current.tags).toHaveLength(1);
      expect(result.current.items).toHaveLength(1);
    });

    const encNote1 = result.current.notes![0]!;
    expect(encNote1.id).toBe('note-1');
    expect(encNote1.title).toBe('Hello');
    expect(encNote1.body).toBe('My secret'); // decrypted
    expect(encNote1.updatedAt).toEqual(T1);
    expect(encNote1.createdAt).toEqual(T1);
    expect(encNote1.deleted).toBe(false);

    const encTag1 = result.current.tags![0]!;
    expect(encTag1.id).toBe('tag-1');
    expect(encTag1.name).toBe('secret-tag'); // decrypted
    expect(encTag1.updatedAt).toEqual(T1);
    expect(encTag1.createdAt).toEqual(T1);
    expect(encTag1.deleted).toBe(false);

    const encItem1 = result.current.items![0]!;
    expect(encItem1.id).toBe('item-1');
    expect(encItem1.name).toBe('secret-item'); // decrypted
    expect(encItem1.updatedAt).toEqual(T1);
    expect(encItem1.createdAt).toEqual(T1);
    expect(encItem1.deleted).toBe(false);

    // Raw client: encrypted blobs, correct counts, titles and timestamps preserved
    const rawAllNotes0 = await result.current.raw.table.notes.findMany();
    expect(rawAllNotes0).toHaveLength(1);
    expect(rawAllNotes0[0]!.id).toBe('note-1');
    expect(rawAllNotes0[0]!.title).toBe('Hello'); // title is NOT encrypted
    expect(rawAllNotes0[0]!.body).not.toBe('My secret'); // body IS encrypted
    expect(rawAllNotes0[0]!.body).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    }); // CryptoPayload
    expect(rawAllNotes0[0]!.updatedAt).toEqual(T1);
    expect(rawAllNotes0[0]!.createdAt).toEqual(T1);
    expect(rawAllNotes0[0]!.deleted).toBe(false);

    const rawAllTags0 = await result.current.raw.table.tags.findMany();
    expect(rawAllTags0).toHaveLength(1);
    expect(rawAllTags0[0]!.id).toBe('tag-1');
    expect(rawAllTags0[0]!.name).not.toBe('secret-tag'); // name IS encrypted
    expect(rawAllTags0[0]!.name).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(rawAllTags0[0]!.updatedAt).toEqual(T1);
    expect(rawAllTags0[0]!.deleted).toBe(false);

    const rawAllItems0 = await result.current.raw.table.items.findMany();
    expect(rawAllItems0).toHaveLength(1);
    expect(rawAllItems0[0]!.id).toBe('item-1');
    expect(rawAllItems0[0]!.name).not.toBe('secret-item'); // name IS encrypted
    expect(rawAllItems0[0]!.name).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(rawAllItems0[0]!.updatedAt).toEqual(T1);

    // Hook state: idle after initial auto-sync; lastSynced=T1 (auto-sync ran on empty server)
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBe(T1.toISOString());
    expect(await settings.get('lastSynced')).toBe(T1.toISOString());

    // Server: still empty — note-1/tag-1/item-1 were inserted AFTER auto-sync completed
    expect(serverNotes._db.size).toBe(0);
    expect(serverTags._db.size).toBe(0);
    expect(serverItems._db.size).toBe(0);

    // ── Step 2: First sync at T2 ──────────────────────────────────────────────
    vi.setSystemTime(T2);
    await act(async () => {
      await result.current.doSync();
    });

    // ── Storage state after first sync (T2) ──────────────────────────────────

    // Hook state: idle, lastSynced set to T2
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBe(T2.toISOString());

    // Settings table persisted (fire-and-forget write — use waitFor)
    await waitFor(async () => {
      expect(await settings.get('lastSynced')).toBe(T2.toISOString());
    });

    // Enc client: unchanged — server had nothing new to return (it was empty before sync)
    await waitFor(() => {
      expect(result.current.notes).toHaveLength(1);
      expect(result.current.tags).toHaveLength(1);
      expect(result.current.items).toHaveLength(1);
    });
    expect(result.current.notes![0]!.id).toBe('note-1');
    expect(result.current.notes![0]!.title).toBe('Hello');
    expect(result.current.notes![0]!.body).toBe('My secret');
    expect(result.current.notes![0]!.updatedAt).toEqual(T1); // unchanged by sync
    expect(result.current.tags![0]!.id).toBe('tag-1');
    expect(result.current.tags![0]!.name).toBe('secret-tag');
    expect(result.current.tags![0]!.updatedAt).toEqual(T1);
    expect(result.current.items![0]!.id).toBe('item-1');
    expect(result.current.items![0]!.name).toBe('secret-item');
    expect(result.current.items![0]!.updatedAt).toEqual(T1);

    // Raw client: still encrypted, still 1 record each, timestamps unchanged
    const rawAllNotes1 = await result.current.raw.table.notes.findMany();
    expect(rawAllNotes1).toHaveLength(1);
    expect(rawAllNotes1[0]!.title).toBe('Hello');
    expect(rawAllNotes1[0]!.body).not.toBe('My secret');
    expect(rawAllNotes1[0]!.body).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(rawAllNotes1[0]!.updatedAt).toEqual(T1);

    const rawAllTags1 = await result.current.raw.table.tags.findMany();
    expect(rawAllTags1).toHaveLength(1);
    expect(rawAllTags1[0]!.name).not.toBe('secret-tag');
    expect(rawAllTags1[0]!.name).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(rawAllTags1[0]!.updatedAt).toEqual(T1);

    const rawAllItems1 = await result.current.raw.table.items.findMany();
    expect(rawAllItems1).toHaveLength(1);
    expect(rawAllItems1[0]!.name).not.toBe('secret-item');
    expect(rawAllItems1[0]!.name).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(rawAllItems1[0]!.updatedAt).toEqual(T1);

    // Server: received all three records with correct shape, encrypted fields, timestamps
    expect(serverNotes._db.size).toBe(1);
    const serverNote1 = serverNotes._db.get('note-1')!;
    expect(serverNote1.id).toBe('note-1');
    expect(serverNote1.title).toBe('Hello'); // not encrypted
    expect(serverNote1.body).not.toBe('My secret'); // encrypted
    expect(serverNote1.body).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(serverNote1.body).toEqual(rawAllNotes1[0]!.body); // identical ciphertext as client's raw
    expect(serverNote1.updatedAt).toEqual(T1);
    expect(serverNote1.createdAt).toEqual(T1);
    expect(serverNote1.deleted).toBe(false);

    expect(serverTags._db.size).toBe(1);
    const serverTag1 = serverTags._db.get('tag-1')!;
    expect(serverTag1.id).toBe('tag-1');
    expect(serverTag1.name).not.toBe('secret-tag'); // encrypted
    expect(serverTag1.name).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(serverTag1.name).toEqual(rawAllTags1[0]!.name); // identical ciphertext
    expect(serverTag1.updatedAt).toEqual(T1);
    expect(serverTag1.deleted).toBe(false);

    expect(serverItems._db.size).toBe(1);
    const serverItem1 = serverItems._db.get('item-1')!;
    expect(serverItem1.id).toBe('item-1');
    expect(serverItem1.name).not.toBe('secret-item'); // encrypted
    expect(serverItem1.name).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(serverItem1.name).toEqual(rawAllItems1[0]!.name); // identical ciphertext
    expect(serverItem1.updatedAt).toEqual(T1);

    // ── Step 3: Server modifies data at T3 ───────────────────────────────────
    // notes: update note-1 title (plaintext field, no re-encryption needed)
    //        add note-2 (server-originated, no body)
    serverNotes._db.set('note-1', {
      ...serverNote1,
      title: 'Server Update',
      updatedAt: T3,
    });
    serverNotes._db.set('note-2', {
      id: 'note-2',
      title: 'From Server',
      updatedAt: T3,
      createdAt: T3,
      deleted: false,
    });

    // tags: add tag-2 with a server-generated encrypted name
    // (our encrypt = JSON.stringify so the server can produce valid ciphertext)
    serverTags._db.set('tag-2', {
      id: 'tag-2',
      name: mockEncrypt('server-tag'),
      updatedAt: T3,
      createdAt: T3,
      deleted: false,
    });

    // items: update item-1 with a new encrypted name
    serverItems._db.set('item-1', {
      ...serverItem1,
      name: mockEncrypt('updated-item'),
      updatedAt: T3,
    });

    // ── Server state after T3 mutations (no sync yet) ─────────────────────────

    // notes: 2 records — note-1 updated, note-2 added
    expect(serverNotes._db.size).toBe(2);
    expect(serverNotes._db.get('note-1')!.title).toBe('Server Update');
    expect(serverNotes._db.get('note-1')!.updatedAt).toEqual(T3);
    expect(serverNotes._db.get('note-1')!.body).toEqual(serverNote1.body); // original ciphertext preserved
    expect(serverNotes._db.get('note-1')!.deleted).toBe(false);
    expect(serverNotes._db.get('note-2')!.title).toBe('From Server');
    expect(serverNotes._db.get('note-2')!.updatedAt).toEqual(T3);
    expect(serverNotes._db.get('note-2')!.body).toBeUndefined();

    // tags: 2 records — tag-1 unchanged, tag-2 added
    expect(serverTags._db.size).toBe(2);
    expect(serverTags._db.get('tag-1')!.updatedAt).toEqual(T1); // tag-1 untouched
    expect(serverTags._db.get('tag-2')!.name).toEqual(
      mockEncrypt('server-tag'),
    );
    expect(serverTags._db.get('tag-2')!.updatedAt).toEqual(T3);

    // items: 1 record — item-1 updated
    expect(serverItems._db.size).toBe(1);
    expect(serverItems._db.get('item-1')!.name).toEqual(
      mockEncrypt('updated-item'),
    );
    expect(serverItems._db.get('item-1')!.updatedAt).toEqual(T3);

    // Client liveQuery still reflects pre-T3 state (no sync yet)
    expect(result.current.notes).toHaveLength(1);
    expect(result.current.notes![0]!.title).toBe('Hello');
    expect(result.current.tags).toHaveLength(1);
    expect(result.current.tags![0]!.name).toBe('secret-tag');
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items![0]!.name).toBe('secret-item');
    // Hook state unchanged since T2 sync
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBe(T2.toISOString());

    // ── Step 4: Second sync at T4 ─────────────────────────────────────────────
    // Server window [T2, T4] covers all T3 modifications above.
    // Client delta for this sync is empty (all local records have updatedAt=T1 < T2=from).
    vi.setSystemTime(T4);
    await act(async () => {
      await result.current.doSync();
    });

    // ── Storage state after second sync (T4) ─────────────────────────────────

    // Hook state: idle, lastSynced advanced to T4
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBe(T4.toISOString());
    expect(result.current.lastSynced).not.toBe(T2.toISOString());

    // Settings table updated to T4
    await waitFor(async () => {
      expect(await settings.get('lastSynced')).toBe(T4.toISOString());
    });

    // Enc client: 2 notes, 2 tags, 1 item — all server changes reflected
    await waitFor(() => {
      expect(result.current.notes).toHaveLength(2);
      expect(result.current.tags).toHaveLength(2);
      expect(result.current.items).toHaveLength(1);
    });

    // note-1: title updated by server; body (kept by server) still decrypts correctly
    const note1Final = result.current.notes!.find((n) => n.id === 'note-1')!;
    expect(note1Final.title).toBe('Server Update');
    expect(note1Final.body).toBe('My secret'); // original ciphertext, client decrypts
    expect(note1Final.updatedAt).toEqual(T3);
    expect(note1Final.deleted).toBe(false);

    // note-2: new server record, no body
    const note2Final = result.current.notes!.find((n) => n.id === 'note-2')!;
    expect(note2Final.title).toBe('From Server');
    expect(note2Final.body).toBeUndefined();
    expect(note2Final.updatedAt).toEqual(T3);

    // tag-1: server never updatedAt tag-1; still reflects original client data
    const tag1Final = result.current.tags!.find((t) => t.id === 'tag-1')!;
    expect(tag1Final.name).toBe('secret-tag');
    expect(tag1Final.updatedAt).toEqual(T1); // original timestamp preserved

    // tag-2: new server record with server-generated ciphertext, decrypts correctly
    const tag2Final = result.current.tags!.find((t) => t.id === 'tag-2')!;
    expect(tag2Final.name).toBe('server-tag');
    expect(tag2Final.updatedAt).toEqual(T3);

    // item-1: name updated by server, decrypts correctly
    const item1Final = result.current.items!.find((i) => i.id === 'item-1')!;
    expect(item1Final.name).toBe('updated-item');
    expect(item1Final.updatedAt).toEqual(T3);

    // Raw client: encrypted in all tables, correct counts, exact ciphertext values
    const rawAllNotes2 = await result.current.raw.table.notes.findMany();
    expect(rawAllNotes2).toHaveLength(2);

    const rawNote1Final = rawAllNotes2.find((n) => n.id === 'note-1')!;
    expect(rawNote1Final.title).toBe('Server Update'); // plaintext field updated
    expect(rawNote1Final.body).not.toBe('My secret'); // still encrypted
    expect(rawNote1Final.body).toEqual(serverNote1.body); // same ciphertext server held
    expect(rawNote1Final.updatedAt).toEqual(T3);

    const rawNote2Final = rawAllNotes2.find((n) => n.id === 'note-2')!;
    expect(rawNote2Final.title).toBe('From Server');
    expect(rawNote2Final.body).toBeUndefined(); // server never set a body
    expect(rawNote2Final.updatedAt).toEqual(T3);

    const rawAllTags2 = await result.current.raw.table.tags.findMany();
    expect(rawAllTags2).toHaveLength(2);

    const rawTag1Final = rawAllTags2.find((t) => t.id === 'tag-1')!;
    expect(rawTag1Final.name).not.toBe('secret-tag'); // encrypted
    expect(rawTag1Final.updatedAt).toEqual(T1); // not re-written by second sync

    const rawTag2Final = rawAllTags2.find((t) => t.id === 'tag-2')!;
    expect(rawTag2Final.name).toEqual(mockEncrypt('server-tag')); // exact ciphertext
    expect(rawTag2Final.name).not.toBe('server-tag'); // not plaintext
    expect(rawTag2Final.updatedAt).toEqual(T3);

    const rawAllItems2 = await result.current.raw.table.items.findMany();
    expect(rawAllItems2).toHaveLength(1);

    const rawItem1Final = rawAllItems2.find((i) => i.id === 'item-1')!;
    expect(rawItem1Final.name).toEqual(mockEncrypt('updated-item')); // exact ciphertext
    expect(rawItem1Final.name).not.toBe('updated-item'); // not plaintext
    expect(rawItem1Final.updatedAt).toEqual(T3);

    // Server: unchanged by second sync — client sent no new delta (all updatedAt=T1 < T2=from)
    expect(serverNotes._db.size).toBe(2);
    expect(serverNotes._db.get('note-1')!.title).toBe('Server Update');
    expect(serverNotes._db.get('note-1')!.updatedAt).toEqual(T3);
    expect(serverNotes._db.get('note-2')!.title).toBe('From Server');
    expect(serverNotes._db.get('note-2')!.updatedAt).toEqual(T3);
    expect(serverTags._db.size).toBe(2);
    expect(serverTags._db.get('tag-1')!.updatedAt).toEqual(T1);
    expect(serverTags._db.get('tag-2')!.updatedAt).toEqual(T3);
    expect(serverItems._db.size).toBe(1);
    expect(serverItems._db.get('item-1')!.updatedAt).toEqual(T3);
  });

  // ─── Test 2: Stale client data overwritten by server (LWW server wins) ───────

  it('stale client data is overwritten when server holds a newer version (LWW server wins)', async () => {
    const settings = rawStore.settings;

    // Three timestamps: client wrote stale data (Ts), server has newer data (T-n), sync runs (T-sync)
    const Ts = new Date('2024-06-01T01:00:00Z'); // stale — client's local version
    const Tn = new Date('2024-06-01T02:00:00Z'); // newer — server's authoritative version
    const Tsync = new Date('2024-06-01T03:00:00Z'); // time of sync

    // ── Pre-populate server ───────────────────────────────────────────────────
    // note-A: server has a newer version (Tn) — should overwrite client's stale copy
    serverNotes._db.set('note-A', {
      id: 'note-A',
      title: 'Server Authoritative',
      body: mockEncrypt('server body'),
      updatedAt: Tn,
      createdAt: Tn,
      deleted: false,
    });
    // note-B: server-only record — client has never seen it
    serverNotes._db.set('note-B', {
      id: 'note-B',
      title: 'Server Only',
      updatedAt: Tn,
      createdAt: Tn,
      deleted: false,
    });

    // ── Pre-populate client with stale data ───────────────────────────────────
    vi.setSystemTime(Ts);
    // note-A: stale — same id as server's, but older updatedAt and different content
    // upsertMany({sync:true}) bypasses auto-stamp so we can set Ts exactly
    // Write stale data through encStore so body gets encrypted as a CryptoPayload.
    // sync:true preserves the explicit Ts timestamps and bypasses auto-stamping.
    await encStore.table.notes.upsertMany(
      [
        {
          id: 'note-A',
          title: 'Stale Client Title',
          body: 'stale body',
          updatedAt: Ts,
          createdAt: Ts,
          deleted: false,
        },
      ],
      { sync: true },
    );
    // note-C: client-only record — server has never seen it; auto-stamped at Ts
    await encStore.table.notes.insert({
      id: 'note-C',
      title: 'Client Only',
      updatedAt: new Date(),
      createdAt: new Date(),
      deleted: false,
    });

    // ── Render hooks ──────────────────────────────────────────────────────────
    const fetcher = async ({
      from,
      to,
      delta,
    }: {
      from: Date;
      to: Date;
      delta: Record<string, SyncableMeta[]>;
      pageOffset: number;
    }) => {
      return sync(
        { notes: serverNotes },
        { current: to, from, to, delta, pageOffset: 0 },
      );
    };

    const { result } = renderHook(
      () => {
        const store = useStore();
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
        } = useSync({
          store: { notes: raw.table.notes },
          fetcher,
          defaultFrom: new Date(0),
        });
        const notes = useLiveQuery(() => store.table.notes.findMany());
        return { doSync, syncing, lastSynced, notes, store, raw };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // ── Pre-sync storage state ─────────────────────────────────────────────────

    // Auto-sync fires on mount at Ts. Server records (updatedAt=Tn > Ts) are
    // outside the sync window [new Date(0), Ts] so they aren't pulled. The client
    // delta (note-A stale, note-C) is pushed; LWW keeps server's note-A (Tn>Ts).
    // note-C is a new record so the server accepts it.
    await waitFor(() => expect(result.current.syncing).toBe(false));
    expect(result.current.lastSynced).toBe(Ts.toISOString());
    expect(await settings.get('lastSynced')).toBe(Ts.toISOString());

    // Server: 3 records — note-A (authoritative), note-B (server-only), note-C (pushed by auto-sync)
    expect(serverNotes._db.size).toBe(3);
    const serverNoteAPre = serverNotes._db.get('note-A')!;
    expect(serverNoteAPre.title).toBe('Server Authoritative');
    expect(serverNoteAPre.body).toEqual(mockEncrypt('server body'));
    expect(serverNoteAPre.updatedAt).toEqual(Tn);
    expect(serverNoteAPre.createdAt).toEqual(Tn);
    expect(serverNoteAPre.deleted).toBe(false);
    const serverNoteBPre = serverNotes._db.get('note-B')!;
    expect(serverNoteBPre.title).toBe('Server Only');
    expect(serverNoteBPre.body).toBeUndefined();
    expect(serverNoteBPre.updatedAt).toEqual(Tn);

    // Enc client: 2 records — note-A already overwritten by auto-sync (server wins LWW),
    // note-C still local. The auto-sync pushed both to server and received note-A back
    // (server sets syncedAt=Ts on conflict resolution, which falls within window [0, Ts]).
    await waitFor(() => expect(result.current.notes).toHaveLength(2));
    const preNoteA = result.current.notes!.find((n) => n.id === 'note-A')!;
    expect(preNoteA.title).toBe('Server Authoritative');
    expect(preNoteA.body).toBe('server body'); // server body, decrypted
    expect(preNoteA.updatedAt).toEqual(Tn);
    expect(preNoteA.deleted).toBe(false);
    const preNoteC = result.current.notes!.find((n) => n.id === 'note-C')!;
    expect(preNoteC.title).toBe('Client Only');
    expect(preNoteC.body).toBeUndefined(); // no body set
    expect(preNoteC.updatedAt).toEqual(Ts);

    // Raw client: 2 records — note-A has server ciphertext (auto-sync already won LWW)
    const rawAllNotesPre = await rawStore.table.notes.findMany();
    expect(rawAllNotesPre).toHaveLength(2);
    const rawNoteAPre = rawAllNotesPre.find((n) => n.id === 'note-A')!;
    expect(rawNoteAPre.title).toBe('Server Authoritative');
    expect(rawNoteAPre.body).toEqual(mockEncrypt('server body')); // server ciphertext
    expect(rawNoteAPre.body).not.toEqual(mockEncrypt('stale body')); // stale replaced
    expect(rawNoteAPre.updatedAt).toEqual(Tn);
    const rawNoteCPre = rawAllNotesPre.find((n) => n.id === 'note-C')!;
    expect(rawNoteCPre.title).toBe('Client Only');
    expect(rawNoteCPre.body).toBeUndefined();
    expect(rawNoteCPre.updatedAt).toEqual(Ts);

    // ── Explicit sync at Tsync ────────────────────────────────────────────────
    // Auto-sync already pushed note-A/note-C and applied LWW. This incremental sync
    // (from=Ts, to=Tsync) has an empty client delta and pulls note-B from server
    // (Tn ∈ [Ts, Tsync]) plus any records whose syncedAt=Ts falls in the window.
    vi.setSystemTime(Tsync);
    await act(async () => {
      await result.current.doSync();
    });

    // ── Post-sync storage state ────────────────────────────────────────────────

    // Hook state: idle, lastSynced set to Tsync
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBe(Tsync.toISOString());

    // Settings table persisted
    await waitFor(async () => {
      expect(await settings.get('lastSynced')).toBe(Tsync.toISOString());
    });

    // Enc client: 3 records — note-A refreshed, note-B added, note-C kept
    await waitFor(() => expect(result.current.notes).toHaveLength(3));

    const postNoteA = result.current.notes!.find((n) => n.id === 'note-A')!;
    expect(postNoteA.title).toBe('Server Authoritative'); // server's title, not stale
    expect(postNoteA.body).toBe('server body'); // server body, decrypted correctly
    expect(postNoteA.updatedAt).toEqual(Tn); // server's timestamp
    expect(postNoteA.deleted).toBe(false);

    const postNoteB = result.current.notes!.find((n) => n.id === 'note-B')!;
    expect(postNoteB.title).toBe('Server Only');
    expect(postNoteB.body).toBeUndefined();
    expect(postNoteB.updatedAt).toEqual(Tn);

    const postNoteC = result.current.notes!.find((n) => n.id === 'note-C')!;
    expect(postNoteC.title).toBe('Client Only'); // still present, client's data kept
    expect(postNoteC.body).toBeUndefined();
    expect(postNoteC.updatedAt).toEqual(Ts); // original timestamp preserved

    // Raw client: 3 records — note-A has server ciphertext (not stale)
    const rawAllNotesPost = await rawStore.table.notes.findMany();
    expect(rawAllNotesPost).toHaveLength(3);

    const rawNoteAPost = rawAllNotesPost.find((n) => n.id === 'note-A')!;
    expect(rawNoteAPost.title).toBe('Server Authoritative');
    expect(rawNoteAPost.body).toEqual(mockEncrypt('server body')); // server ciphertext
    expect(rawNoteAPost.body).not.toEqual(mockEncrypt('stale body')); // stale ciphertext replaced
    expect(rawNoteAPost.updatedAt).toEqual(Tn);

    const rawNoteBPost = rawAllNotesPost.find((n) => n.id === 'note-B')!;
    expect(rawNoteBPost.title).toBe('Server Only');
    expect(rawNoteBPost.body).toBeUndefined();
    expect(rawNoteBPost.updatedAt).toEqual(Tn);

    const rawNoteCPost = rawAllNotesPost.find((n) => n.id === 'note-C')!;
    expect(rawNoteCPost.title).toBe('Client Only');
    expect(rawNoteCPost.body).toBeUndefined();
    expect(rawNoteCPost.updatedAt).toEqual(Ts); // client's original timestamp

    // Server: 3 records — note-A and note-B unchanged, note-C accepted from client
    expect(serverNotes._db.size).toBe(3);

    const serverNoteAPost = serverNotes._db.get('note-A')!;
    expect(serverNoteAPost.title).toBe('Server Authoritative');
    expect(serverNoteAPost.body).toEqual(mockEncrypt('server body'));
    expect(serverNoteAPost.updatedAt).toEqual(Tn); // unchanged — server won LWW
    expect(serverNoteAPost.deleted).toBe(false);

    const serverNoteBPost = serverNotes._db.get('note-B')!;
    expect(serverNoteBPost.title).toBe('Server Only');
    expect(serverNoteBPost.updatedAt).toEqual(Tn); // unchanged

    const serverNoteCPost = serverNotes._db.get('note-C')!;
    expect(serverNoteCPost.title).toBe('Client Only'); // accepted from client
    expect(serverNoteCPost.body).toBeUndefined();
    expect(serverNoteCPost.updatedAt).toEqual(Ts); // client's timestamp preserved on server
  });

  // ─── Test A: Fetcher throws ───────────────────────────────────────────────

  it('Test A — fetcher throws: syncState goes offline, syncing resets, lastSynced not advanced', async () => {
    const settings = rawStore.settings;

    const fetcher = async (): Promise<{
      data: Record<string, SyncableMeta[]>;
      hasMore: boolean;
    }> => {
      throw new Error('network error');
    };

    const { result } = renderHook(
      () => {
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
          syncState,
        } = useSync({
          store: { notes: raw.table.notes },
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0, // disable auto-refresh so the backoff timer doesn't fire
        });
        const enc = useStore();
        const notes = useLiveQuery(() => enc.table.notes.findMany());
        return { doSync, syncing, lastSynced, syncState, notes, raw };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Auto-sync fires immediately on mount; wait for it to fail → offline
    await waitFor(() => expect(result.current.syncing).toBe(false));
    expect(result.current.lastSynced).toBeUndefined();
    expect(result.current.syncState).toBe('offline');

    // A second sync attempt also fails — verifies offline persists and syncing resets
    await act(async () => {
      await result.current.doSync();
    });

    expect(result.current.syncState).toBe('offline');
    // syncing resets even after error (finally block)
    expect(result.current.syncing).toBe(false);
    // lastSynced not advanced
    expect(result.current.lastSynced).toBeUndefined();
    // settings not written
    expect(await settings.get('lastSynced')).toBeUndefined();
    // client store untouched
    await waitFor(() => expect(result.current.notes).toHaveLength(0));
  });

  // ─── Test B: Soft-delete propagation client → server ─────────────────────

  it('Test B — soft-deleted record propagates from client to server', async () => {
    // Insert a note on client at T1
    await encStore.table.notes.insert({
      id: 'note-del',
      title: 'To Delete',
      updatedAt: new Date(),
      createdAt: new Date(),
      deleted: false,
    });

    // Soft-delete it at T2 via rawStore to set exact timestamp
    vi.setSystemTime(T2);
    await rawStore.table.notes.upsertMany(
      [
        {
          id: 'note-del',
          title: 'To Delete',
          updatedAt: T2,
          createdAt: T1,
          deleted: true,
        },
      ],
      { sync: true },
    );

    const fetcher = makeThreeTableFetcher(serverNotes, serverTags, serverItems);

    const { result } = renderHook(
      () => {
        const store = useStore();
        const raw = useRawStore();
        const { sync: doSync, syncing } = useSync({
          store: {
            notes: raw.table.notes,
            tags: raw.table.tags,
            items: raw.table.items,
          },
          fetcher,
          defaultFrom: new Date(0),
        });
        const notes = useLiveQuery(() => store.table.notes.findMany());
        return { doSync, syncing, notes, raw };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Before explicit sync: liveQuery excludes soft-deleted rows
    await waitFor(() => expect(result.current.notes).toHaveLength(0));

    // Verify raw store still has the record with deleted=true
    const rawBefore = await rawStore.table.notes.findMany({ deleted: true });
    expect(rawBefore).toHaveLength(1);
    expect(rawBefore[0]!.id).toBe('note-del');
    expect(rawBefore[0]!.deleted).toBe(true);

    // Wait for auto-sync to complete: note-del (deleted=true) was pushed to server
    await waitFor(() => expect(result.current.syncing).toBe(false));
    expect(serverNotes._db.size).toBe(1);

    // Sync at T3
    vi.setSystemTime(T3);
    await act(async () => {
      await result.current.doSync();
    });

    // Server received the soft-deleted record
    expect(serverNotes._db.size).toBe(1);
    const serverDeleted = serverNotes._db.get('note-del')!;
    expect(serverDeleted.deleted).toBe(true);
    expect(serverDeleted.updatedAt).toEqual(T2);

    // Client liveQuery still shows 0 visible notes
    expect(result.current.notes).toHaveLength(0);

    // Raw client still has the record with deleted=true
    const rawAfter = await rawStore.table.notes.findMany({ deleted: true });
    expect(rawAfter).toHaveLength(1);
    expect(rawAfter[0]!.deleted).toBe(true);
  });

  // ─── Test C: Soft-delete propagation server → client ─────────────────────

  it('Test C — server-deleted record propagates to client on next sync', async () => {
    // Insert note-E on client and sync it to server at T2
    await encStore.table.notes.insert({
      id: 'note-E',
      title: 'Note E',
      updatedAt: new Date(),
      createdAt: new Date(),
      deleted: false,
    });

    const fetcher = makeThreeTableFetcher(serverNotes, serverTags, serverItems);

    const { result } = renderHook(
      () => {
        const store = useStore();
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
        } = useSync({
          store: {
            notes: raw.table.notes,
            tags: raw.table.tags,
            items: raw.table.items,
          },
          fetcher,
          defaultFrom: new Date(0),
        });
        const notes = useLiveQuery(() => store.table.notes.findMany());
        return { doSync, syncing, lastSynced, notes, raw };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Wait for auto-sync on mount to complete (fires at T1, pushes note-E to server)
    await waitFor(() => expect(result.current.syncing).toBe(false));

    // First explicit sync at T2: incremental from T1
    vi.setSystemTime(T2);
    await act(async () => {
      await result.current.doSync();
    });
    expect(result.current.lastSynced).toBe(T2.toISOString());
    expect(serverNotes._db.size).toBe(1);
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    // Server soft-deletes note-E at T3
    const serverNoteE = serverNotes._db.get('note-E')!;
    serverNotes._db.set('note-E', {
      ...serverNoteE,
      deleted: true,
      updatedAt: T3,
    });

    // Server state: note-E is deleted
    expect(serverNotes._db.get('note-E')!.deleted).toBe(true);
    expect(serverNotes._db.get('note-E')!.updatedAt).toEqual(T3);

    // Second sync at T4: client pulls the deletion
    vi.setSystemTime(T4);
    await act(async () => {
      await result.current.doSync();
    });
    expect(result.current.lastSynced).toBe(T4.toISOString());

    // Client liveQuery no longer shows note-E (soft-deleted rows excluded)
    await waitFor(() => expect(result.current.notes).toHaveLength(0));

    // Raw client holds note-E with deleted=true
    const rawAfter = await rawStore.table.notes.findMany({ deleted: true });
    expect(rawAfter).toHaveLength(1);
    expect(rawAfter[0]!.id).toBe('note-E');
    expect(rawAfter[0]!.deleted).toBe(true);
    expect(rawAfter[0]!.updatedAt).toEqual(T3);

    // Server note-E unchanged
    expect(serverNotes._db.get('note-E')!.deleted).toBe(true);
    expect(serverNotes._db.get('note-E')!.updatedAt).toEqual(T3);
  });

  // ─── Test D: LWW tie — client wins (offline-first) ───────────────────────

  it('Test D — LWW tie: client wins when updatedAt timestamps are equal (offline-first)', async () => {
    const settings = rawStore.settings;

    // Server has note-F at T1
    serverNotes._db.set('note-F', {
      id: 'note-F',
      title: 'Server Version',
      updatedAt: T1,
      createdAt: T1,
      deleted: false,
    });

    // Client has note-F at T1 (same timestamp, different content)
    await rawStore.table.notes.upsertMany(
      [
        {
          id: 'note-F',
          title: 'Client Version',
          updatedAt: T1,
          createdAt: T1,
          deleted: false,
        },
      ],
      { sync: true },
    );

    const fetcher = makeThreeTableFetcher(serverNotes, serverTags, serverItems);

    const { result } = renderHook(
      () => {
        const store = useStore();
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
        } = useSync({
          store: {
            notes: raw.table.notes,
            tags: raw.table.tags,
            items: raw.table.items,
          },
          fetcher,
          defaultFrom: new Date(0),
        });
        const notes = useLiveQuery(() => store.table.notes.findMany());
        return { doSync, syncing, lastSynced, notes, raw };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Pre-sync: client has 'Client Version'
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(result.current.notes![0]!.title).toBe('Client Version');

    // Sync at T2 — client delta includes note-F at T1; server also has note-F at T1 (tie)
    vi.setSystemTime(T2);
    await act(async () => {
      await result.current.doSync();
    });

    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBe(T2.toISOString());
    await waitFor(async () => {
      expect(await settings.get('lastSynced')).toBe(T2.toISOString());
    });

    // Client wins the tie — 'Client Version' persists
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(result.current.notes![0]!.title).toBe('Client Version');
    expect(result.current.notes![0]!.updatedAt).toEqual(T1);

    // Server accepted the client version
    expect(serverNotes._db.get('note-F')!.title).toBe('Client Version');
    expect(serverNotes._db.get('note-F')!.updatedAt).toEqual(T1);

    // Raw client: note-F with original timestamp
    const rawAllNotes = await result.current.raw.table.notes.findMany();
    expect(rawAllNotes).toHaveLength(1);
    expect(rawAllNotes[0]!.title).toBe('Client Version');
    expect(rawAllNotes[0]!.updatedAt).toEqual(T1);
  });

  // ─── Test E: Concurrent sync — second call is dropped ────────────────────

  it('Test E — concurrent sync: second doSync() call is dropped while first is in-flight', async () => {
    const fetcherSpy = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () => {
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
        } = useSync({
          store: { notes: raw.table.notes },
          fetcher: fetcherSpy,
          defaultFrom: new Date(0),
        });
        return { doSync, syncing, lastSynced };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Wait for auto-sync on mount to complete, then clear so the concurrent-guard test is isolated
    await waitFor(() => expect(result.current.syncing).toBe(false));
    fetcherSpy.mockClear();

    // Both calls happen in the same synchronous context before any async work.
    // The first call sets syncingRef.current = true synchronously; the second
    // call sees it and returns immediately (never reaches fetcherSpy).
    await act(async () => {
      const p1 = result.current.doSync();
      result.current.doSync(); // dropped — syncingRef.current already true
      await p1;
    });

    // Fetcher called exactly once
    expect(fetcherSpy).toHaveBeenCalledTimes(1);
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBeDefined();
  });

  // ─── Test F: incremental sync uses lastSynced from the previous sync ─────────

  it('Test F — lastSynced loaded from DB on mount: incremental sync uses persisted value', async () => {
    // Server: note-G updatedAt after T1 (in the incremental window), no note-H
    // (note-H was removed — with auto-sync on mount at T1 any note at T1 or earlier
    //  lands on the client immediately, muddying the incremental-sync assertion)
    serverNotes._db.set('note-G', {
      id: 'note-G',
      title: 'In Window',
      updatedAt: T3,
      createdAt: T3,
      deleted: false,
    });

    const fetcherSpy = vi.fn(
      makeThreeTableFetcher(serverNotes, serverTags, serverItems),
    );

    const { result } = renderHook(
      () => {
        const store = useStore();
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
        } = useSync({
          store: {
            notes: raw.table.notes,
            tags: raw.table.tags,
            items: raw.table.items,
          },
          fetcher: fetcherSpy,
          defaultFrom: new Date(0),
        });
        const notes = useLiveQuery(() => store.table.notes.findMany());
        return { doSync, syncing, lastSynced, notes };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Auto-sync fires on mount at T1. note-G (T3 > T1) is outside the initial
    // window [new Date(0), T1] so it is NOT pulled. lastSynced is set to T1.
    await waitFor(() => expect(result.current.syncing).toBe(false));
    expect(result.current.lastSynced).toBe(T1.toISOString());
    fetcherSpy.mockClear();

    // Incremental sync at T4: uses lastSynced=T1 as `from`
    vi.setSystemTime(T4);
    await act(async () => {
      await result.current.doSync();
    });

    expect(result.current.lastSynced).toBe(T4.toISOString());

    // note-G (T3 ∈ (T1, T4]) arrives on client
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(result.current.notes![0]!.id).toBe('note-G');
    expect(result.current.notes![0]!.title).toBe('In Window');

    // Verify fetcher was called with from = T1 (lastSynced from auto-sync)
    const { from } = fetcherSpy.mock.calls[0]![0] as { from: Date };
    expect(from).toEqual(new Date(T1.toISOString()));
  });

  // ─── Test G: Paginated sync ───────────────────────────────────────────────

  it('Test G — paginated sync: server records exceeding pageSize are fetched in multiple pages', async () => {
    // Server has 5 notes, all at T1
    const T1a = new Date('2024-01-01T01:00:01Z');
    const T1b = new Date('2024-01-01T01:00:02Z');
    const T1c = new Date('2024-01-01T01:00:03Z');
    const T1d = new Date('2024-01-01T01:00:04Z');
    const T1e = new Date('2024-01-01T01:00:05Z');

    serverNotes._db.set('n1', {
      id: 'n1',
      title: 'Note 1',
      updatedAt: T1a,
      createdAt: T1a,
      deleted: false,
    });
    serverNotes._db.set('n2', {
      id: 'n2',
      title: 'Note 2',
      updatedAt: T1b,
      createdAt: T1b,
      deleted: false,
    });
    serverNotes._db.set('n3', {
      id: 'n3',
      title: 'Note 3',
      updatedAt: T1c,
      createdAt: T1c,
      deleted: false,
    });
    serverNotes._db.set('n4', {
      id: 'n4',
      title: 'Note 4',
      updatedAt: T1d,
      createdAt: T1d,
      deleted: false,
    });
    serverNotes._db.set('n5', {
      id: 'n5',
      title: 'Note 5',
      updatedAt: T1e,
      createdAt: T1e,
      deleted: false,
    });

    const fetcherSpy = vi.fn(
      makeThreeTableFetcher(serverNotes, serverTags, serverItems, 2),
    );

    const { result } = renderHook(
      () => {
        const store = useStore();
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          lastSynced,
        } = useSync({
          store: {
            notes: raw.table.notes,
            tags: raw.table.tags,
            items: raw.table.items,
          },
          fetcher: fetcherSpy,
          defaultFrom: new Date(0),
        });
        const notes = useLiveQuery(() => store.table.notes.findMany());
        return { doSync, syncing, lastSynced, notes };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Wait for auto-sync on mount to complete (T1 window: all 5 notes are at T1+Ns so outside [0,T1])
    await waitFor(() => expect(result.current.syncing).toBe(false));
    fetcherSpy.mockClear();

    vi.setSystemTime(T2);
    await act(async () => {
      await result.current.doSync();
    });

    // All 5 notes arrived on client (3 pages: [n1,n2], [n3,n4], [n5])
    await waitFor(() => expect(result.current.notes).toHaveLength(5));

    // Fetcher called 3 times (pages 0, 2, 4) — auto-sync calls cleared above
    expect(fetcherSpy).toHaveBeenCalledTimes(3);
    expect(
      (fetcherSpy.mock.calls[0]![0] as { pageOffset: number }).pageOffset,
    ).toBe(0); // pageOffset = 0
    expect(
      (fetcherSpy.mock.calls[1]![0] as { pageOffset: number }).pageOffset,
    ).toBe(2); // pageOffset = 2
    expect(
      (fetcherSpy.mock.calls[2]![0] as { pageOffset: number }).pageOffset,
    ).toBe(4); // pageOffset = 4

    // lastSynced set exactly once, after all pages
    expect(result.current.lastSynced).toBe(T2.toISOString());
    expect(result.current.syncing).toBe(false);

    // All 5 records present with correct titles
    const titles = result.current.notes!.map((n) => n.title).sort();
    expect(titles).toEqual(['Note 1', 'Note 2', 'Note 3', 'Note 4', 'Note 5']);
  });

  // ─── Test H: Disabled state ──────────────────────────────────────────────────

  it('Test H — syncState: sync() is a no-op when not online, resumes after re-enabling', async () => {
    const fetcherSpy = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () => {
        const raw = useRawStore();
        const {
          sync: doSync,
          syncing,
          syncState,
          setSyncState,
        } = useSync({
          store: { notes: raw.table.notes },
          fetcher: fetcherSpy,
          defaultFrom: new Date(0),
        });
        return { doSync, syncing, syncState, setSyncState };
      },
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store: encStore, rawStore, liveQuery }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    // Initially online
    expect(result.current.syncState).toBe('online');

    // Wait for auto-sync on mount to complete, then clear before testing disabled guard
    await waitFor(() => expect(result.current.syncing).toBe(false));
    fetcherSpy.mockClear();

    // Go disabled
    act(() => {
      result.current.setSyncState('disabled');
    });
    expect(result.current.syncState).toBe('disabled');

    // sync() while disabled is a no-op
    await act(async () => {
      await result.current.doSync();
    });
    expect(fetcherSpy).not.toHaveBeenCalled();
    expect(result.current.syncing).toBe(false);

    // Go back online — auto-sync fires immediately on the online transition
    act(() => {
      result.current.setSyncState('online');
    });
    expect(result.current.syncState).toBe('online');

    // The auto-sync triggered by going online runs; a concurrent doSync() is dropped
    await act(async () => {
      await result.current.doSync();
    });
    expect(fetcherSpy).toHaveBeenCalledTimes(1);
  });
});
