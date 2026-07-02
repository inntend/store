// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { liveQuery } from 'dexie';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DexieStore } from '../../src/dexie/store';
import {
  createEncryptedStoreContext,
  createStoreContext,
} from '../../src/react/hooks';
import {
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  buildUseSync,
  SYNC_REFRESH_INTERVAL_MS,
} from '../../src/react/sync';
import { defineStore, defineTable } from '../../src/store';
import { type CryptoManager, createCryptoStore } from '../../src/store/crypto';
import type { SyncableStore } from '../../src/store/utils';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().int(),
  updatedAt: z.date(),
  createdAt: z.date(),
  deleted: z.boolean(),
});

const defs = defineStore({
  users: defineTable({
    tableName: 'users',
    schema: UserSchema,
    primaryKey: 'id',
  }),
});

// Minimal schema for encrypted context tests
const EncUserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  content: z.string().optional(),
});

const encDefs = defineStore({
  users: defineTable({
    tableName: 'users',
    schema: EncUserSchema,
    primaryKey: 'id',
    encryptedFields: ['content'],
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

// ─── Shared context + helpers ─────────────────────────────────────────────────

const { StoreContext, useSync, useSyncState } =
  createStoreContext<typeof defs>();

let dbCounter = 0;

function makeStore() {
  return new DexieStore(`sync-test-${++dbCounter}`, defs);
}

function makeWrapper(store: DexieStore<typeof defs>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <StoreContext.Provider value={{ store, liveQuery }}>
        {children}
      </StoreContext.Provider>
    );
  };
}

function mockSyncableStore(): SyncableStore {
  return {
    users: {
      findMany: vi.fn().mockResolvedValue([]),
      upsertMany: vi.fn().mockResolvedValue([]),
    },
  };
}

// Fake-timer preset that leaves setImmediate real so fake-indexeddb's internal
// async operations (and therefore the hook's settings load) resolve normally.
const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'Date',
  ],
};

// Drains the settings load + mount auto-sync without advancing fake time:
// each round yields to the event loop via a REAL setImmediate, and act() is
// exited between rounds so fake-indexeddb writes (blocked while act's queue
// is processing) can commit.
async function flushAsync(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
}

// ─── useSyncState ─────────────────────────────────────────────────────────────

describe('useSyncState', () => {
  it('defaults to online', () => {
    const store = makeStore();
    const { result } = renderHook(() => useSyncState(), {
      wrapper: makeWrapper(store),
    });
    expect(result.current.syncState).toBe('online');
  });

  it('setSyncState changes the state', async () => {
    const store = makeStore();
    const { result } = renderHook(() => useSyncState(), {
      wrapper: makeWrapper(store),
    });
    await act(async () => {
      result.current.setSyncState('offline');
    });
    expect(result.current.syncState).toBe('offline');
  });

  it('can cycle through all states', async () => {
    const store = makeStore();
    const { result } = renderHook(() => useSyncState(), {
      wrapper: makeWrapper(store),
    });
    await act(async () => {
      result.current.setSyncState('disabled');
    });
    expect(result.current.syncState).toBe('disabled');
    await act(async () => {
      result.current.setSyncState('online');
    });
    expect(result.current.syncState).toBe('online');
  });
});

// ─── useSync — initial state ──────────────────────────────────────────────────

describe('useSync — initial state', () => {
  it('syncing is false, lastSynced is defined, syncState is online', async () => {
    const store = makeStore();
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher: vi.fn().mockResolvedValue({ data: {}, hasMore: false }),
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );
    // Auto-sync fires on mount once settings have loaded; drain it fully
    await flushAsync();
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBeDefined();
    expect(result.current.syncState).toBe('online');
  });
});

// ─── useSync — settings ───────────────────────────────────────────────────────

describe('useSync — settings', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    store = makeStore();
  });

  it('loads lastSynced from settings before the first auto-sync', async () => {
    const iso = new Date('2024-06-01').toISOString();
    await store.settings.set('lastSynced', iso);

    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );

    // Regression guard: the mount auto-sync must wait for the persisted
    // cursor — it must NOT sync from defaultFrom (a full re-pull) while a
    // real lastSynced exists.
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const { from } = fetcher.mock.calls[0]![0] as { from: Date };
    expect(from.toISOString()).toBe(iso);
  });

  it('persists lastSynced to settings after sync', async () => {
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher: vi.fn().mockResolvedValue({ data: {}, hasMore: false }),
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.sync();
    });

    await waitFor(async () => {
      const saved = await store.settings.get('lastSynced');
      expect(saved).toBe(result.current.lastSynced);
    });
  });
});

// ─── useSync — fetcher params ─────────────────────────────────────────────────

