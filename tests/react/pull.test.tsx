// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { liveQuery } from 'dexie';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DexieStore } from '../../src/dexie/store';
import { createStoreContext } from '../../src/react/hooks';
import { defineStore, defineTable } from '../../src/store';
import type { SyncableStore } from '../../src/store/utils';

// ─── Schema ───────────────────────────────────────────────────────────────────

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

// ─── Shared context + helpers ─────────────────────────────────────────────────

const { StoreContext, useSync, usePull, useAutoPull, useSyncState } =
  createStoreContext<typeof defs>();

let dbCounter = 0;

function makeStore() {
  return new DexieStore(`pull-test-${++dbCounter}`, defs);
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

// ─── usePull — initial state ──────────────────────────────────────────────────

describe('usePull — initial state', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    store = makeStore();
  });

  it('pulling is false initially', () => {
    const { result } = renderHook(
      () =>
        usePull({ store: mockSyncableStore(), fetcher: vi.fn(), queries: {} }),
      { wrapper: makeWrapper(store) },
    );
    expect(result.current.pulling).toBe(false);
  });

  it('exposes a pull function', () => {
    const { result } = renderHook(
      () =>
        usePull({ store: mockSyncableStore(), fetcher: vi.fn(), queries: {} }),
      { wrapper: makeWrapper(store) },
    );
    expect(typeof result.current.pull).toBe('function');
  });

  it('pulling returns to false after completing', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const { result } = renderHook(
      () => usePull({ store: mockSyncableStore(), fetcher, queries: {} }),
      { wrapper: makeWrapper(store) },
    );
    await act(async () => {
      await result.current.pull();
    });
    expect(result.current.pulling).toBe(false);
  });
});

// ─── usePull — fetcher calls ──────────────────────────────────────────────────

describe('usePull — fetcher calls', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    store = makeStore();
  });

  it('calls fetcher with queries and pageOffset=0', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });

    const { result } = renderHook(
      () =>
        usePull({
          store: mockSyncableStore(),
          fetcher,
          queries: { users: { limit: 10 } },
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.pull();
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const call = fetcher.mock.calls[0]![0] as {
      queries: object;
      pageOffset: number;
    };
    expect(call.pageOffset).toBe(0);
    expect(call.queries).toHaveProperty('users');
  });

  it('works with an empty queries object', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () => usePull({ store: mockSyncableStore(), fetcher, queries: {} }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.pull();
    });

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('upserts returned rows into the sync store', async () => {
    const now = new Date();
    const upsertMany = vi.fn().mockResolvedValue([]);
    const syncStore: SyncableStore = {
      users: { findMany: vi.fn().mockResolvedValue([]), upsertMany },
    };
    const fetcher = vi.fn().mockResolvedValue({
      data: { users: [{ id: 'u1', updatedAt: now }] },
      hasMore: false,
    });

    const { result } = renderHook(
      () => usePull({ store: syncStore, fetcher, queries: { users: {} } }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.pull();
    });

    expect(upsertMany).toHaveBeenCalledOnce();
    const [rows] = upsertMany.mock.calls[0] as [unknown[]];
    expect(rows[0]).toMatchObject({ id: 'u1' });
  });

  it('handles pagination — calls fetcher twice and advances pageOffset', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        data: { users: [] },
        hasMore: true,
        pageSize: 5,
      })
      .mockResolvedValueOnce({ data: { users: [] }, hasMore: false });

    const { result } = renderHook(
      () =>
        usePull({
          store: mockSyncableStore(),
          fetcher,
          queries: { users: {} },
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.pull();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const secondCall = fetcher.mock.calls[1]![0] as { pageOffset: number };
    expect(secondCall.pageOffset).toBe(5);
  });

  it('passes type-safe FindQuery fields for each table', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });

    const { result } = renderHook(
      () =>
        usePull({
          store: mockSyncableStore(),
          fetcher,
          queries: {
            users: {
              where: { name: { $eq: 'Alice' }, deleted: { $eq: false } },
              orderBy: { updatedAt: 'desc' },
              limit: 20,
            },
          },
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      await result.current.pull();
    });

    const call = fetcher.mock.calls[0]![0] as { queries: { users: object } };
    expect(call.queries.users).toMatchObject({ limit: 20 });
  });
});

