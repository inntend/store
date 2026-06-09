import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PullClientParams } from '../../src/store/pull';
import { pull, pullClient } from '../../src/store/pull';
import type { SyncableMeta, SyncableStoreTable } from '../../src/store/utils';

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

const t1 = new Date('2024-01-01T01:00:00Z');
const t2 = new Date('2024-01-01T02:00:00Z');
const t3 = new Date('2024-01-01T03:00:00Z');

// Zod schema matching the Item type used by makeTable in these tests.
const itemSchema = z.object({
  id: z.string(),
  updatedAt: z.date(),
  syncedAt: z.date().optional(),
  value: z.string().optional(),
});
const itemSchemas = { items: itemSchema };

// ─── pull ─────────────────────────────────────────────────────────────────────

describe('pull', () => {
  it('returns records matching a where filter', async () => {
    const table = makeTable([
      { id: 'a', updatedAt: t1 },
      { id: 'b', updatedAt: t2 },
      { id: 'c', updatedAt: t3 },
    ]);

    const result = await pull(
      { items: table },
      { queries: { items: { where: { id: { $in: ['a', 'c'] } } } } },
      itemSchemas,
    );

    expect(result.data.items).toHaveLength(2);
    expect(result.data.items!.map((r) => r.id)).toEqual(
      expect.arrayContaining(['a', 'c']),
    );
    expect(result.hasMore).toBe(false);
  });

  it('respects orderBy', async () => {
    const table = makeTable([
      { id: 'a', updatedAt: t3 },
      { id: 'b', updatedAt: t1 },
      { id: 'c', updatedAt: t2 },
    ]);

    const result = await pull(
      { items: table },
      { queries: { items: { orderBy: { updatedAt: 'asc' } } } },
      itemSchemas,
    );

    expect(result.data.items!.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('respects limit and offset', async () => {
    const table = makeTable([
      { id: 'a', updatedAt: t1 },
      { id: 'b', updatedAt: t2 },
      { id: 'c', updatedAt: t3 },
      { id: 'd', updatedAt: new Date('2024-01-01T04:00:00Z') },
    ]);

    const result = await pull(
      { items: table },
      {
        queries: {
          items: { orderBy: { updatedAt: 'asc' }, limit: 2, offset: 1 },
        },
      },
      itemSchemas,
    );

    expect(result.data.items!.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('paginates with pageSize and advances via pageOffset', async () => {
    const table = makeTable([
      { id: 'a', updatedAt: t1 },
      { id: 'b', updatedAt: t2 },
      { id: 'c', updatedAt: t3 },
    ]);

    const page0 = await pull(
      { items: table },
      { queries: { items: { orderBy: { updatedAt: 'asc' } } }, pageOffset: 0 },
      itemSchemas,
      { pageSize: 2 },
    );
    expect(page0.hasMore).toBe(true);
    expect(page0.data.items).toHaveLength(2);
    expect(page0.data.items!.map((r) => r.id)).toEqual(['a', 'b']);

    const page1 = await pull(
      { items: table },
      { queries: { items: { orderBy: { updatedAt: 'asc' } } }, pageOffset: 2 },
      itemSchemas,
      { pageSize: 2 },
    );
    expect(page1.hasMore).toBe(false);
    expect(page1.data.items!.map((r) => r.id)).toEqual(['c']);
  });

  it('rejects a table name not in schemas', async () => {
    const table = makeTable([{ id: 'a', updatedAt: t1 }]);

    await expect(
      pull(
        { items: table },
        { queries: { items: {}, unknown_table: {} } },
        itemSchemas,
      ),
    ).rejects.toThrow();
  });

  it('strips unknown field names in where (safe — query runs without that filter)', async () => {
    const table = makeTable([
      { id: 'a', updatedAt: t1 },
      { id: 'b', updatedAt: t2 },
    ]);

    // nonexistent_field is stripped by Zod — query runs without that filter
    const result = await pull(
      { items: table },
      { queries: { items: { where: { nonexistent_field: { $eq: 'x' } } } } },
      itemSchemas,
    );

    // All records returned — the unknown field filter was silently dropped
    expect(result.data.items).toHaveLength(2);
  });

  it('strips wrong operator types (safe — the filter is dropped, not injected)', async () => {
    const table = makeTable([{ id: 'a', updatedAt: t1 }]);

    // id is a string — $gt is a number operator, gets stripped by StringFilterSchema
    const result = await pull(
      { items: table },
      { queries: { items: { where: { id: { $gt: 42 } } } } },
      itemSchemas,
    );

    expect(result.data.items).toHaveLength(1);
  });

  it('returns hasMore true when any table exceeds pageSize', async () => {
    const a = makeTable([
      { id: 'a1', updatedAt: t1 },
      { id: 'a2', updatedAt: t2 },
      { id: 'a3', updatedAt: t3 },
    ]);
    const b = makeTable([{ id: 'b1', updatedAt: t1 }]);
    const schemas = { a: itemSchema, b: itemSchema };

    const result = await pull(
      { a, b },
      { queries: { a: { orderBy: { updatedAt: 'asc' } }, b: {} } },
      schemas,
      { pageSize: 2 },
    );

    expect(result.hasMore).toBe(true);
    expect(result.data.a).toHaveLength(2);
  });
});

// ─── pullClient ───────────────────────────────────────────────────────────────

describe('pullClient', () => {
  it('writes server records into the local store', async () => {
    const store = makeTable([]);
    const serverRows: SyncableMeta[] = [
      { id: 'x', updatedAt: t1 },
      { id: 'y', updatedAt: t2 },
    ];
    const fetcher = vi.fn(async () => ({
      data: { items: serverRows },
      hasMore: false as const,
    }));

    await pullClient({ items: store }, { fetcher, queries: { items: {} } });

    expect(store._db.size).toBe(2);
    expect(store._db.get('x')?.id).toBe('x');
  });

  it('deduplicates by upserting — existing records are overwritten', async () => {
    const existing: Item = { id: 'a', updatedAt: t1, value: 'old' };
    const store = makeTable([existing]);
    const serverRow: Item = { id: 'a', updatedAt: t2, value: 'new' };
    const fetcher = vi.fn(async () => ({
      data: { items: [serverRow] },
      hasMore: false as const,
    }));

    await pullClient({ items: store }, { fetcher, queries: { items: {} } });

    expect(store._db.size).toBe(1);
    expect((store._db.get('a') as Item)?.value).toBe('new');
  });

  it('paginates until hasMore is false', async () => {
    const store = makeTable([]);
    const pages = [
      {
        data: { items: [{ id: 'a', updatedAt: t1 }] },
        hasMore: true,
        pageSize: 1,
      },
      {
        data: { items: [{ id: 'b', updatedAt: t2 }] },
        hasMore: true,
        pageSize: 1,
      },
      {
        data: { items: [{ id: 'c', updatedAt: t3 }] },
        hasMore: false,
        pageSize: 1,
      },
    ];
    const fetcher = vi.fn(async () => pages.shift()!);

    await pullClient({ items: store }, { fetcher, queries: { items: {} } });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(store._db.size).toBe(3);
  });

  it('advances pageOffset correctly across pages', async () => {
    const store = makeTable([]);
    const calls: number[] = [];
    const fetcher: PullClientParams['fetcher'] = async (p) => {
      calls.push(p.pageOffset);
      const done = p.pageOffset >= 2;
      return { data: {}, hasMore: !done, pageSize: 1 };
    };

    await pullClient({ items: store }, { fetcher, queries: { items: {} } });

    expect(calls).toEqual([0, 1, 2]);
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

    await pullClient(
      { items: store },
      { fetcher, queries: { items: {} }, batchSize: 2 },
    );

    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('skips tables in result that are not in the local store', async () => {
    const store = makeTable([]);
    const fetcher = vi.fn(async () => ({
      data: {
        items: [{ id: 'a', updatedAt: t1 }],
        ghost: [{ id: 'z', updatedAt: t1 }],
      },
      hasMore: false as const,
    }));

    await pullClient(
      { items: store },
      { fetcher, queries: { items: {}, ghost: {} } },
    );

    expect(store._db.size).toBe(1);
  });

  it('handles fetcher returning undefined gracefully', async () => {
    const store = makeTable([]);
    const fetcher = vi.fn(async () => undefined);

    await expect(
      pullClient({ items: store }, { fetcher, queries: { items: {} } }),
    ).resolves.toEqual({ items: [] });
  });
});
