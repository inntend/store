import { describe, expect, it, vi } from 'vitest';
import type { SyncClientParams } from '../../src/store/sync';
import {
  conflictResolutionSchema,
  sync,
  syncClient,
  syncParamsSchema,
} from '../../src/store/sync';
import type { SyncableMeta, SyncableStoreTable } from '../../src/store/utils';
import { syncableMetaSchema } from '../../src/store/utils';

// Adapter: old per-table API → new store-based API
async function syncOne(
  table: SyncableStoreTable<Item>,
  params: {
    from: Date;
    to?: Date;
    items: Item[];
    pageSize?: number;
    pageOffset?: number;
    conflictResolution?: 'lww' | 'server-wins' | 'client-wins';
  },
): Promise<{ delta: Item[]; hasMore: boolean }> {
  const to = params.to ?? new Date();
  const result = await sync(
    { t: table },
    {
      current: new Date(),
      from: params.from,
      to,
      delta: { t: params.items },
      pageOffset: params.pageOffset ?? 0,
      conflictResolution: params.conflictResolution,
    },
    { pageSize: params.pageSize },
  );
  return { delta: (result.data.t ?? []) as Item[], hasMore: result.hasMore };
}

// ─── In-memory table helper ───────────────────────────────────────────────────

type Item = SyncableMeta & { value?: string };

