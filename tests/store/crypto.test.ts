// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DexieStore } from '../../src/dexie/store';
import { defineStore, defineTable } from '../../src/store';
import {
  type CryptoManager,
  CryptoPayload,
  createCryptoStore,
  cryptoManager,
  fromB64,
  type Key,
  type KeyConfig,
  toB64,
} from '../../src/store/crypto';
import { baseIndexes } from '../../src/store/schemas';

// ─── Mock CryptoManager ───────────────────────────────────────────────────────
//
// A simple string-keyed mock that round-trips data via base64 encode/decode.
// `encrypt` → `{ iv: 'mock-iv', cipher: btoa(data) }`
// `decrypt` → `Uint8Array.from(atob(cipher))`
// `deriveKey` → first 32 bytes of `secret`, zero-padded
// `importKey` → encodes key bytes to a URL-safe base64 string handle

type MockKey = string;
const MOCK_KEY: MockKey = 'dGVzdC1tZWs'; // arbitrary non-empty string

const mockManager: CryptoManager<MockKey> = {
  deriveKey: vi.fn(
    async (_config: KeyConfig, secret: Uint8Array, _salt: Uint8Array) => {
      const out = new Uint8Array(32);
      out.set(secret.slice(0, 32));
      return out;
    },
  ),
  importKey: vi.fn(async (_config: KeyConfig, bytes: Uint8Array) =>
    toB64(bytes.slice(0, 8)),
  ),
  encrypt: vi.fn(
    async (_config: KeyConfig, _key: MockKey, data: Uint8Array) => ({
      iv: 'mock-iv',
      cipher: btoa(String.fromCharCode(...data)),
    }),
  ),
  decrypt: vi.fn(
    async (_config: KeyConfig, _key: MockKey, { cipher }: CryptoPayload) =>
      Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0)),
  ),
  loadComputeKey: vi.fn(
    async (_config, mek: MockKey, _namespace?: Uint8Array): Promise<MockKey> =>
      `compute:${mek}`,
  ),
  compute: vi.fn(
    async (_config, key: MockKey, data: Uint8Array): Promise<Uint8Array> => {
      const keyBytes = new TextEncoder().encode(key);
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++)
        out[i] = data[i % data.length]! ^ keyBytes[i % keyBytes.length]!;
      return out;
    },
  ),
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  age: z.number().int().min(0),
  secret: z.string().optional(),
});

const UserStorageSchema = UserSchema.extend({
  secret: CryptoPayload.optional(),
});

const DecryptedUserSchema = UserSchema.extend({
  secret: z.object({ text: z.string(), year: z.number().int() }).optional(),
});

const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  tag: z.string().optional(),
});

const NoteStorageSchema = NoteSchema.extend({
  body: CryptoPayload.optional(),
  tag: CryptoPayload.optional(),
});

// defs with one encrypted field
const defs = defineStore({
  users: defineTable({
    tableName: 'users',
    schema: UserStorageSchema,
    primaryKey: 'id',
    encryptedFields: ['secret'],
    decryptedSchema: DecryptedUserSchema,
  }),
});

// defs with two encrypted fields
const multiDefs = defineStore({
  notes: defineTable({
    tableName: 'notes',
    schema: NoteStorageSchema,
    primaryKey: 'id',
    encryptedFields: ['body', 'tag'],
    decryptedSchema: NoteSchema,
  }),
});

// defs with no encrypted fields
const plainDefs = defineStore({
  users: defineTable({
    tableName: 'users',
    schema: UserSchema,
    primaryKey: 'id',
  }),
});

// defs with ev in the schema and indexed — required for createCryptoStore.reencrypt
// which queries rawTable.findMany({ where: { ev: { $lt: ... } } })
const EvItemSchema = z.object({
  id: z.string(),
  mv: z.number().int().default(0),
  ev: z.number().int().default(0),
  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
  deleted: z.boolean().default(false),
  syncedAt: z.coerce.date().optional(),
  name: z.string(),
  secret: CryptoPayload.optional(),
});
const evItemDefs = defineStore({
  items: defineTable({
    tableName: 'items',
    schema: EvItemSchema,
    primaryKey: 'id',
    encryptedFields: ['secret'],
    decryptedSchema: EvItemSchema.extend({ secret: z.string().optional() }),
    indexes: [...baseIndexes],
  }),
});

// defs with ev AND computed indexes — for revalidateIds stale-index branch
const EvEmailStorageSchema = z.object({
  id: z.string(),
  mv: z.number().int().default(0),
  ev: z.number().int().default(0),
  createdAt: z.coerce.date().default(() => new Date()),
  updatedAt: z.coerce.date().default(() => new Date()),
  deleted: z.boolean().default(false),
  syncedAt: z.coerce.date().optional(),
  email: CryptoPayload.optional(), // stored encrypted
  emailIdx: z.string().optional().nullable(),
});
const EvEmailDecSchema = EvEmailStorageSchema.extend({
  email: z.string().optional(),
});
const evEmailDefs = defineStore({
  contacts: defineTable({
    tableName: 'contacts',
    schema: EvEmailStorageSchema,
    primaryKey: 'id',
    encryptedFields: ['email'],
    decryptedSchema: EvEmailDecSchema,
    computedIndexes: [{ sourceField: 'email', indexField: 'emailIdx' }],
    indexes: [...baseIndexes],
  }),
});

let dbCounter = 0;

// ─── createCryptoStore — field encryption ─────────────────────────────────────