describe('useSync — fetcher params', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    store = makeStore();
  });

  it('calls fetcher with from/to/delta and clears syncing', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );

    // Drain the mount auto-sync so the manual call below is isolated
    await flushAsync();
    fetcher.mockClear();

    await act(async () => {
      await result.current.sync();
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const { from, to, delta } = fetcher.mock.calls[0]![0] as {
      from: Date;
      to: Date;
      delta: object;
    };
    expect(from).toBeInstanceOf(Date);
    expect(to).toBeInstanceOf(Date);
    expect(delta).toEqual(expect.any(Object));
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBeDefined();
  });

  it('passes device current timestamp as `to`', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const fakeNow = new Date('2024-06-15T10:30:00Z');
    vi.setSystemTime(fakeNow);

    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.sync();
    });

    const { to } = fetcher.mock.calls[0]![0] as { to: Date };
    expect(to.getTime()).toBe(fakeNow.getTime());
    vi.useRealTimers();
  });
});

// ─── useSync — offline / disabled guard ──────────────────────────────────────

describe('useSync — offline/disabled drops the call', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    store = makeStore();
  });

  it('does not call fetcher when disabled', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );
    // Drain initial auto-sync, then clear to isolate the disabled-guard behaviour
    await flushAsync();
    fetcher.mockClear();
    await act(async () => {
      result.current.setSyncState('disabled');
    });
    await act(async () => {
      await result.current.sync();
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not call fetcher when disabled (no mock return)', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );
    // Drain initial auto-sync, then clear to isolate the disabled-guard behaviour
    await flushAsync();
    fetcher.mockClear();
    await act(async () => {
      result.current.setSyncState('disabled');
    });
    await act(async () => {
      await result.current.sync();
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('syncing stays false when dropped', async () => {
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher: vi.fn(),
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );
    await act(async () => {
      result.current.setSyncState('offline');
    });
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.syncing).toBe(false);
  });
});

// ─── useSync — concurrent call guard ─────────────────────────────────────────

describe('useSync — concurrent call guard', () => {
  it('coalesces concurrent sync() calls into at most one follow-up run', async () => {
    const store = makeStore();
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: makeWrapper(store) },
    );

    // Drain the mount auto-sync so the calls below are isolated
    await flushAsync();
    fetcher.mockClear();

    let resolveFirst!: (v: unknown) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res;
        }),
    );

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    let thirdPromise!: Promise<void>;
    await act(async () => {
      firstPromise = result.current.sync(); // starts, hangs on fetcher
      secondPromise = result.current.sync(); // in flight → queues follow-up
      thirdPromise = result.current.sync(); // follow-up already queued → dropped
      await Promise.all([secondPromise, thirdPromise]);
    });

    // Only the first call has hit the network so far
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ data: {}, hasMore: false });
      await firstPromise;
    });

    // The queued calls collapse into exactly one follow-up run
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});

// ─── useSync — defaultFrom ────────────────────────────────────────────────────

describe('useSync — defaultFrom', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    store = makeStore();
  });

  it('uses defaultFrom as `from` on the first sync', async () => {
    const defaultFrom = new Date('2000-01-01T00:00:00Z');
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () => useSync({ store: mockSyncableStore(), fetcher, defaultFrom }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.sync();
    });

    const { from } = fetcher.mock.calls[0]![0] as { from: Date };
    expect(from.getTime()).toBe(defaultFrom.getTime());
  });

  it('uses lastSynced (not defaultFrom) on the second sync', async () => {
    const defaultFrom = new Date('2000-01-01T00:00:00Z');
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () => useSync({ store: mockSyncableStore(), fetcher, defaultFrom }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.sync();
    });
    await act(async () => {
      await result.current.sync();
    });

    const firstFrom = (fetcher.mock.calls[0]![0] as { from: Date }).from;
    const secondFrom = (fetcher.mock.calls[1]![0] as { from: Date }).from;
    expect(secondFrom.getTime()).toBeGreaterThan(firstFrom.getTime());
  });

  it('pre-existing lastSynced in settings overrides defaultFrom', async () => {
    const iso = new Date('2024-03-01').toISOString();
    await store.settings.set('lastSynced', iso);

    const defaultFrom = new Date('2000-01-01');
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    renderHook(
      () => useSync({ store: mockSyncableStore(), fetcher, defaultFrom }),
      { wrapper: makeWrapper(store) },
    );

    // Every sync — including the very first on mount — must use the
    // persisted cursor, never defaultFrom.
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const { from } = fetcher.mock.calls[0]![0] as { from: Date };
    expect(from.getTime()).toBe(new Date(iso).getTime());
  });
});

// ─── useSync — encrypted context ─────────────────────────────────────────────

