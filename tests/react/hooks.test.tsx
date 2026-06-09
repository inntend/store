// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { liveQuery } from 'dexie';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DexieStore } from '../../src/dexie/store';
import {
  createEncryptedStoreContext,
  createStoreContext,
} from '../../src/react/hooks';
import { defineStore, defineTable } from '../../src/store';
import {
  type CryptoManager,
  type CryptoPayload,
  createCryptoStore,
} from '../../src/store/crypto';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  age: z.number().int().min(0),
  content: z.string().optional(),
});

const DecryptedUserSchema = UserSchema.extend({
  content: z
    .object({
      text: z.string(),
      year: z.number().int(),
      timestamp: z.coerce.date(),
    })
    .optional(),
});

const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  occurredAt: z.date(),
});

const defs = defineStore({
  users: defineTable({
    tableName: 'users',
    schema: UserSchema,
    primaryKey: 'id',
    indexes: [{ columns: ['age'] }],
    encryptedFields: ['content'],
    decryptedSchema: DecryptedUserSchema,
  }),
});

const eventDefs = defineStore({
  events: defineTable({
    tableName: 'events',
    schema: EventSchema,
    primaryKey: 'id',
    indexes: [{ columns: ['occurredAt'] }],
  }),
});

type MockKey = string;
const MOCK_KEY: MockKey = 'test-mek';