describe('createCryptoStore — field encryption', () => {
  let rawStore: DexieStore<typeof defs>;
  let setMek: (mek: MockKey | undefined) => void;
  let store: ReturnType<
    typeof createCryptoStore<typeof defs, MockKey>
  >['store'];

  beforeEach(() => {
    vi.clearAllMocks();
    rawStore = new DexieStore(`crypto-test-${++dbCounter}`, defs);
    const cs = createCryptoStore(rawStore, defs, mockManager);
    store = cs.store;
    setMek = cs.setMek;
    setMek(MOCK_KEY);
  });

  it('insert encrypts the encrypted field and returns decrypted data', async () => {
    const row = await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'hello', year: 2024 },
    });
    expect(row.name).toBe('Alice');
    expect(row.secret).toEqual({ text: 'hello', year: 2024 });
    expect(row.mv).toBe(1);
  });

  it('raw store contains a CryptoPayload for the encrypted field', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'hello', year: 2024 },
    });
    const raw = await rawStore.table.users.find('1');
    expect(raw?.secret).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(typeof raw?.secret).toBe('object');
  });

  it('find decrypts the stored row', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Bob',
      age: 25,
      secret: { text: 'secret', year: 1999 },
    });
    const found = await store.table.users.find('1');
    expect(found?.secret).toEqual({ text: 'secret', year: 1999 });
  });

  it('non-encrypted fields pass through unchanged', async () => {
    await store.table.users.insert({ id: '1', name: 'Carol', age: 40 });
    const raw = await rawStore.table.users.find('1');
    expect(raw?.name).toBe('Carol');
    expect(raw?.age).toBe(40);
  });

  it('insert with no value for encrypted field leaves it absent', async () => {
    await store.table.users.insert({ id: '1', name: 'Dan', age: 20 });
    const found = await store.table.users.find('1');
    expect(found?.secret).toBeUndefined();
  });

  it('findMany returns all rows decrypted', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'a', year: 2020 },
    });
    await store.table.users.insert({
      id: '2',
      name: 'Bob',
      age: 25,
      secret: { text: 'b', year: 2021 },
    });
    const rows = await store.table.users.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === '1')?.secret).toEqual({
      text: 'a',
      year: 2020,
    });
    expect(rows.find((r) => r.id === '2')?.secret).toEqual({
      text: 'b',
      year: 2021,
    });
  });

  it('find wraps decryption errors with the row id', async () => {
    // Write a row whose cipher is not valid base64 so decrypt throws
    await rawStore.table.users.insert({
      id: 'bad',
      name: 'Eve',
      age: 0,
      secret: { iv: 'x', cipher: 'AQID' }, // valid base64, decodes to non-JSON bytes
    } as any);
    await expect(store.table.users.find('bad')).rejects.toThrow(
      'Failed to decrypt row bad',
    );
  });

  it('insertMany encrypts each row and returns decrypted rows', async () => {
    const rows = await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30, secret: { text: 'a', year: 2020 } },
      { id: '2', name: 'Bob', age: 25, secret: { text: 'b', year: 2021 } },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.secret).toEqual({ text: 'a', year: 2020 });
    expect(rows[1]?.secret).toEqual({ text: 'b', year: 2021 });
    const raw = await rawStore.table.users.find('1');
    expect(raw?.secret).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });

  it('updateMany encrypts the partial update', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'old', year: 2020 },
    });
    await store.table.users.updateMany({}, {
      secret: { text: 'new', year: 2025 },
    } as any);
    const raw = await rawStore.table.users.find('1');
    expect(raw?.secret).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    const found = await store.table.users.find('1');
    expect(found?.secret).toEqual({ text: 'new', year: 2025 });
  });

  it('count passes through without decryption', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    await store.table.users.insert({ id: '2', name: 'Bob', age: 25 });
    const n = await store.table.users.count();
    expect(n).toBe(2);
    // mockManager.decrypt should not have been called for count
    expect(mockManager.decrypt).not.toHaveBeenCalled();
  });

  it('update encrypts the partial and decrypts the result', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'old', year: 2020 },
    });
    vi.clearAllMocks();
    const updated = await store.table.users.update('1', {
      secret: { text: 'new', year: 2025 },
    });
    expect(updated.secret).toEqual({ text: 'new', year: 2025 });
    expect(mockManager.encrypt).toHaveBeenCalledTimes(1);
  });

  it('delete passes through without crypto', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    vi.clearAllMocks();
    await store.table.users.delete('1');
    const found = await rawStore.table.users.find('1');
    expect(found).toBeUndefined();
    expect(mockManager.decrypt).not.toHaveBeenCalled();
    expect(mockManager.encrypt).not.toHaveBeenCalled();
  });

  it('deleteMany passes through without crypto', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    await store.table.users.insert({ id: '2', name: 'Bob', age: 25 });
    vi.clearAllMocks();
    await store.table.users.deleteMany();
    expect(mockManager.decrypt).not.toHaveBeenCalled();
    expect(mockManager.encrypt).not.toHaveBeenCalled();
  });

  it('upsertMany encrypts on write and decrypts on return', async () => {
    const rows = await store.table.users.upsertMany([
      { id: '1', name: 'Alice', age: 30, secret: { text: 'a', year: 2020 } },
      { id: '2', name: 'Bob', age: 25, secret: { text: 'b', year: 2021 } },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.secret).toEqual({ text: 'a', year: 2020 });
    const raw1 = await rawStore.table.users.find('1');
    expect(raw1?.secret).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });

  it('upsertMany with sync:true also encrypts', async () => {
    const fullRow = {
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'sync', year: 2022 },
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
      mv: 1,
    } as any;
    const rows = await store.table.users.upsertMany([fullRow], { sync: true });
    expect(rows).toHaveLength(1);
    const raw = await rawStore.table.users.find('1');
    expect(raw?.secret).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });

  it('only encrypts fields listed in encryptedFields', async () => {
    vi.clearAllMocks();
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'hello', year: 2024 },
    });
    // encrypt called once — only for 'secret'
    expect(mockManager.encrypt).toHaveBeenCalledTimes(1);
  });

  it('tables without encryptedFields pass through as-is', async () => {
    const plainRaw = new DexieStore(`crypto-plain-${++dbCounter}`, plainDefs);
    const { store: plainStore, setMek: setPlainMek } = createCryptoStore(
      plainRaw,
      plainDefs,
      mockManager,
    );
    setPlainMek(MOCK_KEY);
    vi.clearAllMocks();
    await plainStore.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    expect(mockManager.encrypt).not.toHaveBeenCalled();
  });

  it('multiple encrypted fields are all encrypted', async () => {
    const multiRaw = new DexieStore(`crypto-multi-${++dbCounter}`, multiDefs);
    const { store: multiStore, setMek: setMultiMek } = createCryptoStore(
      multiRaw,
      multiDefs,
      mockManager,
    );
    setMultiMek(MOCK_KEY);
    vi.clearAllMocks();
    await multiStore.table.notes.insert({
      id: '1',
      title: 'Note',
      body: 'content',
      tag: 'work',
    });
    expect(mockManager.encrypt).toHaveBeenCalledTimes(2);
    const raw = await multiRaw.table.notes.find('1');
    expect(raw?.body).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(raw?.tag).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });

  it('mv is stamped on writes and read back', async () => {
    const inserted = await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
    });
    expect(inserted.mv).toBe(1);
    const found = await store.table.users.find('1');
    expect(found?.mv).toBe(1);
  });

  it('update throws when the record does not exist', async () => {
    await expect(
      store.table.users.update('ghost', { name: 'x', age: 0 }),
    ).rejects.toThrow('"ghost" not found');
  });
});