describe('useSync — encrypted context', () => {
  const { StoreContext: EncCtx, useSync: useEncSync } =
    createEncryptedStoreContext<typeof encDefs>();

  let rawStore: DexieStore<typeof encDefs>;
  let encStore: ReturnType<
    typeof createCryptoStore<typeof encDefs, MockKey>
  >['store'];

  beforeEach(() => {
    rawStore = new DexieStore(`sync-enc-${++dbCounter}`, encDefs);
    const cs = createCryptoStore(rawStore, encDefs, mockManager);
    cs.setMek(MOCK_KEY);
    encStore = cs.store;
  });

  function encWrapper({ children }: { children: React.ReactNode }) {
    return (
      <EncCtx.Provider value={{ store: encStore, rawStore, liveQuery }}>
        {children}
      </EncCtx.Provider>
    );
  }

  function mockEncStore() {
    return {
      users: {
        findMany: vi.fn().mockResolvedValue([]),
        upsertMany: vi.fn().mockResolvedValue([]),
      },
    };
  }

  it('reads and writes lastSynced from the raw store settings', async () => {
    const iso = new Date('2025-01-01').toISOString();
    await rawStore.settings.set('lastSynced', iso);

    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    renderHook(
      () =>
        useEncSync({
          store: mockEncStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: encWrapper },
    );

    // The first sync must start from the persisted raw-store cursor.
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const { from } = fetcher.mock.calls[0]![0] as { from: Date };
    expect(from.toISOString()).toBe(iso);
  });

  it('passes device current timestamp as `to` in encrypted context', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const fakeNow = new Date('2024-07-20T14:45:00Z');
    vi.setSystemTime(fakeNow);

    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const { result } = renderHook(
      () =>
        useEncSync({
          store: mockEncStore(),
          fetcher,
          defaultFrom: new Date(0),
        }),
      { wrapper: encWrapper },
    );

    await act(async () => {
      await result.current.sync();
    });

    const { to } = fetcher.mock.calls[0]![0] as { to: Date };
    expect(to.getTime()).toBe(fakeNow.getTime());
    vi.useRealTimers();
  });
});

// ─── useSync — offline detection ──────────────────────────────────────────────