function makeTable(
  initial: Item[] = [],
): SyncableStoreTable<Item> & { _db: Map<string, Item> } {
  const db = new Map<string, Item>(initial.map((i) => [i.id, i]));

  const findMany = async (query?: {
    where?: Record<string, unknown>;
    deleted?: true;
    orderBy?: Record<string, 'asc' | 'desc'>;
    limit?: number;
    offset?: number;
  }): Promise<Item[]> => {
    let rows = [...db.values()];
    const where = query?.where;
    if (where) {
      const updatedAt = where.updatedAt as
        | { $gte?: Date; $lte?: Date }
        | undefined;
      if (updatedAt) {
        if (updatedAt.$gte)
          rows = rows.filter((r) => r.updatedAt >= updatedAt.$gte!);
        if (updatedAt.$lte)
          rows = rows.filter((r) => r.updatedAt <= updatedAt.$lte!);
      }

      const syncedAt = where.syncedAt as
        | { $gte?: Date; $lte?: Date }
        | undefined;
      if (syncedAt) {
        const t = (r: Item) => r.syncedAt ?? r.updatedAt;
        if (syncedAt.$gte) rows = rows.filter((r) => t(r) >= syncedAt.$gte!);
        if (syncedAt.$lte) rows = rows.filter((r) => t(r) <= syncedAt.$lte!);
      }

      const idFilter = where.id as { $in?: string[] } | undefined;
      if (idFilter?.$in) {
        const set = new Set(idFilter.$in);
        rows = rows.filter((r) => set.has(r.id));
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
    data: Item[],
    _options?: { sync?: boolean },
  ): Promise<Item[]> => {
    for (const item of data) db.set(item.id, item);
    return data.map((i) => ({ ...i }));
  };

  return { _db: db, findMany, upsertMany };
}

// ─── Timestamps ───────────────────────────────────────────────────────────────

const t0 = new Date('2024-01-01T00:00:00Z');
const t1 = new Date('2024-01-01T01:00:00Z');
const t2 = new Date('2024-01-01T02:00:00Z');
const t3 = new Date('2024-01-01T03:00:00Z');
const t4 = new Date('2024-01-01T04:00:00Z');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sync', () => {
  describe('empty delta (no incoming items)', () => {
    it('returns all server records updatedAt in [from, to]', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t1, value: 'A' },
        { id: 'b', updatedAt: t2, value: 'B' },
        { id: 'c', updatedAt: t3, value: 'C' },
      ]);

      const { delta, hasMore } = await syncOne(table, {
        from: t1,
        to: t3,
        items: [],
      });

      const ids = delta.map((r) => r.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
      expect(hasMore).toBe(false);
    });

    it('excludes server records outside the window', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t0, value: 'old' },
        { id: 'b', updatedAt: t2, value: 'in-window' },
      ]);

      const { delta } = await syncOne(table, { from: t1, to: t3, items: [] });

      expect(delta).toHaveLength(1);
      expect(delta[0]!.id).toBe('b');
    });

    it('returns empty array when no records in window', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t0 }]);
      const { delta } = await syncOne(table, { from: t1, to: t3, items: [] });
      expect(delta).toEqual([]);
    });

    it('does not call upsertMany when items is empty', async () => {
      const table = makeTable();
      const spy = vi.spyOn(table, 'upsertMany');
      await syncOne(table, { from: t1, to: t3, items: [] });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('new records (not on server)', () => {
    it('accepts and stores records the server does not have', async () => {
      const table = makeTable();

      await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'new', updatedAt: t1, value: 'X' }],
      });

      expect(table._db.get('new')).toMatchObject({ id: 'new', value: 'X' });
    });

    it('does not return accepted new records in the outbound delta', async () => {
      const table = makeTable();

      const { delta } = await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'new', updatedAt: t1, value: 'X' }],
      });

      expect(delta.find((r) => r.id === 'new')).toBeUndefined();
    });
  });

  describe('LWW — client wins', () => {
    it('accepts incoming record when client updatedAt > server updatedAt', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t1, value: 'old' }]);

      await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t2, value: 'new' }],
      });

      expect(table._db.get('a')!.value).toBe('new');
    });

    it('does not return client-win records in outbound delta', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t1, value: 'old' }]);

      const { delta } = await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t2, value: 'new' }],
      });

      expect(delta.find((r) => r.id === 'a')).toBeUndefined();
    });

    it('accepts incoming record when client updatedAt equals server updatedAt (offline-first tie-break)', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t2, value: 'server' }]);

      await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t2, value: 'client' }],
      });

      // client wins on equal timestamps (offline-first policy: >= instead of >)
      expect(table._db.get('a')!.value).toBe('client');
    });

    it('does not return client-win record in outbound delta when timestamps are equal', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t2, value: 'server' }]);

      const { delta } = await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t2, value: 'client' }],
      });

      expect(delta.find((r) => r.id === 'a')).toBeUndefined();
    });
  });

  describe('LWW — server wins', () => {
    it('does not overwrite server when server updatedAt > client updatedAt', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t2, value: 'server' }]);

      await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t1, value: 'stale-client' }],
      });

      expect(table._db.get('a')!.value).toBe('server');
    });

    it('always returns server-win record in outbound delta', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t2, value: 'server' }]);

      const { delta } = await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t1, value: 'stale-client' }],
      });

      const found = delta.find((r) => r.id === 'a');
      expect(found).toBeDefined();
      expect(found!.value).toBe('server');
    });

    it('includes server-win even when its updatedAt predates `from`', async () => {
      // Client sends a stale version of a very old record.
      // The server-win result should still be returned even though
      // its updatedAt (t0) is before from (t2).
      const table = makeTable([{ id: 'old', updatedAt: t0, value: 'server' }]);

      const { delta } = await syncOne(table, {
        from: t2,
        to: t4,
        items: [
          { id: 'old', updatedAt: new Date(t0.getTime() - 1), value: 'stale' },
        ],
      });

      expect(delta.find((r) => r.id === 'old')).toBeDefined();
    });
  });

  describe('conflict resolution: server-wins', () => {
    it('always keeps server value even when client is newer', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t1, value: 'server' }]);

      await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t2, value: 'newer-client' }],
        conflictResolution: 'server-wins',
      });

      expect(table._db.get('a')!.value).toBe('server');
    });

    it('returns server record in outbound delta when client is newer', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t1, value: 'server' }]);

      const { delta } = await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t2, value: 'newer-client' }],
        conflictResolution: 'server-wins',
      });

      const found = delta.find((r) => r.id === 'a');
      expect(found).toBeDefined();
      expect(found!.value).toBe('server');
    });

    it('accepts client record when no server version exists', async () => {
      const table = makeTable([]);

      await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'new', updatedAt: t1, value: 'client' }],
        conflictResolution: 'server-wins',
      });

      expect(table._db.get('new')!.value).toBe('client');
    });
  });

  describe('conflict resolution: client-wins', () => {
    it('always accepts client value even when server is newer', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t2, value: 'newer-server' },
      ]);

      await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t1, value: 'client' }],
        conflictResolution: 'client-wins',
      });

      expect(table._db.get('a')!.value).toBe('client');
    });

    it('does not return client-win record in outbound delta', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t2, value: 'newer-server' },
      ]);

      const { delta } = await syncOne(table, {
        from: t0,
        to: t3,
        items: [{ id: 'a', updatedAt: t1, value: 'client' }],
        conflictResolution: 'client-wins',
      });

      expect(delta.find((r) => r.id === 'a')).toBeUndefined();
    });
  });

  describe('server-only changes', () => {
    it('returns server records in window that the client did not send', async () => {
      const table = makeTable([
        { id: 'server-only', updatedAt: t2, value: 'S' },
      ]);

      const { delta } = await syncOne(table, {
        from: t1,
        to: t3,
        items: [{ id: 'different', updatedAt: t2, value: 'C' }],
      });

      expect(delta.find((r) => r.id === 'server-only')).toBeDefined();
    });

    it('does not return server records outside the window', async () => {
      const table = makeTable([
        { id: 'old-server', updatedAt: t0, value: 'old' },
        { id: 'in-window', updatedAt: t2, value: 'new' },
      ]);

      const { delta } = await syncOne(table, {
        from: t1,
        to: t3,
        items: [{ id: 'unrelated', updatedAt: t2 }],
      });

      expect(delta.find((r) => r.id === 'old-server')).toBeUndefined();
      expect(delta.find((r) => r.id === 'in-window')).toBeDefined();
    });
  });

  describe('mixed batch', () => {
    it('handles new, client-win, server-win, and server-only in one call', async () => {
      const table = makeTable([
        { id: 'server-wins', updatedAt: t3, value: 'sv' },
        { id: 'client-wins', updatedAt: t1, value: 'old-cv' },
        { id: 'server-only', updatedAt: t2, value: 'so' },
      ]);

      const { delta } = await syncOne(table, {
        from: t1,
        to: t3,
        items: [
          { id: 'brand-new', updatedAt: t2, value: 'new' },
          { id: 'client-wins', updatedAt: t2, value: 'new-cv' },
          { id: 'server-wins', updatedAt: t2, value: 'stale' },
        ],
      });

      // brand-new and client-wins are accepted — not in outbound
      expect(delta.find((r) => r.id === 'brand-new')).toBeUndefined();
      expect(delta.find((r) => r.id === 'client-wins')).toBeUndefined();

      // server-wins is returned with server version
      const sw = delta.find((r) => r.id === 'server-wins');
      expect(sw).toBeDefined();
      expect(sw!.value).toBe('sv');

      // server-only is returned
      expect(delta.find((r) => r.id === 'server-only')).toBeDefined();

      // server stored the right versions
      expect(table._db.get('brand-new')!.value).toBe('new');
      expect(table._db.get('client-wins')!.value).toBe('new-cv');
      expect(table._db.get('server-wins')!.value).toBe('sv');
    });
  });

  describe('outbound deduplication', () => {
    it('does not return the same record twice when it appears in both server delta and server-wins', async () => {
      // Record is in [from, to] window AND the client sent a stale version (server wins)
      const table = makeTable([{ id: 'a', updatedAt: t2, value: 'server' }]);

      const { delta } = await syncOne(table, {
        from: t1,
        to: t3,
        items: [{ id: 'a', updatedAt: t1, value: 'stale' }],
      });

      const occurrences = delta.filter((r) => r.id === 'a');
      expect(occurrences).toHaveLength(1);
    });
  });

  describe('`to` defaults to now', () => {
    it('returns records updatedAt up to the current time when `to` is omitted', async () => {
      const justNow = new Date(Date.now() - 10);
      const table = makeTable([
        { id: 'recent', updatedAt: justNow, value: 'R' },
      ]);

      const { delta } = await syncOne(table, {
        from: new Date(Date.now() - 60_000),
        items: [],
      });

      expect(delta.find((r) => r.id === 'recent')).toBeDefined();
    });
  });

  describe('upsertMany is called only when needed', () => {
    it('skips upsertMany when all incoming items are server-wins', async () => {
      const table = makeTable([{ id: 'a', updatedAt: t3, value: 'server' }]);
      const spy = vi.spyOn(table, 'upsertMany');

      await syncOne(table, {
        from: t0,
        to: t4,
        items: [{ id: 'a', updatedAt: t1, value: 'stale' }],
      });

      expect(spy).not.toHaveBeenCalled();
    });

    it('always passes { sync: true } to upsertMany', async () => {
      const table = makeTable();
      const spy = vi.spyOn(table, 'upsertMany');

      await syncOne(table, {
        from: t0,
        to: t4,
        items: [{ id: 'new', updatedAt: t1 }],
      });

      expect(spy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'new' })]),
        { sync: true },
      );
    });
  });

  describe('pagination', () => {
    it('returns hasMore: false when pageSize is not set', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t1, value: 'A' },
        { id: 'b', updatedAt: t2, value: 'B' },
      ]);

      const { delta, hasMore } = await syncOne(table, {
        from: t0,
        to: t3,
        items: [],
      });
      expect(delta).toHaveLength(2);
      expect(hasMore).toBe(false);
    });

    it('returns first page and hasMore: true when records exceed pageSize', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t1, value: 'A' },
        { id: 'b', updatedAt: t2, value: 'B' },
        { id: 'c', updatedAt: t3, value: 'C' },
      ]);

      const { delta, hasMore } = await syncOne(table, {
        from: t0,
        to: t4,
        items: [],
        pageSize: 2,
        pageOffset: 0,
      });

      expect(delta).toHaveLength(2);
      expect(hasMore).toBe(true);
      // Records are ordered by updatedAt ASC
      expect(delta[0]!.id).toBe('a');
      expect(delta[1]!.id).toBe('b');
    });

    it('returns last page and hasMore: false when records fit within pageSize', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t1, value: 'A' },
        { id: 'b', updatedAt: t2, value: 'B' },
        { id: 'c', updatedAt: t3, value: 'C' },
      ]);

      const { delta, hasMore } = await syncOne(table, {
        from: t0,
        to: t4,
        items: [],
        pageSize: 2,
        pageOffset: 2,
      });

      expect(delta).toHaveLength(1);
      expect(hasMore).toBe(false);
      expect(delta[0]!.id).toBe('c');
    });

    it('fetches all records across multiple pages', async () => {
      const table = makeTable([
        { id: 'a', updatedAt: t1, value: 'A' },
        { id: 'b', updatedAt: t2, value: 'B' },
        { id: 'c', updatedAt: t3, value: 'C' },
        { id: 'd', updatedAt: t4, value: 'D' },
      ]);

      const allRecords: Item[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const result = await syncOne(table, {
          from: t0,
          to: new Date('2024-01-01T05:00:00Z'),
          items: [],
          pageSize: 2,
          pageOffset: offset,
        });
        allRecords.push(...result.delta);
        hasMore = result.hasMore;
        offset += 2;
      }

      expect(allRecords).toHaveLength(4);
      expect(allRecords.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('syncClient loops through all pages and calls setLastSynced once', async () => {
      const store = makeTable([]);

      // Simulates a server with 5 records, pageSize=2 → 3 fetcher calls
      const serverRecords = [
        { id: 'a', updatedAt: t1, value: 'A' },
        { id: 'b', updatedAt: t2, value: 'B' },
        { id: 'c', updatedAt: t3, value: 'C' },
        { id: 'd', updatedAt: t4, value: 'D' },
        { id: 'e', updatedAt: new Date('2024-01-01T05:00:00Z'), value: 'E' },
      ];

      const fetcher = vi.fn(
        async ({
          pageOffset = 0,
        }: {
          from: Date;
          to: Date;
          delta: Record<string, SyncableMeta[]>;
          pageOffset: number;
        }): Promise<{
          data: Record<string, SyncableMeta[]>;
          hasMore: boolean;
          pageSize?: number;
        }> => {
          const pageSize = 2;
          const page = serverRecords.slice(
            pageOffset,
            pageOffset + pageSize + 1,
          );
          const hasMore = page.length > pageSize;
          if (hasMore) page.pop();
          return { data: { items: page }, hasMore, pageSize };
        },
      );

      const { syncedTo } = await syncClient({ items: store }, new Date(0), {
        fetcher,
      });

      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(syncedTo).toBeInstanceOf(Date);
      expect(store._db.size).toBe(5);
    });
  });
});