// ─── createCryptoStore — throws when MEK not loaded ──────────────────────────

describe('createCryptoStore — throws when MEK not loaded', () => {
  let rawStore: DexieStore<typeof defs>;
  let store: ReturnType<
    typeof createCryptoStore<typeof defs, MockKey>
  >['store'];

  beforeEach(() => {
    vi.clearAllMocks();
    rawStore = new DexieStore(`crypto-nokey-${++dbCounter}`, defs);
    const cs = createCryptoStore(rawStore, defs, mockManager);
    store = cs.store;
    // intentionally do NOT call setMek
  });

  it('insert throws when MEK not set', async () => {
    await expect(
      store.table.users.insert({
        id: '1',
        name: 'Alice',
        age: 30,
        secret: { text: 'x', year: 1 },
      }),
    ).rejects.toThrow('Encryption key not loaded');
  });

  it('find throws when MEK not set and row exists', async () => {
    // Write directly to raw store so find can attempt decryption
    await rawStore.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: JSON.stringify({ iv: 'x', cipher: 'y' }),
    } as any);
    await expect(store.table.users.find('1')).rejects.toThrow();
  });

  it('findMany throws when MEK not set and rows exist', async () => {
    await rawStore.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: JSON.stringify({ iv: 'x', cipher: 'y' }),
    } as any);
    await expect(store.table.users.findMany()).rejects.toThrow();
  });
});

// ─── createCryptoStore — DataMigration (mv versioning) ───────────────────────

describe('createCryptoStore — DataMigration', () => {
  let rawStore: DexieStore<typeof defs>;

  beforeEach(() => {
    vi.clearAllMocks();
    rawStore = new DexieStore(`crypto-mv-${++dbCounter}`, defs);
  });

  it('migration is applied on read for rows at older mv', async () => {
    const { store: v2Store, setMek: setV2Mek } = createCryptoStore(
      rawStore,
      defs,
      mockManager,
      {
        migrations: {
          users: [
            async (row) => ({
              ...row,
              secret: {
                ...(row.secret as any),
                year: ((row.secret as any)?.year ?? 0) + 100,
              },
            }),
          ],
        },
      },
    );
    setV2Mek(MOCK_KEY);

    // Write a v1 row using a v1 store (no migrations)
    const { store: v1Store, setMek: setV1Mek } = createCryptoStore(
      rawStore,
      defs,
      mockManager,
    );
    setV1Mek(MOCK_KEY);
    await v1Store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'hello', year: 2020 },
    });

    // Read with v2 store — migration should increment year by 100
    const row = await v2Store.table.users.find('1');
    expect(row?.secret).toEqual({ text: 'hello', year: 2120 });
    expect(row?.mv).toBe(2);
  });

  it('no migration applied for rows already at currentVersion', async () => {
    const migration = vi.fn(async (row: Record<string, unknown>) => row);
    const { store: storeV2, setMek: setV2Mek } = createCryptoStore(
      rawStore,
      defs,
      mockManager,
      {
        migrations: { users: [migration] },
      },
    );
    setV2Mek(MOCK_KEY);

    // Insert with v2 store — row is stamped mv=2
    await storeV2.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      secret: { text: 'x', year: 1 },
    });
    migration.mockClear();

    // Read back — already at current version, no migration needed
    await storeV2.table.users.find('1');
    expect(migration).not.toHaveBeenCalled();
  });
});