describe('useSync — offline detection', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    store = makeStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetcher rejection sets syncState to offline and resolves (does not throw)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network error'));
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.sync(); // must resolve, not throw
    });

    expect(result.current.syncState).toBe('offline');
    expect(result.current.syncing).toBe(false);
    expect(result.current.lastSynced).toBeUndefined();
  });

  it('successful sync after offline restores syncState to online', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    // First call → offline
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.syncState).toBe('offline');

    // Manually restore online so the sync() guard passes, then call again
    await act(async () => {
      result.current.setSyncState('online');
    });
    await act(async () => {
      await result.current.sync();
    });

    expect(result.current.syncState).toBe('online');
    expect(result.current.lastSynced).toBeDefined();
  });

  it('disabled state suppresses offline detection', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network error'));
    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Drain initial auto-sync (it fails → offline), then clear and disable
    await flushAsync();
    fetcher.mockClear();

    await act(async () => {
      result.current.setSyncState('disabled');
    });

    // sync() is a no-op when disabled — fetcher never called
    await act(async () => {
      await result.current.sync();
    });

    expect(result.current.syncState).toBe('disabled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ─── useSync — backoff ────────────────────────────────────────────────────────

describe('useSync — backoff', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    // Pin jitter to 1.0× (0.8 + 0.5·0.4) so backoff timings are exact.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    store = makeStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules first retry after BACKOFF_INITIAL_MS', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Auto-sync on mount triggers offline (first and only call so far)
    await flushAsync();
    expect(result.current.syncState).toBe('offline');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Just before the backoff fires — no retry yet (sync version: doesn't trigger callback)
    await act(async () => {
      vi.advanceTimersByTime(BACKOFF_INITIAL_MS - 1);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Past the backoff — backoff retry succeeds → online; online transition fires
    // another immediate auto-sync, so total calls = 3 (initial fail + retry + online auto-sync)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.syncState).toBe('online');
  });

  it('doubles the backoff delay on each failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network error'));

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    // First failure → backoff = BACKOFF_INITIAL_MS
    await act(async () => {
      await result.current.sync();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Fire first retry → second failure → backoff doubles
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKOFF_INITIAL_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Advance only BACKOFF_INITIAL_MS — not enough for the doubled backoff
    await act(async () => {
      vi.advanceTimersByTime(BACKOFF_INITIAL_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2); // still 2

    // Advance the remaining — total = BACKOFF_INITIAL_MS * 2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKOFF_INITIAL_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('caps backoff at BACKOFF_MAX_MS', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network error'));

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    // First failure to put hook into offline + start backoff chain
    await act(async () => {
      await result.current.sync();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Drive enough backoff retries to hit the cap (each advance exceeds max)
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS + 1);
      });
    }

    const callCount = fetcher.mock.calls.length;
    expect(callCount).toBeGreaterThan(1);

    // From here, each advance of BACKOFF_MAX_MS should fire exactly one retry
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(callCount + 1);
  });
});

// ─── useSync — auto-refresh ───────────────────────────────────────────────────

describe('useSync — auto-refresh', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
    // Pin jitter so backoff-related timings stay exact.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    store = makeStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('auto-syncs on the configured interval when online (adaptive stretching pinned)', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const refreshInterval = 10_000;

    renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval,
          // Cap the adaptive idle interval at the base interval so the
          // cadence stays fixed for this test.
          maxRefreshInterval: refreshInterval,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Auto-sync fires on mount (1 call), then once per interval
    await flushAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(refreshInterval);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(refreshInterval);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('quiet syncs stretch the auto-sync delay up to maxRefreshInterval; activity resets it', async () => {
    // Every sync here is "quiet": empty local delta, empty server response.
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const refreshInterval = 10_000;

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval,
          maxRefreshInterval: 40_000,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Mount sync is quiet → next delay doubles to 20s.
    await flushAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Nothing at the base interval any more…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(refreshInterval);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // …but the doubled delay fires (10s + 10s = 20s total).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(refreshInterval);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Next delay doubles again to 40s (the cap).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);

    // A manual sync (user activity) snaps the delay back to the base interval.
    await act(async () => {
      await result.current.sync();
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    // The pending 40s timer fires once, and the reset means subsequent syncs
    // ran at the shorter cadence again — at least one more call happened.
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('refreshInterval: 0 disables auto-refresh', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Drain the immediate auto-sync on mount, then verify no more calls fire
    await flushAsync();
    fetcher.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(SYNC_REFRESH_INTERVAL_MS * 10);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('disabled state prevents auto-refresh', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const refreshInterval = 5_000;

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Drain the immediate auto-sync, then clear before testing the disabled guard
    await flushAsync();
    fetcher.mockClear();

    await act(async () => {
      result.current.setSyncState('disabled');
    });

    await act(async () => {
      vi.advanceTimersByTime(refreshInterval * 3);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('offline state uses backoff timer instead of refresh interval', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({ data: {}, hasMore: false });
    const refreshInterval = 5_000;

    renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Auto-sync fires on mount, fails → goes offline (1 call)
    await flushAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Backoff fires (BACKOFF_INITIAL_MS), not the refresh interval; retry succeeds →
    // online transition fires another immediate auto-sync (total = 3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKOFF_INITIAL_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('manual sync() call works regardless of refreshInterval', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () =>
        useSync({
          store: mockSyncableStore(),
          fetcher,
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    // Drain the mount auto-sync so the manual call below is isolated
    await flushAsync();
    fetcher.mockClear();

    await act(async () => {
      await result.current.sync();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── buildUseSync — checkAndFix ───────────────────────────────────────────────

describe('buildUseSync — checkAndFix called when records are written', () => {
  it('calls checkAndFix with written IDs after a sync that upserts records', async () => {
    const checkAndFix = vi.fn(async () => {});
    const store = makeStore();

    const useSyncWithFix = buildUseSync<typeof defs>(
      () => store,
      () => ({ syncState: 'online' as const, setSyncState: vi.fn() }),
      () => checkAndFix,
    );

    const { result } = renderHook(
      () =>
        useSyncWithFix({
          store: mockSyncableStore(),
          fetcher: vi.fn().mockResolvedValue({
            data: { users: [{ id: 'u1', updatedAt: new Date() }] },
            hasMore: false,
          }),
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    await flushAsync();
    await act(async () => {
      await result.current.sync();
    });
    await flushAsync();

    expect(checkAndFix).toHaveBeenCalledWith(
      expect.objectContaining({ users: ['u1'] }),
    );
  });

  it('swallows checkAndFix errors and does not affect lastSynced', async () => {
    const checkAndFix = vi.fn(async () => {
      throw new Error('fix failed');
    });
    const store = makeStore();

    const useSyncWithFix = buildUseSync<typeof defs>(
      () => store,
      () => ({ syncState: 'online' as const, setSyncState: vi.fn() }),
      () => checkAndFix,
    );

    const { result } = renderHook(
      () =>
        useSyncWithFix({
          store: mockSyncableStore(),
          fetcher: vi.fn().mockResolvedValue({
            data: { users: [{ id: 'u2', updatedAt: new Date() }] },
            hasMore: false,
          }),
          defaultFrom: new Date(0),
          refreshInterval: 0,
        }),
      { wrapper: makeWrapper(store) },
    );

    await flushAsync();
    await act(async () => {
      await result.current.sync();
    });
    await flushAsync();

    // checkAndFix threw but sync still succeeded
    expect(result.current.lastSynced).toBeDefined();
    expect(result.current.syncState).toBe('online');
  });
});