// ─── syncParamsSchema ────────────────────────────────────────────────────────

describe('syncParamsSchema', () => {
  const base = {
    current: '2024-01-01T00:00:00Z',
    from: '2024-01-01T00:00:00Z',
    to: '2024-01-01T01:00:00Z',
    delta: {},
  };

  it('parses valid input and coerces ISO strings to Dates', () => {
    const result = syncParamsSchema.parse(base);
    expect(result.current).toBeInstanceOf(Date);
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
  });

  it('accepts delta with records', () => {
    const result = syncParamsSchema.parse({
      ...base,
      delta: { users: [{ id: 'u1', updatedAt: '2024-01-01T00:00:00Z' }] },
    });
    expect(result.delta.users![0]!.updatedAt).toBeInstanceOf(Date);
  });

  it('accepts pageOffset as optional non-negative integer', () => {
    expect(() =>
      syncParamsSchema.parse({ ...base, pageOffset: 0 }),
    ).not.toThrow();
    expect(() => syncParamsSchema.parse({ ...base, pageOffset: -1 })).toThrow();
  });

  it('accepts valid conflictResolution values', () => {
    for (const v of ['lww', 'server-wins', 'client-wins'] as const) {
      expect(() =>
        syncParamsSchema.parse({ ...base, conflictResolution: v }),
      ).not.toThrow();
    }
  });

  it('rejects invalid conflictResolution', () => {
    expect(() =>
      syncParamsSchema.parse({ ...base, conflictResolution: 'newest' }),
    ).toThrow();
  });

  it('omits to when not provided', () => {
    const result = syncParamsSchema.parse({
      current: base.current,
      from: base.from,
      delta: {},
    });
    expect(result.to).toBeUndefined();
  });

  it('rejects missing required fields', () => {
    expect(() =>
      syncParamsSchema.parse({ from: base.from, delta: {} }),
    ).toThrow();
    expect(() =>
      syncParamsSchema.parse({ current: base.current, delta: {} }),
    ).toThrow();
  });
});