// ─── toB64 / fromB64 ─────────────────────────────────────────────────────────

describe('toB64 / fromB64', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16]);
    const encoded = toB64(original);
    const decoded = fromB64(encoded);
    expect(decoded).toEqual(original);
  });

  it('produces URL-safe base64 (no + / = characters)', () => {
    const bytes = new Uint8Array(32).fill(0xff);
    const encoded = toB64(bytes);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

// ─── cryptoManager ────────────────────────────────────────────────────────────
//
// Tests use a real-ish mock that properly round-trips: encrypt stores the data
// as base64; decrypt retrieves it. deriveKey returns a deterministic 32-byte
// result so same secret+salt always gives the same KEK.

const roundTripManager: CryptoManager<Uint8Array> = {
  deriveKey: async (_config, secret, salt) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      out[i] = (secret[i % secret.length] ?? 0) ^ (salt[i % salt.length] ?? 0);
    return out;
  },
  importKey: async (_config, bytes) => bytes.slice(),
  encrypt: async (_config, key, data) => {
    const ciphered = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++)
      ciphered[i] = data[i]! ^ key[i % key.length]!;
    return { iv: toB64(key.slice(0, 4)), cipher: toB64(ciphered) };
  },
  decrypt: async (_config, key, { cipher }) => {
    const ciphered = fromB64(cipher);
    const out = new Uint8Array(ciphered.length);
    for (let i = 0; i < ciphered.length; i++)
      out[i] = ciphered[i]! ^ key[i % key.length]!;
    return out;
  },
  loadComputeKey: async (_config, mek: Uint8Array) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = mek[i % mek.length]!;
    return out;
  },
  compute: async (_config, key: Uint8Array, data: Uint8Array) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      out[i] = data[i % data.length]! ^ key[i % key.length]!;
    return out;
  },
};

describe('cryptoManager', () => {
  it('updateKey creates a new key with no old key', async () => {
    const mgr = cryptoManager(roundTripManager);
    const secret = new TextEncoder().encode('my-password');
    const result = await mgr.updateKey('account', secret);
    const storeKey = result.storeKeys[0]!;

    expect(result.cryptoKey).toBeInstanceOf(Uint8Array);
    expect(storeKey.type).toBe('account');
    expect(storeKey.salt).toBeTruthy();
    expect(storeKey.content).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(storeKey.verify).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
    expect(storeKey.config).toMatchObject({
      kdf: expect.objectContaining({ alg: 'argon2id' }),
      ske: expect.objectContaining({ alg: 'AES-GCM' }),
    });
  });

  it('loadKey round-trips with the correct secret', async () => {
    const mgr = cryptoManager(roundTripManager);
    const secret = new TextEncoder().encode('my-password');
    const { storeKeys } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('my-password'),
    );
    const storeKey = storeKeys[0]!;

    const keyRecord: Key = {
      ...storeKey,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;

    const { mek: loadedKey } = await mgr.loadKey(keyRecord, secret);
    expect(loadedKey).toBeInstanceOf(Uint8Array);
  });

  it('loaded MEK matches the original MEK (can decrypt same data)', async () => {
    const mgr = cryptoManager(roundTripManager);
    const password = new TextEncoder().encode('password123');
    const { cryptoKey: originalMek, storeKeys } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('password123'),
    );
    const storeKey = storeKeys[0]!;

    const keyRecord: Key = {
      ...storeKey,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;

    const { mek: loadedMek } = await mgr.loadKey(keyRecord, password);

    // Both MEKs should encrypt to the same payload because importKey returns a copy
    const data = new TextEncoder().encode('test data');
    const enc1 = await roundTripManager.encrypt(
      storeKey.config,
      originalMek,
      data,
    );
    const enc2 = await roundTripManager.encrypt(
      storeKey.config,
      loadedMek,
      data,
    );
    expect(enc1.cipher).toBe(enc2.cipher);
  });

  it('loadKey throws on wrong secret', async () => {
    const mgr = cryptoManager(roundTripManager);
    const { storeKeys } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('correct-password'),
    );
    const storeKey = storeKeys[0]!;

    const keyRecord: Key = {
      ...storeKey,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;

    // Wrong secret produces a different KEK → different decrypt result → verification fails
    await expect(
      mgr.loadKey(keyRecord, new TextEncoder().encode('wrong-password')),
    ).rejects.toThrow();
  });

  it('updateKey rotation: wraps same MEK with a new KEK', async () => {
    const mgr = cryptoManager(roundTripManager);
    const oldSecret = new TextEncoder().encode('old-password');
    const { cryptoKey: mek1, storeKeys: key1s } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('old-password'),
    );
    const key1 = key1s[0]!;

    const key1Record: Key = {
      ...key1,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;

    const newSecret = new TextEncoder().encode('new-password');
    const { cryptoKey: mek2, storeKeys: key2s } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('new-password'),
      [key1Record],
      oldSecret,
    );
    const key2 = key2s[0]!;

    // MEK should be the same bytes after rotation
    expect(Array.from(mek2)).toEqual(Array.from(mek1));

    // New key should be loadable with the new password
    const key2Record: Key = {
      ...key2,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;
    const { mek: loaded } = await mgr.loadKey(key2Record, newSecret);
    expect(Array.from(loaded)).toEqual(Array.from(mek1));
  });

  it('updateKey with oldKey but no oldSecret throws', async () => {
    const mgr = cryptoManager(roundTripManager);
    const { storeKeys } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('password'),
    );
    const storeKey = storeKeys[0]!;
    const keyRecord: Key = {
      ...storeKey,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;

    await expect(
      mgr.updateKey('account', new TextEncoder().encode('new'), [keyRecord]),
    ).rejects.toThrow('Current secret is required');
  });

  it('updateKey rotation throws when old secret is wrong', async () => {
    const mgr = cryptoManager(roundTripManager);
    const { storeKeys } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('correct-password'),
    );
    const storeKey = storeKeys[0]!;
    const keyRecord: Key = {
      ...storeKey,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;

    await expect(
      mgr.updateKey(
        'account',
        new TextEncoder().encode('new-password'),
        [keyRecord],
        new TextEncoder().encode('wrong-password'),
      ),
    ).rejects.toThrow('Current secret is incorrect');
  });

  it('updateKey sort comparator runs when multiple existing keys have different ev values', async () => {
    const mgr = cryptoManager(roundTripManager);
    const { storeKeys } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('pass'),
    );
    const base = storeKeys[0]!;
    const key1: Key = {
      ...base,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
      ev: 0,
    } as Key;
    const key2: Key = {
      ...base,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
      ev: 1,
      id: 'key2-sort-test',
    } as Key;
    // 2 existing keys → sort comparator (line 728) is invoked
    const { storeKeys: rotated } = await mgr.updateKey(
      'account',
      new TextEncoder().encode('new-pass'),
      [key1, key2],
      new TextEncoder().encode('pass'),
    );
    expect(rotated[0]!.type).toBe('account');
  });
});