// ─── usePull — offline / disabled guard ──────────────────────────────────────

describe('usePull — offline/disabled drops the call', () => {
  let store: DexieStore<typeof defs>;
  beforeEach(() => {
    store = makeStore();
  });

  it('does not call fetcher when offline', async () => {
    const fetcher = vi.fn();
    const { result } = renderHook(
      () => ({
        pull: usePull({ store: mockSyncableStore(), fetcher, queries: {} }),
        syncState: useSyncState(),
      }),
      { wrapper: makeWrapper(store) },
    );
    await act(async () => {
      result.current.syncState.setSyncState('offline');
    });
    await act(async () => {
      await result.current.pull.pull();
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not call fetcher when disabled', async () => {
    const fetcher = vi.fn();
    const { result } = renderHook(
      () => ({
        pull: usePull({ store: mockSyncableStore(), fetcher, queries: {} }),
        syncState: useSyncState(),
      }),
      { wrapper: makeWrapper(store) },
    );
    await act(async () => {
      result.current.syncState.setSyncState('disabled');
    });
    await act(async () => {
      await result.current.pull.pull();
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('pulling stays false when dropped', async () => {
    const { result } = renderHook(
      () => ({
        pull: usePull({
          store: mockSyncableStore(),
          fetcher: vi.fn(),
          queries: {},
        }),
        syncState: useSyncState(),
      }),
      { wrapper: makeWrapper(store) },
    );
    await act(async () => {
      result.current.syncState.setSyncState('offline');
    });
    await act(async () => {
      await result.current.pull.pull();
    });
    expect(result.current.pull.pulling).toBe(false);
  });
});

// ─── usePull — concurrent call guard ─────────────────────────────────────────

describe('usePull — concurrent call guard', () => {
  it('ignores a second pull() call while one is in flight', async () => {
    const store = makeStore();
    let resolveFirst!: (v: unknown) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValue({ data: {}, hasMore: false });

    const { result } = renderHook(
      () => usePull({ store: mockSyncableStore(), fetcher, queries: {} }),
      { wrapper: makeWrapper(store) },
    );

    const firstPromise = result.current.pull();
    await act(async () => {
      await result.current.pull(); // dropped
    });

    await act(async () => {
      resolveFirst({ data: {}, hasMore: false });
      await firstPromise;
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── usePull + useSync share SyncStateContext ─────────────────────────────────

describe('usePull + useSync share SyncStateContext', () => {
  it('setSyncState via useSync also guards usePull', async () => {
    const store = makeStore();
    const pullFetcher = vi.fn();

    const { result } = renderHook(
      () => ({
        sync: useSync({
          store: mockSyncableStore(),
          fetcher: vi.fn(),
          defaultFrom: new Date(0),
        }),
        pull: usePull({
          store: mockSyncableStore(),
          fetcher: pullFetcher,
          queries: {},
        }),
      }),
      { wrapper: makeWrapper(store) },
    );

    // Drain initial auto-sync that fires on mount before disabling
    await act(async () => {});

    await act(async () => {
      result.current.sync.setSyncState('offline');
    });
    await act(async () => {
      await result.current.pull.pull();
    });

    expect(pullFetcher).not.toHaveBeenCalled();
  });
});

// ─── useAutoPull — initial state ──────────────────────────────────────────────

describe('useAutoPull — initial state', () => {
  it('pulling is false initially', () => {
    const store = makeStore();
    const { result } = renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher: vi.fn(),
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
              },
              field: 'updatedAt',
            },
          },
        }),
      { wrapper: makeWrapper(store) },
    );
    expect(result.current.pulling).toBe(false);
  });
});

// ─── useAutoPull — auto-fires on mount ───────────────────────────────────────

describe('useAutoPull — auto-fires on mount', () => {
  it('calls fetcher automatically on mount for uncovered range', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    const { result } = renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
              },
              field: 'updatedAt',
            },
          },
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(result.current.pulling).toBe(false);
  });

  it('pulling returns to false after auto-pull completes', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const store = makeStore();

    const { result } = renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {},
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(result.current.pulling).toBe(false));
  });

  it('skips fetcher when range is already covered in settings', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: {}, hasMore: false });
    const store = makeStore();

    await store.settings.set('pull', {
      users: {
        ranges: [
          { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z' },
        ],
      },
    });

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
              },
              field: 'updatedAt',
            },
          },
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {});
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ─── useAutoPull — coverage persistence ──────────────────────────────────────