const mockManager: CryptoManager<MockKey> = {
  deriveKey: async (_config, secret, _salt) => secret.slice(0, 32),
  importKey: async (_config, _bytes) => MOCK_KEY,
  encrypt: async (_config, _key, data) => ({
    iv: 'mock-iv',
    cipher: btoa(String.fromCharCode(...data)),
  }),
  decrypt: async (_config, _key, { cipher }: CryptoPayload) =>
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

const { StoreContext, useStoreContext, useStore, useLiveQuery } =
  createStoreContext<typeof defs>();

const { StoreContext: EventCtx, useLiveQuery: useEventLiveQuery } =
  createStoreContext<typeof eventDefs>();

let dbCounter = 0;

// ─── createStoreContext ───────────────────────────────────────────────────────

describe('createStoreContext', () => {
  it('useStoreContext throws when rendered outside a provider', () => {
    expect(() => renderHook(() => useStoreContext())).toThrow(
      /StoreContext not initialized/,
    );
  });
});

// ─── useStore ─────────────────────────────────────────────────────────────────

describe('useStore', () => {
  let store: DexieStore<typeof defs>;

  beforeEach(() => {
    store = new DexieStore(`test-${++dbCounter}`, defs);
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <StoreContext.Provider value={{ store, liveQuery }}>
        {children}
      </StoreContext.Provider>
    );
  }

  it('returns the store from context', () => {
    const { result } = renderHook(() => useStore(), { wrapper });
    expect(result.current).toBe(store);
  });

  it('exposes the expected table', () => {
    const { result } = renderHook(() => useStore(), { wrapper });
    expect(result.current.table.users).toBeDefined();
  });
});

// ─── useLiveQuery ─────────────────────────────────────────────────────────────

describe('useLiveQuery', () => {
  let store: DexieStore<typeof defs>;

  beforeEach(() => {
    store = new DexieStore(`test-${++dbCounter}`, defs);
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <StoreContext.Provider value={{ store, liveQuery }}>
        {children}
      </StoreContext.Provider>
    );
  }

  it('returns undefined before the first emission', () => {
    const { result } = renderHook(
      () => useLiveQuery(() => store.table.users.findMany()),
      { wrapper },
    );
    expect(result.current).toBeUndefined();
  });

  it('reflects inserted data reactively', async () => {
    const { result } = renderHook(
      () => useLiveQuery(() => store.table.users.findMany()),
      { wrapper },
    );

    await act(async () => {
      await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
      expect(result.current![0]!.name).toBe('Alice');
    });
  });

  it('updates when data changes', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 17 },
    ]);

    const { result } = renderHook(
      () =>
        useLiveQuery(() =>
          store.table.users.findMany({ where: { age: { $gte: 18 } } }),
        ),
      { wrapper },
    );

    await waitFor(() => expect(result.current).toHaveLength(1));

    await act(async () => {
      await store.table.users.update('2', { age: 18 });
    });

    await waitFor(() => expect(result.current).toHaveLength(2));
  });

  it('unsubscribes when the component unmounts', async () => {
    const unsubscribe = vi.fn();
    const mockLiveQuery = vi.fn(() => ({ subscribe: () => ({ unsubscribe }) }));

    const { unmount } = renderHook(
      () => useLiveQuery(() => store.table.users.findMany()),
      {
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store, liveQuery: mockLiveQuery as any }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('re-subscribes when deps change', async () => {
    const subscribe = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const mockLiveQuery = vi.fn(() => ({ subscribe }));

    const { rerender } = renderHook(
      ({ dep }: { dep: number }) =>
        useLiveQuery(() => store.table.users.findMany(), [dep]),
      {
        initialProps: { dep: 1 },
        wrapper: ({ children }) => (
          <StoreContext.Provider
            value={{ store, liveQuery: mockLiveQuery as any }}
          >
            {children}
          </StoreContext.Provider>
        ),
      },
    );

    const callsBefore = subscribe.mock.calls.length;
    rerender({ dep: 2 });
    expect(subscribe.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ─── useLiveQuery with date filters ──────────────────────────────────────────

describe('useLiveQuery — date range filters', () => {
  let store: DexieStore<typeof eventDefs>;

  beforeEach(async () => {
    store = new DexieStore(`test-events-${++dbCounter}`, eventDefs);
    await store.table.events.insertMany([
      { id: '1', name: 'January', occurredAt: new Date('2024-01-15') },
      { id: '2', name: 'February', occurredAt: new Date('2024-02-15') },
      { id: '3', name: 'March', occurredAt: new Date('2024-03-15') },
    ]);
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <EventCtx.Provider value={{ store, liveQuery }}>
        {children}
      </EventCtx.Provider>
    );
  }

  it('filters by $gte / $lte date range', async () => {
    const { result } = renderHook(
      () =>
        useEventLiveQuery(() =>
          store.table.events.findMany({
            where: {
              occurredAt: {
                $gte: new Date('2024-01-01'),
                $lte: new Date('2024-02-28'),
              },
            },
            orderBy: { occurredAt: 'asc' },
          }),
        ),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
      expect(result.current![0]!.name).toBe('January');
      expect(result.current![1]!.name).toBe('February');
    });
  });
});

// ─── createEncryptedStoreContext ──────────────────────────────────────────────

describe('createEncryptedStoreContext', () => {
  const { useStoreContext: useEncStoreContext } =
    createEncryptedStoreContext<typeof defs>();

  it('throws when rendered outside a provider', () => {
    expect(() => renderHook(() => useEncStoreContext())).toThrow(
      /StoreContext not initialized/,
    );
  });
});

// ─── useStore and useRawStore (encrypted context) ─────────────────────────────

describe('useStore and useRawStore (encrypted context)', () => {
  const {
    StoreContext: EncCtx,
    useStore: useEncStore,
    useRawStore,
  } = createEncryptedStoreContext<typeof defs>();

  let store: DexieStore<typeof defs>;
  let encStore: ReturnType<
    typeof createCryptoStore<typeof defs, MockKey>
  >['store'];

  beforeEach(() => {
    store = new DexieStore(`test-enc-${++dbCounter}`, defs);
    const cs = createCryptoStore(store, defs, mockManager);
    cs.setMek(MOCK_KEY);
    encStore = cs.store;
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <EncCtx.Provider value={{ store: encStore, rawStore: store, liveQuery }}>
        {children}
      </EncCtx.Provider>
    );
  }

  it('useStore returns the encrypted store', () => {
    const { result } = renderHook(() => useEncStore(), { wrapper });
    expect(result.current).toBe(encStore);
  });

  it('useRawStore returns the raw store', () => {
    const { result } = renderHook(() => useRawStore(), { wrapper });
    expect(result.current).toBe(store);
  });

  it('encrypt is called only for encryptedFields', async () => {
    const spyEncrypt = vi.fn(mockManager.encrypt);
    const spyManager: CryptoManager<MockKey> = {
      ...mockManager,
      encrypt: spyEncrypt,
    };
    const spyStore = new DexieStore(`test-enc-spy-${++dbCounter}`, defs);
    const spyCs = createCryptoStore(spyStore, defs, spyManager);
    spyCs.setMek(MOCK_KEY);

    const { StoreContext: SpyCtx, useStore: useSpyEnc } =
      createEncryptedStoreContext<typeof defs>();

    const { result } = renderHook(() => useSpyEnc(), {
      wrapper: ({ children }) => (
        <SpyCtx.Provider
          value={{ store: spyCs.store, rawStore: spyStore, liveQuery }}
        >
          {children}
        </SpyCtx.Provider>
      ),
    });

    await act(async () => {
      await result.current.table.users.insert({
        id: '1',
        name: 'Alice',
        age: 30,
        content: {
          text: 'hello',
          year: 2024,
          timestamp: new Date('2024-01-01'),
        },
      });
    });

    // encrypt called exactly once — only for the 'content' encrypted field
    expect(spyEncrypt).toHaveBeenCalledTimes(1);
  });

  it('insert round-trips through encrypt/decrypt', async () => {
    const { result } = renderHook(() => useEncStore(), { wrapper });
    const returned = await act(() =>
      result.current.table.users.insert({
        id: '1',
        name: 'Alice',
        age: 30,
        content: {
          text: 'hello',
          year: 2024,
          timestamp: new Date('2024-01-01'),
        },
      }),
    );
    expect(returned.name).toBe('Alice');
    expect(returned.content?.text).toBe('hello');
    expect(returned.content?.timestamp).toBeInstanceOf(Date);
  });

  it('raw store holds content as a CryptoPayload object', async () => {
    const { result: encResult } = renderHook(() => useEncStore(), { wrapper });
    const { result: rawResult } = renderHook(() => useRawStore(), { wrapper });

    await act(async () => {
      await encResult.current.table.users.insert({
        id: '1',
        name: 'Alice',
        age: 30,
        content: {
          text: 'hello',
          year: 2024,
          timestamp: new Date('2024-01-01'),
        },
      });
    });

    const raw = await rawResult.current.table.users.find('1');
    expect(raw?.content).toMatchObject({
      iv: expect.any(String),
      cipher: expect.any(String),
    });
  });

  it('useLiveQuery with useStore returns decrypted content', async () => {
    const {
      StoreContext: EncCtx2,
      useStore: useEnc2,
      useLiveQuery: useEncLQ,
    } = createEncryptedStoreContext<typeof defs>();
    const store2 = new DexieStore(`test-enc-lq-${++dbCounter}`, defs);
    const cs2 = createCryptoStore(store2, defs, mockManager);
    cs2.setMek(MOCK_KEY);

    const { result } = renderHook(
      () => {
        const enc = useEnc2();
        return useEncLQ(() => enc.table.users.findMany());
      },
      {
        wrapper: ({ children }) => (
          <EncCtx2.Provider
            value={{ store: cs2.store, rawStore: store2, liveQuery }}
          >
            {children}
          </EncCtx2.Provider>
        ),
      },
    );

    await act(async () => {
      await cs2.store.table.users.insert({
        id: '1',
        name: 'Alice',
        age: 30,
        content: {
          text: 'hello',
          year: 2024,
          timestamp: new Date('2024-01-01'),
        },
      });
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
      expect(result.current![0]!.content?.timestamp).toBeInstanceOf(Date);
    });
  });
});