// ─── syncableMetaSchema ───────────────────────────────────────────────────────

describe('syncableMetaSchema', () => {
  it('parses id and updatedAt, coercing date from ISO string', () => {
    const result = syncableMetaSchema.parse({
      id: 'x',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    expect(result.id).toBe('x');
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('coerces syncedAt from ISO string when present', () => {
    const result = syncableMetaSchema.parse({
      id: 'x',
      updatedAt: '2024-01-01T00:00:00Z',
      syncedAt: '2024-01-01T01:00:00Z',
    });
    expect(result.syncedAt).toBeInstanceOf(Date);
  });

  it('passes through extra fields via .loose()', () => {
    const result = syncableMetaSchema.parse({
      id: 'x',
      updatedAt: '2024-01-01T00:00:00Z',
      value: 'extra',
      count: 42,
    }) as Record<string, unknown>;
    expect(result.value).toBe('extra');
    expect(result.count).toBe(42);
  });

  it('rejects missing id', () => {
    expect(() =>
      syncableMetaSchema.parse({ updatedAt: '2024-01-01T00:00:00Z' }),
    ).toThrow();
  });
});

// ─── conflictResolutionSchema ─────────────────────────────────────────────────

describe('conflictResolutionSchema', () => {
  it('accepts all three valid values', () => {
    expect(conflictResolutionSchema.parse('lww')).toBe('lww');
    expect(conflictResolutionSchema.parse('server-wins')).toBe('server-wins');
    expect(conflictResolutionSchema.parse('client-wins')).toBe('client-wins');
  });

  it('rejects invalid values', () => {
    expect(() => conflictResolutionSchema.parse('random')).toThrow();
    expect(() => conflictResolutionSchema.parse('')).toThrow();
  });
});

// ─── batchSize ────────────────────────────────────────────────────────────────

describe('sync — batchSize', () => {
  it('splits upsertMany into chunks when batchSize is set', async () => {
    const table = makeTable();
    const spy = vi.spyOn(table, 'upsertMany');

    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      updatedAt: t1,
      value: `v${i}`,
    }));

    await sync(
      { t: table },
      { current: new Date(), from: t0, to: t4, delta: { t: items } },
      { batchSize: 2 },
    );

    // 5 items with batchSize=2 → 3 calls (2+2+1)
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('uses a single upsertMany call when batchSize is not set', async () => {
    const table = makeTable();
    const spy = vi.spyOn(table, 'upsertMany');

    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      updatedAt: t1,
    }));

    await sync(
      { t: table },
      { current: new Date(), from: t0, to: t4, delta: { t: items } },
    );

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ─── skip option ─────────────────────────────────────────────────────────────

describe('sync — skip option', () => {
  it('excludes tables listed in skip from sync', async () => {
    const users = makeTable([{ id: 'u1', updatedAt: t1, value: 'A' }]);
    const settings = makeTable([{ id: 's1', updatedAt: t1, value: 'S' }]);
    const spySettings = vi.spyOn(settings, 'findMany');

    const result = await sync(
      { users, settings },
      { current: new Date(), from: t0, to: t4, delta: {} },
      { skip: ['settings'] },
    );

    expect(spySettings).not.toHaveBeenCalled();
    expect(result.data.users).toBeDefined();
    expect(result.data.settings).toBeUndefined();
  });

  it('syncs all tables when skip is empty', async () => {
    const a = makeTable([{ id: '1', updatedAt: t1 }]);
    const b = makeTable([{ id: '2', updatedAt: t1 }]);

    const result = await sync(
      { a, b },
      { current: new Date(), from: t0, to: t4, delta: {} },
      { skip: [] },
    );

    expect(result.data.a).toBeDefined();
    expect(result.data.b).toBeDefined();
  });
});

// ─── multi-table sync ─────────────────────────────────────────────────────────

describe('sync — multi-table', () => {
  it('syncs multiple tables independently in one call', async () => {
    const users = makeTable([{ id: 'u1', updatedAt: t2, value: 'Alice' }]);
    const posts = makeTable([{ id: 'p1', updatedAt: t2, value: 'Hello' }]);

    const result = await sync(
      { users, posts },
      {
        current: new Date(),
        from: t1,
        to: t3,
        delta: {
          users: [{ id: 'u2', updatedAt: t2, value: 'Bob' }],
          posts: [],
        },
      },
    );

    // u2 written to users, u1 in window → returned in delta
    expect(users._db.has('u2')).toBe(true);
    expect(result.data.users!.find((r) => r.id === 'u1')).toBeDefined();
    // p1 in window → returned
    expect(result.data.posts!.find((r) => r.id === 'p1')).toBeDefined();
  });

  it('hasMore is true when any table has more records', async () => {
    const a = makeTable([
      { id: 'a1', updatedAt: t1 },
      { id: 'a2', updatedAt: t2 },
      { id: 'a3', updatedAt: t3 },
    ]);
    const b = makeTable([{ id: 'b1', updatedAt: t1 }]);

    const result = await sync(
      { a, b },
      { current: new Date(), from: t0, to: t4, delta: {} },
      { pageSize: 2 },
    );

    expect(result.hasMore).toBe(true);
  });
});

// ─── syncClient ───────────────────────────────────────────────────────────────

describe('syncClient', () => {
  it('returns syncedTo as a Date close to now', async () => {
    const store = makeTable([]);
    const fetcher = vi.fn(async () => ({ data: {}, hasMore: false }));
    const before = new Date();

    const { syncedTo } = await syncClient({ items: store }, t0, { fetcher });

    expect(syncedTo).toBeInstanceOf(Date);
    expect(syncedTo.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('single-page: fetcher called once, records written locally', async () => {
    const store = makeTable([]);
    const serverRow = { id: 's1', updatedAt: t1 };
    const fetcher = vi.fn(async () => ({
      data: { items: [serverRow] },
      hasMore: false,
    }));

    await syncClient({ items: store }, t0, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store._db.has('s1')).toBe(true);
  });

  it('sends full client delta on page 0', async () => {
    const store = makeTable([{ id: 'local', updatedAt: t1 }]);
    let captured: Parameters<SyncClientParams['fetcher']>[0] | undefined;
    const fetcher = vi.fn(
      async (p: Parameters<SyncClientParams['fetcher']>[0]) => {
        captured = p;
        return { data: {}, hasMore: false };
      },
    );

    await syncClient({ items: store }, t0, { fetcher });

    expect(captured!.pageOffset).toBe(0);
    expect(
      (captured!.delta.items as SyncableMeta[]).find((r) => r.id === 'local'),
    ).toBeDefined();
  });

  it('sends empty delta on subsequent pages', async () => {
    const store = makeTable([{ id: 'local', updatedAt: t1 }]);
    const calls: Parameters<SyncClientParams['fetcher']>[0][] = [];
    let callCount = 0;
    const fetcher = vi.fn(
      async (p: Parameters<SyncClientParams['fetcher']>[0]) => {
        calls.push(p);
        callCount++;
        return { data: {}, hasMore: callCount < 2, pageSize: 1 };
      },
    );

    await syncClient({ items: store }, t0, { fetcher });

    const secondCall = calls[1]!;
    expect(
      Object.keys(secondCall.delta).length === 0 ||
        Object.values(secondCall.delta).every(
          (v) => (v as unknown[]).length === 0,
        ),
    ).toBe(true);
  });

  it('forwards conflictResolution to the fetcher', async () => {
    const store = makeTable([]);
    let captured: Parameters<SyncClientParams['fetcher']>[0] | undefined;
    const fetcher = vi.fn(
      async (p: Parameters<SyncClientParams['fetcher']>[0]) => {
        captured = p;
        return { data: {}, hasMore: false };
      },
    );

    await syncClient({ items: store }, t0, {
      fetcher,
      conflictResolution: 'server-wins',
    });

    expect(captured!.conflictResolution).toBe('server-wins');
  });

  it('excludes settings table by default', async () => {
    const items = makeTable([{ id: 'i1', updatedAt: t1 }]);
    const settings = makeTable([{ id: 's1', updatedAt: t1 }]);
    const spySettings = vi.spyOn(settings, 'findMany');
    let captured: Parameters<SyncClientParams['fetcher']>[0] | undefined;
    const fetcher = vi.fn(
      async (p: Parameters<SyncClientParams['fetcher']>[0]) => {
        captured = p;
        return { data: {}, hasMore: false };
      },
    );

    await syncClient({ items, settings }, t0, { fetcher });

    expect(spySettings).not.toHaveBeenCalled();
    expect(captured!.delta.settings).toBeUndefined();
  });

  it('splits server rows into batches via batchSize', async () => {
    const store = makeTable([]);
    const spy = vi.spyOn(store, 'upsertMany');

    const serverRows: SyncableMeta[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      updatedAt: t1,
    }));
    const fetcher = vi.fn(async () => ({
      data: { items: serverRows },
      hasMore: false as const,
    }));

    await syncClient({ items: store }, t0, { fetcher, batchSize: 2 });

    // 5 rows, batchSize=2 → 3 upsertMany calls
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('handles fetcher returning undefined gracefully', async () => {
    const store = makeTable([]);
    const fetcher = vi.fn(async () => undefined);

    await expect(
      syncClient({ items: store }, t0, { fetcher }),
    ).resolves.toMatchObject({ syncedTo: expect.any(Date) });
  });
});