describe('useAutoPull — coverage persistence', () => {
  it('records coverage in settings after pull completes', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
              },
              field: 'updatedAt',
            },
          },
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(async () => {
      const pullSettings = await store.settings.get('pull');
      expect(pullSettings?.users?.ranges).toHaveLength(1);
    });

    const pullSettings = await store.settings.get('pull');
    expect(pullSettings?.users?.ranges?.[0]).toMatchObject({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-01-31T00:00:00.000Z',
    });
  });

  it('does not call fetcher again for same range after coverage recorded', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();
    let tables = {
      users: {
        range: { from: new Date('2024-01-01'), to: new Date('2024-01-31') },
        field: 'updatedAt',
      },
    } as const;

    const { rerender } = renderHook(
      () => useAutoPull({ store: mockSyncableStore(), fetcher, tables }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fires again when range changes to uncovered window', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    let tables = {
      users: {
        range: { from: new Date('2024-01-01'), to: new Date('2024-01-31') },
        field: 'updatedAt' as const,
      },
    };

    const { rerender } = renderHook(
      () => useAutoPull({ store: mockSyncableStore(), fetcher, tables }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    tables = {
      users: {
        range: { from: new Date('2024-03-01'), to: new Date('2024-03-31') },
        field: 'updatedAt',
      },
    };
    await act(async () => {
      rerender();
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('builds query where clause from field and range', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();
    const from = new Date('2024-01-01');
    const to = new Date('2024-01-31');

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: { users: { range: { from, to }, field: 'updatedAt' } },
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const call = fetcher.mock.calls[0]![0] as {
      queries: { users: { where: object } };
    };
    expect(call.queries.users.where).toMatchObject({
      updatedAt: { $gte: from, $lte: to },
    });
  });
});

// ─── useAutoPull — online guard ───────────────────────────────────────────────

describe('useAutoPull — online guard', () => {
  it('does not call fetcher when syncState starts offline', async () => {
    const fetcher = vi.fn();
    const store = makeStore();

    const { result } = renderHook(
      () => ({
        pull: useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
              },
              field: 'updatedAt',
            },
          },
        }),
        syncState: useSyncState(),
      }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      result.current.syncState.setSyncState('offline');
    });
    await act(async () => {});
    await act(async () => {});

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not call fetcher when disabled', async () => {
    const fetcher = vi.fn();
    const store = makeStore();

    const { result } = renderHook(
      () => ({
        pull: useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
              },
              field: 'updatedAt',
            },
          },
        }),
        syncState: useSyncState(),
      }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      result.current.syncState.setSyncState('disabled');
    });
    await act(async () => {});
    await act(async () => {});

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fires when transitioning from offline back to online', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    await store.settings.set('pull', {
      users: {
        ranges: [
          { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z' },
        ],
      },
    });

    const { result } = renderHook(
      () => ({
        pull: useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
              },
              field: 'updatedAt',
            },
          },
        }),
        syncState: useSyncState(),
      }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {
      result.current.syncState.setSyncState('offline');
    });

    await store.settings.set('pull', {});

    await act(async () => {
      result.current.syncState.setSyncState('online');
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  });
});