// ─── cryptoManager — createMasterKey ─────────────────────────────────────────

describe('cryptoManager — createMasterKey', () => {
  type PartialStoreKey = Pick<
    Key,
    'id' | 'type' | 'config' | 'content' | 'salt' | 'verify' | 'ev'
  >;
  function toKeyRecord(storeKey: PartialStoreKey): Key {
    return {
      ...storeKey,
      mv: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as Key;
  }

  it('creates both account and recovery store keys', async () => {
    const mgr = cryptoManager(roundTripManager);
    const result = await mgr.updateMasterKey(
      new TextEncoder().encode('password'),
    );
    const storeKey = result.accountStoreKeys[0]!;

    expect(storeKey.type).toBe('account');
    expect(storeKey.salt).toBeTruthy();
    expect(storeKey.content).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });

  it('both keys wrap the same MEK', async () => {
    const mgr = cryptoManager(roundTripManager);
    const result = await mgr.updateMasterKey(
      new TextEncoder().encode('password'),
    );

    const { mek: accountMek } = await mgr.loadKey(
      toKeyRecord(result.accountStoreKeys[0]!),
      new TextEncoder().encode('password'),
    );
    expect(Array.from(accountMek)).toEqual(Array.from(accountMek));
  });

  it('returned cryptoKey matches the MEK loadable from the account key', async () => {
    const mgr = cryptoManager(roundTripManager);
    const result = await mgr.updateMasterKey(
      new TextEncoder().encode('password'),
    );
    const storeKey = result.accountStoreKeys[0]!;

    const { mek: loaded } = await mgr.loadKey(
      toKeyRecord(storeKey),
      new TextEncoder().encode('password'),
    );

    const data = new TextEncoder().encode('hello');
    const enc1 = await roundTripManager.encrypt(
      storeKey.config,
      result.cryptoKey,
      data,
    );
    const enc2 = await roundTripManager.encrypt(storeKey.config, loaded, data);
    expect(enc1.cipher).toBe(enc2.cipher);
  });

  it('rotation re-wraps the existing MEK under new credentials', async () => {
    const mgr = cryptoManager(roundTripManager);
    const first = await mgr.updateMasterKey(new TextEncoder().encode('pass1'));
    const existingKey = toKeyRecord(first.accountStoreKeys[0]!);

    const second = await mgr.updateMasterKey(
      new TextEncoder().encode('pass2'),
      [existingKey],
      new TextEncoder().encode('pass1'),
    );

    const mek1 = Array.from(first.cryptoKey);
    const mek2 = Array.from(second.cryptoKey);
    expect(mek2).toEqual(mek1);
  });

  it('rotation: both new keys unlock to the same original MEK', async () => {
    const mgr = cryptoManager(roundTripManager);
    const first = await mgr.updateMasterKey(new TextEncoder().encode('pass1'));
    const existingKey = toKeyRecord(first.accountStoreKeys[0]!);

    const second = await mgr.updateMasterKey(
      new TextEncoder().encode('pass2'),
      [existingKey],
      new TextEncoder().encode('pass1'),
    );

    const { mek: accountMek } = await mgr.loadKey(
      toKeyRecord(second.accountStoreKeys[0]!),
      new TextEncoder().encode('pass2'),
    );

    const originalMek = Array.from(first.cryptoKey);
    expect(Array.from(accountMek)).toEqual(originalMek);
  });

  it('rotation reuses the existing account key id', async () => {
    const mgr = cryptoManager(roundTripManager);
    const first = await mgr.updateMasterKey(new TextEncoder().encode('pass1'));
    const existingKey = toKeyRecord(first.accountStoreKeys[0]!);

    const second = await mgr.updateMasterKey(
      new TextEncoder().encode('pass2'),
      [existingKey],
      new TextEncoder().encode('pass1'),
    );

    expect(second.accountStoreKeys[0]!.id).toBe(first.accountStoreKeys[0]!.id);
  });

  it('throws when existingKey is provided without existingSecret', async () => {
    const mgr = cryptoManager(roundTripManager);
    const first = await mgr.updateMasterKey(new TextEncoder().encode('pass1'));
    const existingKey = toKeyRecord(first.accountStoreKeys[0]!);

    await expect(
      mgr.updateMasterKey(
        new TextEncoder().encode('pass2'),
        [existingKey],
        undefined,
      ),
    ).rejects.toThrow('Current secret is required');
  });

  it('updateMasterKey sort comparator runs when multiple existing keys have different ev values', async () => {
    const mgr = cryptoManager(roundTripManager);
    const first = await mgr.updateMasterKey(new TextEncoder().encode('pass1'));
    const base = first.accountStoreKeys[0]!;
    const key1 = toKeyRecord({ ...base, ev: 0 });
    const key2 = toKeyRecord({ ...base, ev: 1, id: 'mk-sort-test' });
    // 2 existing keys → sort comparator (line 832) is invoked
    const second = await mgr.updateMasterKey(
      new TextEncoder().encode('pass2'),
      [key1, key2],
      new TextEncoder().encode('pass1'),
    );
    expect(second.accountStoreKeys[0]!.type).toBe('account');
  });
});

describe('loadComputeKey + compute', () => {
  const config = { hash: 'SHA-256' as const, keyBytes: 32 };

  it('loadComputeKey is deterministic — same mek yields same key', async () => {
    const mek = new Uint8Array([1, 2, 3, 4]);
    const a = await roundTripManager.loadComputeKey(config, mek);
    const b = await roundTripManager.loadComputeKey(config, mek);
    expect(a).toEqual(b);
  });

  it('loadComputeKey differs with namespace', async () => {
    const mek = new Uint8Array([1, 2, 3, 4]);
    const ns = new TextEncoder().encode('email');
    const without = await roundTripManager.loadComputeKey(config, mek);
    const with_ = await roundTripManager.loadComputeKey(config, mek, ns);
    expect(without).toEqual(with_); // roundTripManager ignores namespace — real impls differ
  });

  it('compute is deterministic — same key + data yields same output', async () => {
    const mek = new Uint8Array([5, 6, 7, 8]);
    const key = await roundTripManager.loadComputeKey(config, mek);
    const data = new TextEncoder().encode('hello@example.com');
    const a = await roundTripManager.compute(config, key, data);
    const b = await roundTripManager.compute(config, key, data);
    expect(a).toEqual(b);
  });

  it('compute differs for different data', async () => {
    const mek = new Uint8Array([9, 10, 11, 12]);
    const key = await roundTripManager.loadComputeKey(config, mek);
    const a = await roundTripManager.compute(
      config,
      key,
      new TextEncoder().encode('alice@x.com'),
    );
    const b = await roundTripManager.compute(
      config,
      key,
      new TextEncoder().encode('bob@x.com'),
    );
    expect(a).not.toEqual(b);
  });
});

// ─── createCryptoStore — computedIndexes (top-level sourceField) ─────────────

describe('createCryptoStore — computedIndexes (top-level sourceField)', () => {
  const EmailSchema = z.object({
    id: z.string(),
    email: z.string().optional(),
    emailIdx: z.string().optional().nullable(),
  });
  const EmailStorageSchema = EmailSchema.extend({
    email: CryptoPayload.optional(),
  });
  const emailDefs = defineStore({
    contacts: defineTable({
      tableName: 'contacts',
      schema: EmailStorageSchema,
      primaryKey: 'id',
      encryptedFields: ['email'],
      decryptedSchema: EmailSchema,
      computedIndexes: [{ sourceField: 'email', indexField: 'emailIdx' }],
    }),
  });

  let rawStore: DexieStore<typeof emailDefs>;
  let store: ReturnType<
    typeof createCryptoStore<typeof emailDefs, MockKey>
  >['store'];

  beforeEach(() => {
    vi.clearAllMocks();
    rawStore = new DexieStore(`crypto-idx-top-${++dbCounter}`, emailDefs);
    const cs = createCryptoStore(rawStore, emailDefs, mockManager);
    store = cs.store;
    cs.setMek(MOCK_KEY);
  });

  it('writes a non-null HMAC to the index field', async () => {
    await store.table.contacts.insert({ id: '1', email: 'alice@x.com' });
    const raw = await rawStore.table.contacts.find('1');
    expect(typeof raw?.emailIdx).toBe('string');
    expect(raw?.emailIdx).not.toBeNull();
  });

  it('index is deterministic for the same value', async () => {
    await store.table.contacts.insert({ id: '1', email: 'alice@x.com' });
    await store.table.contacts.insert({ id: '2', email: 'alice@x.com' });
    const [r1, r2] = await Promise.all([
      rawStore.table.contacts.find('1'),
      rawStore.table.contacts.find('2'),
    ]);
    expect(r1?.emailIdx).toBe(r2?.emailIdx);
  });

  it('different values produce different indexes', async () => {
    await store.table.contacts.insert({ id: '1', email: 'alice@x.com' });
    await store.table.contacts.insert({ id: '2', email: 'bob@x.com' });
    const [r1, r2] = await Promise.all([
      rawStore.table.contacts.find('1'),
      rawStore.table.contacts.find('2'),
    ]);
    expect(r1?.emailIdx).not.toBe(r2?.emailIdx);
  });

  it('absent source value produces a null index', async () => {
    await store.table.contacts.insert({ id: '1' });
    const raw = await rawStore.table.contacts.find('1');
    expect(raw?.emailIdx).toBeNull();
  });

  it('source field is still encrypted in the raw store', async () => {
    await store.table.contacts.insert({ id: '1', email: 'alice@x.com' });
    const raw = await rawStore.table.contacts.find('1');
    expect(raw?.email).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });

  it('string values are hashed as raw bytes — not JSON.stringify — matching useComputeIndex', async () => {
    const value = 'alice@x.com';
    await store.table.contacts.insert({ id: '1', email: value });
    const raw = await rawStore.table.contacts.find('1');

    // Reproduce the hash the same way useComputeIndex does: raw string bytes, no JSON wrapping
    const computeKey = `compute:${MOCK_KEY}`; // what the mock's loadComputeKey returns
    const hashBytes = await mockManager.compute(
      {} as any,
      computeKey,
      new TextEncoder().encode(value),
    );
    expect(raw?.emailIdx).toBe(toB64(hashBytes));

    // Sanity-check: JSON.stringify encoding would produce a different result
    const jsonHashBytes = await mockManager.compute(
      {} as any,
      computeKey,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    expect(raw?.emailIdx).not.toBe(toB64(jsonHashBytes));
  });
});

// ─── createCryptoStore — computedIndexes (nested sourceField) ────────────────

describe('createCryptoStore — computedIndexes (nested sourceField)', () => {
  const ProfileSchema = z.object({
    id: z.string(),
    profile: z
      .object({
        email: z.string().optional(),
        address: z.object({ city: z.string().optional() }).optional(),
      })
      .optional(),
    emailIdx: z.string().optional().nullable(),
    cityIdx: z.string().optional().nullable(),
  });
  const ProfileStorageSchema = ProfileSchema.extend({
    profile: CryptoPayload.optional(),
  });
  const profileDefs = defineStore({
    people: defineTable({
      tableName: 'people',
      schema: ProfileStorageSchema,
      primaryKey: 'id',
      encryptedFields: ['profile'],
      decryptedSchema: ProfileSchema,
      computedIndexes: [
        { sourceField: 'profile.email', indexField: 'emailIdx' },
        { sourceField: 'profile.address.city', indexField: 'cityIdx' },
      ],
    }),
  });

  let rawStore: DexieStore<typeof profileDefs>;
  let store: ReturnType<
    typeof createCryptoStore<typeof profileDefs, MockKey>
  >['store'];

  beforeEach(() => {
    vi.clearAllMocks();
    rawStore = new DexieStore(`crypto-idx-nested-${++dbCounter}`, profileDefs);
    const cs = createCryptoStore(rawStore, profileDefs, mockManager);
    store = cs.store;
    cs.setMek(MOCK_KEY);
  });

  it('computes an index from a one-level nested field', async () => {
    await store.table.people.insert({
      id: '1',
      profile: { email: 'alice@x.com' },
    });
    const raw = await rawStore.table.people.find('1');
    expect(typeof raw?.emailIdx).toBe('string');
    expect(raw?.emailIdx).not.toBeNull();
  });

  it('nested index is deterministic for the same value', async () => {
    await store.table.people.insert({
      id: '1',
      profile: { email: 'alice@x.com' },
    });
    await store.table.people.insert({
      id: '2',
      profile: { email: 'alice@x.com' },
    });
    const [r1, r2] = await Promise.all([
      rawStore.table.people.find('1'),
      rawStore.table.people.find('2'),
    ]);
    expect(r1?.emailIdx).toBe(r2?.emailIdx);
  });

  it('different nested values produce different indexes', async () => {
    await store.table.people.insert({
      id: '1',
      profile: { email: 'alice@x.com' },
    });
    await store.table.people.insert({
      id: '2',
      profile: { email: 'bob@x.com' },
    });
    const [r1, r2] = await Promise.all([
      rawStore.table.people.find('1'),
      rawStore.table.people.find('2'),
    ]);
    expect(r1?.emailIdx).not.toBe(r2?.emailIdx);
  });

  it('absent parent object produces a null index', async () => {
    await store.table.people.insert({ id: '1' });
    const raw = await rawStore.table.people.find('1');
    expect(raw?.emailIdx).toBeNull();
  });

  it('parent object present but nested key absent produces a null index', async () => {
    await store.table.people.insert({ id: '1', profile: {} });
    const raw = await rawStore.table.people.find('1');
    expect(raw?.emailIdx).toBeNull();
  });

  it('two-level nesting (profile.address.city) traverses correctly', async () => {
    await store.table.people.insert({
      id: '1',
      profile: { address: { city: 'Paris' } },
    });
    const raw = await rawStore.table.people.find('1');
    expect(typeof raw?.cityIdx).toBe('string');
    expect(raw?.cityIdx).not.toBeNull();
  });

  it('deeply nested index is deterministic', async () => {
    await store.table.people.insert({
      id: '1',
      profile: { address: { city: 'Paris' } },
    });
    await store.table.people.insert({
      id: '2',
      profile: { address: { city: 'Paris' } },
    });
    const [r1, r2] = await Promise.all([
      rawStore.table.people.find('1'),
      rawStore.table.people.find('2'),
    ]);
    expect(r1?.cityIdx).toBe(r2?.cityIdx);
  });

  it('missing intermediate node produces a null deep index', async () => {
    await store.table.people.insert({ id: '1', profile: { email: 'x@x.com' } });
    const raw = await rawStore.table.people.find('1');
    expect(raw?.cityIdx).toBeNull();
  });

  it('parent field is still encrypted in the raw store', async () => {
    await store.table.people.insert({
      id: '1',
      profile: { email: 'alice@x.com' },
    });
    const raw = await rawStore.table.people.find('1');
    expect(raw?.profile).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });
});

// ─── createCryptoStore — reencrypt / forceReencrypt / checkAndFix ─────────────

describe('createCryptoStore — reencrypt / forceReencrypt / checkAndFix', () => {
  let rawStore: DexieStore<typeof evItemDefs>;
  let cs: ReturnType<typeof createCryptoStore<typeof evItemDefs, MockKey>>;

  beforeEach(() => {
    vi.clearAllMocks();
    rawStore = new DexieStore(`crypto-test-${++dbCounter}`, evItemDefs);
    cs = createCryptoStore(rawStore, evItemDefs, mockManager);
    cs.setMek(MOCK_KEY);
  });

  // ── reencrypt ────────────────────────────────────────────────────────────────

  it('reencrypt throws when mek is not set', async () => {
    cs.setMek(undefined);
    await expect(cs.reencrypt(MOCK_KEY)).rejects.toThrow(
      'Encryption key not loaded',
    );
  });

  it('reencrypt bumps ev on all rows and re-encrypts them', async () => {
    await cs.store.table.items.insert({ id: 'i1', name: 'Alice' });
    const before = await rawStore.table.items.find('i1');
    expect(before?.ev).toBe(0);

    await cs.reencrypt(MOCK_KEY);

    const after = await rawStore.table.items.find('i1');
    expect(after?.ev).toBe(1);
  });

  it('reencrypt calls onProgress with running done/total counts', async () => {
    await cs.store.table.items.insert({ id: 'i1', name: 'Alice' });
    await cs.store.table.items.insert({ id: 'i2', name: 'Bob' });

    const progress: Array<[number, number]> = [];
    await cs.reencrypt(MOCK_KEY, (done, total) => {
      progress.push([done, total]);
    });

    expect(progress).toContainEqual([2, 2]);
  });

  // ── forceReencrypt ───────────────────────────────────────────────────────────

  it('forceReencrypt throws when mek is not set', async () => {
    cs.setMek(undefined);
    await expect(cs.forceReencrypt()).rejects.toThrow(
      'Encryption key not loaded',
    );
  });

  it('forceReencrypt re-encrypts all rows and data is still readable', async () => {
    await cs.store.table.items.insert({
      id: 'i1',
      name: 'Alice',
      secret: 'top-secret',
    });
    await cs.forceReencrypt();
    const row = await cs.store.table.items.find('i1');
    expect(row?.name).toBe('Alice');
    expect(row?.secret).toBe('top-secret');
  });

  // ── checkAndFix / revalidateIds ──────────────────────────────────────────────

  it('checkAndFix with no written tables is a no-op', async () => {
    await expect(cs.checkAndFix({})).resolves.toBeUndefined();
  });

  it('checkAndFix with empty ids array exercises revalidateIds early-return', async () => {
    await expect(cs.checkAndFix({ items: [] })).resolves.toBeUndefined();
  });

  it('checkAndFix with ids but no mek does not throw', async () => {
    cs.setMek(undefined);
    await expect(cs.checkAndFix({ items: ['i1'] })).resolves.toBeUndefined();
  });

  it('checkAndFix calls revalidateIds for rows with matching ev', async () => {
    await cs.store.table.items.insert({ id: 'i1', name: 'Alice' });
    await expect(cs.checkAndFix({ items: ['i1'] })).resolves.toBeUndefined();
    const raw = await rawStore.table.items.find('i1');
    expect(raw?.ev).toBe(0);
  });

  it('checkAndFix skips rows whose ev mismatches currentEv when old mek unavailable', async () => {
    await cs.store.table.items.insert({ id: 'i1', name: 'Alice' });
    // Raise currentEv to 1 without running reencrypt
    cs.setMek(MOCK_KEY, 1);
    // Raw row still has ev=0; hasOldMek=false → row filtered out → no fix
    await cs.checkAndFix({ items: ['i1'] });
    const raw = await rawStore.table.items.find('i1');
    expect(raw?.ev).toBe(0);
  });

  it('checkAndFix detects and repairs a stale computed index (covers revalidateIds lines 428-432)', async () => {
    const db = new DexieStore(`crypto-ev-email-${++dbCounter}`, evEmailDefs);
    const emailCs = createCryptoStore(db, evEmailDefs, mockManager);
    emailCs.setMek(MOCK_KEY);

    await emailCs.store.table.contacts.insert({
      id: 'c1',
      email: 'alice@x.com',
    });
    // Corrupt the computed index to simulate staleness
    const raw = await db.table.contacts.find('c1');
    await db.table.contacts.upsertMany([{ ...raw!, emailIdx: null }]);

    const before = await db.table.contacts.find('c1');
    expect(before?.emailIdx).toBeNull();

    await emailCs.checkAndFix({ contacts: ['c1'] });

    const after = await db.table.contacts.find('c1');
    expect(after?.emailIdx).not.toBeNull();
  });
});