// ─── useAutoPull — concurrent guard ──────────────────────────────────────────

describe('useAutoPull — concurrent guard', () => {
  it('does not start a second pull while one is in flight', async () => {
    const store = makeStore();
    let resolveFirst!: (v: unknown) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValue({ data: {}, hasMore: false });

    const tables = {
      users: {
        range: { from: new Date('2024-01-01'), to: new Date('2024-01-31') },
        field: 'updatedAt' as const,
      },
    };

    const { rerender } = renderHook(
      () => useAutoPull({ store: mockSyncableStore(), fetcher, tables }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender();
    });

    await act(async () => {
      resolveFirst({ data: {}, hasMore: false });
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── useAutoPull — full pull (tables with full: true) ────────────────────────

describe('useAutoPull — full pull (tables with full: true)', () => {
  it('calls fetcher on mount when not yet fully pulled', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: { users: { full: true } },
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  });

  it('records full: true in settings after a full pull', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: { users: { full: true } },
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(async () => {
      const pullSettings = await store.settings.get('pull');
      expect(pullSettings?.users?.full).toBe(true);
    });
  });

  it('skips fetcher when full: true already recorded in settings', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    await store.settings.set('pull', { users: { full: true } });

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: { users: { full: true } },
        }),
      { wrapper: makeWrapper(store) },
    );

    await act(async () => {});
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends an empty query (no where clause) to the fetcher', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: { users: { full: true } },
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const call = fetcher.mock.calls[0]![0] as { queries: { users: object } };
    expect(call.queries.users).toEqual({});
  });

  it('does not call fetcher again on rerender after full pull recorded', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    const { rerender } = renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: { users: { full: true } },
        }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ─── isRangeCovered — sort comparator ────────────────────────────────────────

describe('isRangeCovered — out-of-order stored ranges trigger sort', () => {
  it('handles ranges stored in reverse-chronological order (covers sort comparator returning 1)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    // Ranges stored newest-first (out of order) — sort comparator must return 1
    // to bring the earlier range first; query spans both so both are included in sort
    await store.settings.set('pull', {
      users: {
        ranges: [
          { from: '2024-02-01T00:00:00.000Z', to: '2024-02-28T00:00:00.000Z' },
          { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z' },
        ],
      },
    });

    renderHook(
      () =>
        useAutoPull({
          store: mockSyncableStore(),
          fetcher,
          tables: {
            users: {
              range: {
                from: new Date('2024-01-01'),
                to: new Date('2024-02-28'),
              },
              field: 'updatedAt',
            },
          },
        }),
      { wrapper: makeWrapper(store) },
    );

    // Gap between Jan31 and Feb01 means range is not fully covered — pull fires
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  });
});

// ─── mergeRanges — overlapping extension ─────────────────────────────────────

describe('mergeRanges — overlapping ranges that extend existing coverage', () => {
  it('merges an overlapping range that extends the current end (covers line 117)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ data: { users: [] }, hasMore: false });
    const store = makeStore();

    let tables: Parameters<typeof useAutoPull>[0]['tables'] = {
      users: {
        range: { from: new Date('2024-01-01'), to: new Date('2024-02-28') },
        field: 'updatedAt' as const,
      },
    };

    const { rerender } = renderHook(
      () => useAutoPull({ store: mockSyncableStore(), fetcher, tables }),
      { wrapper: makeWrapper(store) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // Overlapping range that starts before the existing end and goes beyond it
    tables = {
      users: {
        range: { from: new Date('2024-02-15'), to: new Date('2024-03-31') },
        field: 'updatedAt',
      },
    };
    await act(async () => {
      rerender();
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    const pullSettings = await store.settings.get('pull');
    // After merge: single expanded range covering Jan 1 → Mar 31
    expect(pullSettings?.users?.ranges).toHaveLength(1);
    expect(pullSettings?.users?.ranges?.[0]).toMatchObject({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-03-31T00:00:00.000Z',
    });
  });
});
