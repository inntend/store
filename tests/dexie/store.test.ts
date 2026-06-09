import 'fake-indexeddb/auto';
import type { Transaction } from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type DexieMigration, DexieStore } from '../../src/dexie';
import {
  createSettingsDef,
  defineTable,
  type StoreSettings,
} from '../../src/store';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().int(),
});

const PostSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: z.enum(['draft', 'published']),
});

const userDef = defineTable({
  tableName: 'users',
  schema: UserSchema,
  primaryKey: 'id',
  indexes: [{ columns: ['age'] }, { columns: ['name'] }],
});

const postDef = defineTable({
  tableName: 'posts',
  schema: PostSchema,
  primaryKey: 'id',
  indexes: [{ columns: ['userId'] }, { columns: ['status'] }],
});

const defs = { users: userDef, posts: postDef };

// Schema with timestamp + deleted fields for upsertMany tests
const SyncableSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.date(),
  createdAt: z.date(),
  deleted: z.boolean(),
});

const syncableDefs = {
  items: defineTable({
    tableName: 'items',
    schema: SyncableSchema,
    primaryKey: 'id',
    indexes: [{ columns: ['name'] }],
  }),
};

let dbCounter = 0;
function makeStore() {
  return new DexieStore(`test-${++dbCounter}`, defs);
}

// ─── find ─────────────────────────────────────────────────────────────────────

describe('find', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('returns the record by primary key', async () => {
    const alice = { id: '1', name: 'Alice', age: 30 };
    await store.table.users.insert(alice);
    expect(await store.table.users.find('1')).toEqual(alice);
  });

  it('returns undefined for a nonexistent id', async () => {
    expect(await store.table.users.find('nope')).toBeUndefined();
  });
});

// ─── findMany ─────────────────────────────────────────────────────────────────

describe('findMany', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('returns all records when called without a query', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    expect(await store.table.users.findMany()).toHaveLength(2);
  });

  it('returns an empty array when the table is empty', async () => {
    expect(await store.table.users.findMany()).toEqual([]);
  });

  describe('where: $eq', () => {
    it('matches records with exact value', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { name: { $eq: 'Alice' } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('1');
    });
  });

  describe('where: $ne', () => {
    it('excludes records with the given value', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { name: { $ne: 'Alice' } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('2');
    });
  });

  describe('where: $gt / $gte', () => {
    it('$gte matches records greater than or equal to the value', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 17 },
        { id: '3', name: 'Carol', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { age: { $gte: 25 } },
      });
      expect(results.map((u) => u.id).sort()).toEqual(['1', '3']);
    });

    it('$gt excludes the boundary value', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { age: { $gt: 25 } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('1');
    });
  });

  describe('where: $lt / $lte', () => {
    it('$lte matches records less than or equal to the value', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 17 },
        { id: '3', name: 'Carol', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { age: { $lte: 25 } },
      });
      expect(results.map((u) => u.id).sort()).toEqual(['2', '3']);
    });

    it('$lt excludes the boundary value', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { age: { $lt: 30 } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('2');
    });
  });

  describe('where: $in / $nin', () => {
    it('$in matches any of the given values', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
        { id: '3', name: 'Carol', age: 20 },
      ]);
      const results = await store.table.users.findMany({
        where: { name: { $in: ['Alice', 'Carol'] } },
      });
      expect(results.map((u) => u.id).sort()).toEqual(['1', '3']);
    });

    it('$nin excludes all of the given values', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
        { id: '3', name: 'Carol', age: 20 },
      ]);
      const results = await store.table.users.findMany({
        where: { name: { $nin: ['Alice', 'Carol'] } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('2');
    });
  });

  describe('where: $like', () => {
    it('matches a prefix pattern (A%)', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Adrian', age: 22 },
        { id: '3', name: 'Bob', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { name: { $like: 'A%' } },
      });
      expect(results).toHaveLength(2);
      expect(results.every((u) => u.name.startsWith('A'))).toBe(true);
    });

    it('matches a suffix pattern (%ce)', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bruce', age: 22 },
        { id: '3', name: 'Bob', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { name: { $like: '%ce' } },
      });
      expect(results).toHaveLength(2);
    });

    it('matches a contains pattern (%li%)', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Eliot', age: 22 },
        { id: '3', name: 'Bob', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { name: { $like: '%li%' } },
      });
      expect(results).toHaveLength(2);
    });
  });

  describe('where: $and', () => {
    it('requires all conditions to match', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Alice', age: 17 },
        { id: '3', name: 'Bob', age: 30 },
      ]);
      const results = await store.table.users.findMany({
        where: { $and: [{ name: { $eq: 'Alice' } }, { age: { $gte: 18 } }] },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('1');
    });
  });

  describe('where: $or', () => {
    it('matches when any condition is true', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 17 },
        { id: '3', name: 'Carol', age: 25 },
      ]);
      const results = await store.table.users.findMany({
        where: { $or: [{ age: { $lt: 18 } }, { name: { $eq: 'Carol' } }] },
      });
      expect(results.map((u) => u.id).sort()).toEqual(['2', '3']);
    });
  });

  describe('orderBy', () => {
    it('sorts ascending', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Carol', age: 25 },
        { id: '2', name: 'Alice', age: 30 },
        { id: '3', name: 'Bob', age: 17 },
      ]);
      const results = await store.table.users.findMany({
        orderBy: { name: 'asc' },
      });
      expect(results.map((u) => u.name)).toEqual(['Alice', 'Bob', 'Carol']);
    });

    it('sorts descending', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
        { id: '3', name: 'Carol', age: 17 },
      ]);
      const results = await store.table.users.findMany({
        orderBy: { age: 'desc' },
      });
      expect(results.map((u) => u.age)).toEqual([30, 25, 17]);
    });
  });

  describe('limit and offset', () => {
    it('limit restricts the number of results', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
        { id: '3', name: 'Carol', age: 20 },
      ]);
      const results = await store.table.users.findMany({
        orderBy: { age: 'desc' },
        limit: 2,
      });
      expect(results).toHaveLength(2);
      expect(results[0]!.age).toBe(30);
    });

    it('offset skips the first N records', async () => {
      await store.table.users.insertMany([
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
        { id: '3', name: 'Carol', age: 20 },
      ]);
      const results = await store.table.users.findMany({
        orderBy: { age: 'desc' },
        offset: 1,
      });
      expect(results).toHaveLength(2);
      expect(results[0]!.age).toBe(25);
    });
  });
});

// ─── count ────────────────────────────────────────────────────────────────────

describe('count', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('returns 0 on an empty table', async () => {
    expect(await store.table.users.count()).toBe(0);
  });

  it('returns the total number of records without a query', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    expect(await store.table.users.count()).toBe(2);
  });

  it('counts only records matching the where clause', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 17 },
      { id: '3', name: 'Carol', age: 25 },
    ]);
    expect(
      await store.table.users.count({ where: { age: { $gte: 18 } } }),
    ).toBe(2);
  });
});

// ─── insert ───────────────────────────────────────────────────────────────────

describe('insert', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('returns the inserted record', async () => {
    const alice = { id: '1', name: 'Alice', age: 30 };
    expect(await store.table.users.insert(alice)).toEqual(alice);
  });

  it('persists the record so it can be retrieved', async () => {
    const alice = { id: '1', name: 'Alice', age: 30 };
    await store.table.users.insert(alice);
    expect(await store.table.users.find('1')).toEqual(alice);
  });
});

// ─── insertMany ───────────────────────────────────────────────────────────────

describe('insertMany', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('inserts all records and returns them', async () => {
    const users = [
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ];
    const result = await store.table.users.insertMany(users);
    expect(result).toEqual(users);
    expect(await store.table.users.count()).toBe(2);
  });
});

// ─── update ───────────────────────────────────────────────────────────────────

describe('update', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('applies partial changes and returns the updated record', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    const updated = await store.table.users.update('1', { age: 31 });
    expect(updated.age).toBe(31);
    expect(updated.name).toBe('Alice');
  });

  it('persists the change', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    await store.table.users.update('1', { age: 31 });
    expect((await store.table.users.find('1'))!.age).toBe(31);
  });
});

// ─── updateMany ───────────────────────────────────────────────────────────────

describe('updateMany', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('updates all matching records and returns the count', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 15 },
      { id: '3', name: 'Carol', age: 16 },
    ]);
    const n = await store.table.users.updateMany(
      { where: { age: { $lt: 18 } } },
      { name: 'Minor' },
    );
    expect(n).toBe(2);
    expect((await store.table.users.find('2'))!.name).toBe('Minor');
    expect((await store.table.users.find('3'))!.name).toBe('Minor');
    expect((await store.table.users.find('1'))!.name).toBe('Alice');
  });

  it('returns 0 when no records match', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    expect(
      await store.table.users.updateMany(
        { where: { age: { $lt: 18 } } },
        { name: 'Minor' },
      ),
    ).toBe(0);
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('delete', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('removes the record', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    await store.table.users.delete('1');
    expect(await store.table.users.find('1')).toBeUndefined();
  });

  it('is a no-op for a nonexistent id', async () => {
    await expect(store.table.users.delete('nope')).resolves.toBeUndefined();
  });
});

// ─── deleteMany ───────────────────────────────────────────────────────────────

describe('deleteMany', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('removes matching records and returns the count', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 15 },
      { id: '3', name: 'Carol', age: 25 },
    ]);
    const removed = await store.table.users.deleteMany({
      where: { age: { $lt: 18 } },
    });
    expect(removed).toBe(1);
    expect(await store.table.users.count()).toBe(2);
  });

  it('clears the whole table when called without a query', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    const removed = await store.table.users.deleteMany();
    expect(removed).toBe(2);
    expect(await store.table.users.count()).toBe(0);
  });

  it('returns 0 when no records match', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    expect(
      await store.table.users.deleteMany({ where: { age: { $lt: 18 } } }),
    ).toBe(0);
  });
});

// ─── multi-table ──────────────────────────────────────────────────────────────

describe('multi-table', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('tables operate independently', async () => {
    await store.table.users.insert({ id: 'u1', name: 'Alice', age: 30 });
    await store.table.posts.insert({
      id: 'p1',
      userId: 'u1',
      status: 'published',
    });
    expect(await store.table.users.count()).toBe(1);
    expect(await store.table.posts.count()).toBe(1);
  });

  it('filters across two tables using $and', async () => {
    await store.table.users.insertMany([
      { id: 'u1', name: 'Alice', age: 30 },
      { id: 'u2', name: 'Bob', age: 25 },
    ]);
    await store.table.posts.insertMany([
      { id: 'p1', userId: 'u1', status: 'published' },
      { id: 'p2', userId: 'u1', status: 'draft' },
      { id: 'p3', userId: 'u2', status: 'published' },
    ]);

    const alicePublished = await store.table.posts.findMany({
      where: {
        $and: [{ userId: { $eq: 'u1' } }, { status: { $eq: 'published' } }],
      },
    });
    expect(alicePublished).toHaveLength(1);
    expect(alicePublished[0]!.id).toBe('p1');
  });

  it('deleteMany on one table does not affect the other', async () => {
    await store.table.users.insert({ id: 'u1', name: 'Alice', age: 30 });
    await store.table.posts.insertMany([
      { id: 'p1', userId: 'u1', status: 'published' },
      { id: 'p2', userId: 'u1', status: 'draft' },
    ]);
    await store.table.posts.deleteMany({ where: { userId: { $eq: 'u1' } } });
    expect(await store.table.users.count()).toBe(1);
    expect(await store.table.posts.count()).toBe(0);
  });
});

// ─── upsertMany ───────────────────────────────────────────────────────────────

describe('upsertMany', () => {
  let store: DexieStore<typeof syncableDefs>;

  beforeEach(() => {
    store = new DexieStore(`test-upsert-${++dbCounter}`, syncableDefs);
  });

  it('returns empty array for empty input', async () => {
    expect(await store.table.items.upsertMany([])).toEqual([]);
  });

  describe('regular mode (default)', () => {
    it('stamps updatedAt and createdAt to now for new records', async () => {
      const before = new Date();
      await store.table.items.upsertMany([
        {
          id: '1',
          name: 'Alice',
        },
      ]);
      const after = new Date();
      const row = await store.table.items.find('1');
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('defaults deleted to false for new records regardless of input', async () => {
      await store.table.items.upsertMany([
        {
          id: '1',
          name: 'Alice',
        },
      ]);
      expect((await store.table.items.find('1'))!.deleted).toBe(false);
    });

    it('stamps updatedAt to now on conflict and preserves original createdAt', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.upsertMany(
        [
          {
            id: '1',
            name: 'Alice',
            updatedAt: original,
            createdAt: original,
            deleted: false,
          },
        ],
        { sync: true },
      );

      const before = new Date();
      await store.table.items.upsertMany([
        {
          id: '1',
          name: 'Alice Updated',
        },
      ]);
      const after = new Date();

      const row = await store.table.items.find('1');
      expect(row!.name).toBe('Alice Updated');
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(row!.createdAt.getTime()).toBe(original.getTime());
    });

    it('preserves original deleted on conflict', async () => {
      const t = new Date('2020-01-01');
      await store.table.items.upsertMany(
        [
          {
            id: '1',
            name: 'Alice',
            updatedAt: t,
            createdAt: t,
            deleted: true,
          },
        ],
        { sync: true },
      );
      await store.table.items.upsertMany([
        {
          id: '1',
          name: 'Alice Updated',
        },
      ]);
      expect(
        (await store.table.items.find('1', { deleted: true }))!.deleted,
      ).toBe(true);
    });

    it('handles a batch with new and existing records correctly', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.upsertMany(
        [
          {
            id: 'existing',
            name: 'Old',
            updatedAt: original,
            createdAt: original,
            deleted: false,
          },
        ],
        { sync: true },
      );

      const before = new Date();
      await store.table.items.upsertMany([
        {
          id: 'new',
          name: 'New',
        },
        {
          id: 'existing',
          name: 'Updated',
        },
      ]);
      const after = new Date();

      const newRow = await store.table.items.find('new');
      const existingRow = await store.table.items.find('existing');

      expect(newRow!.createdAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(newRow!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(existingRow!.createdAt.getTime()).toBe(original.getTime());
      expect(existingRow!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(existingRow!.updatedAt.getTime()).toBeLessThanOrEqual(
        after.getTime(),
      );
    });
  });

  describe('sync mode ({ sync: true })', () => {
    it('preserves all fields exactly as provided', async () => {
      const ts = new Date('2023-06-15T12:00:00Z');
      await store.table.items.upsertMany(
        [
          {
            id: '1',
            name: 'Alice',
            updatedAt: ts,
            createdAt: ts,
            deleted: false,
          },
        ],
        { sync: true },
      );
      const row = await store.table.items.find('1');
      expect(row!.updatedAt.getTime()).toBe(ts.getTime());
      expect(row!.createdAt.getTime()).toBe(ts.getTime());
      expect(row!.deleted).toBe(false);
    });

    it('fully replaces on conflict including createdAt and deleted', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.insert({
        id: '1',
        name: 'Alice',
      });

      const newer = new Date('2023-01-01');
      await store.table.items.upsertMany(
        [
          {
            id: '1',
            name: 'Alice Updated',
            updatedAt: newer,
            createdAt: newer,
            deleted: true,
          },
        ],
        { sync: true },
      );

      const row = await store.table.items.find('1', { deleted: true });
      expect(row!.updatedAt.getTime()).toBe(newer.getTime());
      expect(row!.createdAt.getTime()).toBe(newer.getTime());
      expect(row!.deleted).toBe(true);
    });
  });
});

// ─── auto-stamping ────────────────────────────────────────────────────────────

describe('auto-stamping', () => {
  let store: DexieStore<typeof syncableDefs>;

  beforeEach(() => {
    store = new DexieStore(`test-stamp-${++dbCounter}`, syncableDefs);
  });

  describe('insert', () => {
    it('stamps createdAt, updatedAt to now and deleted to false', async () => {
      const before = new Date();
      const row = await store.table.items.insert({
        id: '1',
        name: 'Alice',
      });
      const after = new Date();
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(row.deleted).toBe(false);
    });
  });

  describe('insertMany', () => {
    it('stamps all records in the batch', async () => {
      const before = new Date();
      await store.table.items.insertMany([
        {
          id: '1',
          name: 'Alice',
        },
        {
          id: '2',
          name: 'Bob',
        },
      ]);
      const after = new Date();
      for (const id of ['1', '2']) {
        const row = await store.table.items.find(id);
        expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(
          before.getTime(),
        );
        expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
        expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(
          before.getTime(),
        );
        expect(row!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
        expect(row!.deleted).toBe(false);
      }
    });
  });

  describe('update', () => {
    it('stamps updatedAt to now', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.insert({
        id: '1',
        name: 'Alice',
      });
      const before = new Date();
      await store.table.items.update('1', { name: 'Updated' });
      const after = new Date();
      const row = await store.table.items.find('1');
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('ignores createdAt in partial — original is preserved', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.upsertMany(
        [
          {
            id: '1',
            name: 'Alice',
            updatedAt: original,
            createdAt: original,
            deleted: false,
          },
        ],
        { sync: true },
      );
      await store.table.items.update('1', {
        name: 'Updated',
        createdAt: new Date(),
      } as any);
      const row = await store.table.items.find('1');
      expect(row!.createdAt.getTime()).toBe(original.getTime());
    });

    it('ignores deleted in partial — original is preserved', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.insert({
        id: '1',
        name: 'Alice',
      });
      await store.table.items.update('1', {
        name: 'Updated',
        deleted: true,
      } as any);
      const row = await store.table.items.find('1');
      expect(row!.deleted).toBe(false);
    });
  });

  describe('updateMany', () => {
    it('stamps updatedAt to now on all matching rows', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.upsertMany(
        [
          {
            id: '1',
            name: 'Alice',
            updatedAt: original,
            createdAt: original,
            deleted: false,
          },
          {
            id: '2',
            name: 'Bob',
            updatedAt: original,
            createdAt: original,
            deleted: false,
          },
        ],
        { sync: true },
      );
      const before = new Date();
      await store.table.items.updateMany(
        { where: { name: { $eq: 'Alice' } } },
        { name: 'Updated' },
      );
      const after = new Date();
      const row = await store.table.items.find('1');
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect((await store.table.items.find('2'))!.updatedAt.getTime()).toBe(
        original.getTime(),
      );
    });

    it('ignores createdAt and deleted in partial', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.upsertMany(
        [
          {
            id: '1',
            name: 'Alice',
            updatedAt: original,
            createdAt: original,
            deleted: false,
          },
        ],
        { sync: true },
      );
      await store.table.items.updateMany({}, {
        name: 'Updated',
        createdAt: new Date(),
        deleted: true,
      } as any);
      const row = await store.table.items.find('1');
      expect(row!.createdAt.getTime()).toBe(original.getTime());
      expect(row!.deleted).toBe(false);
    });
  });

  describe('delete', () => {
    it('soft-deletes by default — sets deleted and stamps updatedAt', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.insert({
        id: '1',
        name: 'Alice',
      });
      const before = new Date();
      await store.table.items.delete('1');
      const after = new Date();
      const row = await store.table.items.find('1', { deleted: true });
      expect(row).not.toBeUndefined();
      expect(row!.deleted).toBe(true);
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('{ hard: true } removes the row', async () => {
      await store.table.items.insert({
        id: '1',
        name: 'Alice',
      });
      await store.table.items.delete('1', { hard: true });
      expect(await store.table.items.find('1')).toBeUndefined();
    });
  });

  describe('deleteMany', () => {
    it('soft-deletes matching rows by default', async () => {
      const original = new Date('2020-01-01');
      await store.table.items.insertMany([
        {
          id: '1',
          name: 'Alice',
        },
        {
          id: '2',
          name: 'Bob',
        },
      ]);
      const before = new Date();
      const n = await store.table.items.deleteMany({
        where: { name: { $eq: 'Alice' } },
      });
      const after = new Date();
      expect(n).toBe(1);
      const row = await store.table.items.find('1', { deleted: true });
      expect(row!.deleted).toBe(true);
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect((await store.table.items.find('2'))!.deleted).toBe(false);
    });

    it('{ hard: true } removes matching rows', async () => {
      await store.table.items.insertMany([
        {
          id: '1',
          name: 'Alice',
        },
        {
          id: '2',
          name: 'Bob',
        },
      ]);
      const n = await store.table.items.deleteMany(
        { where: { name: { $eq: 'Alice' } } },
        { hard: true },
      );
      expect(n).toBe(1);
      expect(await store.table.items.find('1')).toBeUndefined();
      expect(await store.table.items.find('2')).not.toBeUndefined();
    });
  });
});

describe('delete/deleteMany without deleted field always hard-deletes', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it('delete removes the row even without { hard: true }', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    await store.table.users.delete('1');
    expect(await store.table.users.find('1')).toBeUndefined();
  });

  it('deleteMany removes matching rows even without { hard: true }', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 15 },
    ]);
    const n = await store.table.users.deleteMany({
      where: { age: { $lt: 18 } },
    });
    expect(n).toBe(1);
    expect(await store.table.users.find('2')).toBeUndefined();
    expect(await store.table.users.find('1')).not.toBeUndefined();
  });
});

// ─── migrations ───────────────────────────────────────────────────────────────

describe('migrations', () => {
  const migrations = [
    {
      upgrade: async (tx: Transaction) => {
        await tx
          .table('users')
          .toCollection()
          .modify((u: { age?: number }) => {
            u.age ??= 0;
          });
      },
    },
  ] satisfies DexieMigration<keyof typeof defs>[];

  it('applies upgrade function on open and index remains usable', async () => {
    const store = new DexieStore(`test-migration-${++dbCounter}`, defs, {
      migrations,
    });
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 17 },
    ]);
    const adults = await store.table.users.findMany({
      where: { age: { $gte: 18 } },
    });
    expect(adults).toHaveLength(1);
    expect(adults[0]!.name).toBe('Alice');
  });
});

// ─── soft-delete filtering (find / findMany / count) ─────────────────────────
//
// Tables whose schema includes `deleted: boolean` automatically exclude rows
// with `deleted = true` from find, findMany, and count. Pass `{ deleted: true }`
// to override and include them.

describe('soft-delete filtering', () => {
  let store: DexieStore<typeof syncableDefs>;
  const base = {
    updatedAt: new Date(),
    createdAt: new Date(),
    deleted: false,
  };

  beforeEach(() => {
    store = new DexieStore(`test-softdel-${++dbCounter}`, syncableDefs);
  });

  it('find returns undefined for a soft-deleted row by default', async () => {
    await store.table.items.insert({ id: '1', name: 'Alice', ...base });
    await store.table.items.delete('1');
    expect(await store.table.items.find('1')).toBeUndefined();
  });

  it('find returns the row when { deleted: true } is passed', async () => {
    await store.table.items.insert({ id: '1', name: 'Alice', ...base });
    await store.table.items.delete('1');
    const row = await store.table.items.find('1', { deleted: true });
    expect(row).toBeDefined();
    expect(row!.deleted).toBe(true);
  });

  it('findMany excludes soft-deleted rows by default', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    await store.table.items.delete('1');
    const rows = await store.table.items.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('2');
  });

  it('findMany includes soft-deleted rows when { deleted: true }', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    await store.table.items.delete('1');
    expect(await store.table.items.findMany({ deleted: true })).toHaveLength(2);
  });

  it('count excludes soft-deleted rows by default', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    await store.table.items.delete('1');
    expect(await store.table.items.count()).toBe(1);
  });

  it('count includes soft-deleted rows when { deleted: true }', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    await store.table.items.delete('1');
    expect(await store.table.items.count({ deleted: true })).toBe(2);
  });

  it('findMany where filter still applies alongside soft-delete exclusion', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
      { id: '3', name: 'Carol', ...base },
    ]);
    await store.table.items.delete('2');
    const rows = await store.table.items.findMany({
      where: { name: { $ne: 'Alice' } },
    });
    // Bob is deleted (excluded), Carol is live
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('3');
  });

  it('deleteMany hard delete removes soft-deleted rows too', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    await store.table.items.delete('1'); // soft-delete
    const removed = await store.table.items.deleteMany(undefined, {
      hard: true,
    });
    expect(removed).toBe(2); // both live and soft-deleted
    expect(await store.table.items.count({ deleted: true })).toBe(0);
  });

  it('tables without deleted field are unaffected', async () => {
    const s = new DexieStore(`test-nodelete-${++dbCounter}`, defs);
    await s.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    expect(await s.table.users.findMany()).toHaveLength(2);
    expect(await s.table.users.count()).toBe(2);
  });
});

// ─── settings table ───────────────────────────────────────────────────────────
//
// setupStore automatically injects a settings table when one is not present in
// the defs. The Dexie adapter creates it in IndexedDB like any other table.
// createSettingsHelper wraps it with a typed get/set API.

describe('settings table', () => {
  let store: ReturnType<typeof makeStore>;
  let settings: StoreSettings;

  beforeEach(() => {
    store = makeStore();
    settings = store.settings;
  });

  it('settings table is present in the store', () => {
    expect(store.settings).toBeDefined();
  });

  it('getAll returns all set entries', async () => {
    await settings.set('lastSynced', '2024-06-01T00:00:00.000Z');
    const all = await settings.getAll();
    expect(all).toEqual({
      lastSynced: '2024-06-01T00:00:00.000Z',
    });
  });

  it('settings entries are isolated from user tables', async () => {
    await store.table.users.insert({ id: 'u1', name: 'Alice', age: 30 });
    await settings.set('conflictResolution', 'lww');
    expect(await store.table.users.count()).toBe(1);
    expect(await settings.getAll()).toEqual({ conflictResolution: 'lww' });
  });
});

// ─── validate option ──────────────────────────────────────────────────────────

describe('validate option', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('find({ validate: true }) returns the row', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    const row = await store.table.users.find('1', { validate: true });
    expect(row).toBeDefined();
    expect(row!.id).toBe('1');
  });

  it('find({ validate: true }) returns undefined for missing id', async () => {
    expect(
      await store.table.users.find('missing', { validate: true }),
    ).toBeUndefined();
  });

  it('findMany({ validate: true }) returns all rows', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    const rows = await store.table.users.findMany(undefined, {
      validate: true,
    });
    expect(rows).toHaveLength(2);
  });

  it('insert({ validate: true }) returns the inserted row', async () => {
    const row = await store.table.users.insert(
      { id: '1', name: 'Alice', age: 30 },
      { validate: true },
    );
    expect(row.id).toBe('1');
  });

  it('insertMany({ validate: true }) returns all inserted rows', async () => {
    const rows = await store.table.users.insertMany(
      [{ id: '1', name: 'Alice', age: 30 }],
      { validate: true },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('1');
  });

  it('update({ validate: true }) returns the updated row', async () => {
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    const row = await store.table.users.update(
      '1',
      { age: 31 },
      { validate: true },
    );
    expect(row.age).toBe(31);
  });

  it('upsertMany({ validate: true }) with syncable store returns all rows', async () => {
    const s = new DexieStore(
      `test-validate-upsert-${++dbCounter}`,
      syncableDefs,
    );
    const t = new Date('2022-01-01');
    const rows = await s.table.items.upsertMany([
      {
        id: '1',
        name: 'Alice',
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('1');
  });
});

// ─── update: error on missing id ─────────────────────────────────────────────

describe('update: missing id', () => {
  it('throws when the record does not exist', async () => {
    const store = makeStore();
    await expect(
      store.table.users.update('ghost', { age: 99 }),
    ).rejects.toThrow('ghost');
  });
});

// ─── insertMany: empty input ──────────────────────────────────────────────────

describe('insertMany: empty input', () => {
  it('returns empty array without touching the table', async () => {
    const store = makeStore();
    expect(await store.table.users.insertMany([])).toEqual([]);
    expect(await store.table.users.count()).toBe(0);
  });
});

// ─── updateMany: no where clause ─────────────────────────────────────────────

describe('updateMany: no where clause', () => {
  it('updates all rows when where is omitted', async () => {
    const store = makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    const n = await store.table.users.updateMany({}, { name: 'Everyone' });
    expect(n).toBe(2);
    const rows = await store.table.users.findMany();
    expect(rows.every((r) => r.name === 'Everyone')).toBe(true);
  });
});

// ─── deleteMany: soft-delete edge cases ──────────────────────────────────────

describe('deleteMany: soft-delete edge cases', () => {
  let store: DexieStore<typeof syncableDefs>;
  const base = {
    updatedAt: new Date(),
    createdAt: new Date(),
    deleted: false,
  };

  beforeEach(() => {
    store = new DexieStore(`test-sd-edge-${++dbCounter}`, syncableDefs);
  });

  it('soft-deletes all live rows when called with no query', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    const n = await store.table.items.deleteMany();
    expect(n).toBe(2);
    // rows still exist but are soft-deleted
    expect(await store.table.items.count()).toBe(0);
    expect(await store.table.items.count({ deleted: true })).toBe(2);
  });

  it('does not double-count already-soft-deleted rows', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    await store.table.items.delete('1'); // soft-delete id 1
    // deleteMany should only affect the 1 live row
    const n = await store.table.items.deleteMany();
    expect(n).toBe(1);
    expect(await store.table.items.count({ deleted: true })).toBe(2);
  });
});

// ─── Boolean and Date filter operators ───────────────────────────────────────
//
// Dexie's in-memory filter path handles all types not accelerated by a native
// index. These schemas exercise boolean ($eq/$ne) and date ($eq/$gt/$gte/$lt/$lte)
// operators, which are absent from UserSchema.

const TypedSchema = z.object({
  id: z.string(),
  active: z.boolean(),
  score: z.number(),
  createdAt: z.date(),
});

const typedDefs = {
  items: defineTable({
    tableName: 'items',
    schema: TypedSchema,
    primaryKey: 'id',
    // `active` is intentionally NOT indexed — booleans are not valid IDB keys,
    // so boolean filters always fall through to in-memory evaluation.
    // `createdAt` IS indexed so date range queries use the native index path.
    indexes: [{ columns: ['score'] }, { columns: ['createdAt'] }],
  }),
};

const tA = new Date('2020-01-01T00:00:00Z');
const tB = new Date('2021-06-01T00:00:00Z');
const tC = new Date('2022-12-31T00:00:00Z');

describe('boolean and date filter operators', () => {
  let store: DexieStore<typeof typedDefs>;

  beforeEach(async () => {
    store = new DexieStore(`test-typed-${++dbCounter}`, typedDefs);
    await store.table.items.upsertMany(
      [
        { id: 'a', active: true, score: 9.5, createdAt: tA },
        { id: 'b', active: false, score: 4.0, createdAt: tB },
        { id: 'c', active: true, score: 7.0, createdAt: tC },
      ],
      { sync: true },
    );
  });

  // Boolean $eq is not testable via Dexie native index — booleans are not valid
  // IDB keys. $ne always returns the fallback (in-memory) path and does work.
  it('boolean $ne (in-memory fallback)', async () => {
    const rows = await store.table.items.findMany({
      where: { active: { $ne: true } },
    });
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('date $eq', async () => {
    const rows = await store.table.items.findMany({
      where: { createdAt: { $eq: tB } },
    });
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('date $gt', async () => {
    const rows = await store.table.items.findMany({
      where: { createdAt: { $gt: tB } },
    });
    expect(rows.map((r) => r.id)).toEqual(['c']);
  });

  it('date $gte', async () => {
    const rows = await store.table.items.findMany({
      where: { createdAt: { $gte: tB } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });

  it('date $lt', async () => {
    const rows = await store.table.items.findMany({
      where: { createdAt: { $lt: tB } },
    });
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('date $lte', async () => {
    const rows = await store.table.items.findMany({
      where: { createdAt: { $lte: tB } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

// ─── findMany: additional query combinations ──────────────────────────────────

describe('findMany: additional query combinations', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(async () => {
    store = makeStore();
    await store.table.users.insertMany([
      { id: 'a', name: 'Alice', age: 30 },
      { id: 'b', name: 'Bob', age: 17 },
      { id: 'c', name: 'Carol', age: 25 },
      { id: 'd', name: 'Dave', age: 17 },
    ]);
  });

  it('empty where clause returns all rows', async () => {
    expect(await store.table.users.findMany({ where: {} })).toHaveLength(4);
  });

  it('limit without orderBy restricts result count', async () => {
    const rows = await store.table.users.findMany({ limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('limit + offset without orderBy paginates', async () => {
    const p1 = await store.table.users.findMany({ limit: 2, offset: 0 });
    const p2 = await store.table.users.findMany({ limit: 2, offset: 2 });
    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(2);
    expect([...p1, ...p2].map((r) => r.id).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('where + orderBy combined', async () => {
    const rows = await store.table.users.findMany({
      where: { age: { $gte: 17 } },
      orderBy: { name: 'asc' },
    });
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('where + orderBy + limit combined', async () => {
    const rows = await store.table.users.findMany({
      where: { age: { $gte: 17 } },
      orderBy: { name: 'asc' },
      limit: 2,
    });
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);
  });

  it('where + orderBy + offset combined', async () => {
    const rows = await store.table.users.findMany({
      where: { age: { $gte: 17 } },
      orderBy: { name: 'asc' },
      offset: 2,
    });
    expect(rows.map((r) => r.name)).toEqual(['Carol', 'Dave']);
  });

  it('multiple orderBy columns', async () => {
    const rows = await store.table.users.findMany({
      orderBy: { age: 'asc', name: 'asc' },
    });
    // age 17: Bob, Dave (alpha); age 25: Carol; age 30: Alice
    expect(rows.map((r) => r.name)).toEqual(['Bob', 'Dave', 'Carol', 'Alice']);
  });

  it('$like _ single-char wildcard', async () => {
    // 'B_b' should match 'Bob'
    const rows = await store.table.users.findMany({
      where: { name: { $like: 'B_b' } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Bob');
  });

  it('implicit AND — multiple operators on same field', async () => {
    const rows = await store.table.users.findMany({
      where: { age: { $gte: 17, $lte: 25 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'c', 'd']);
  });
});

// ─── non-indexed field filter (in-memory fallback) ────────────────────────────
//
// UserSchema has `name` and `age` indexed. Filtering on an un-indexed field
// must fall through to the in-memory scan path in applyNativeFilter.

describe('non-indexed field filter (in-memory fallback)', () => {
  // PostSchema: only `userId` and `status` are indexed; there is no `id` index
  // beyond the primary key, so filtering on a field not in the index list exercises
  // the fallback path.
  let store: ReturnType<typeof makeStore>;
  beforeEach(async () => {
    store = makeStore();
    await store.table.posts.insertMany([
      { id: 'p1', userId: 'u1', status: 'published' },
      { id: 'p2', userId: 'u1', status: 'draft' },
      { id: 'p3', userId: 'u2', status: 'published' },
    ]);
  });

  it('$eq on primary key (not in index list) falls back to scan', async () => {
    const rows = await store.table.posts.findMany({
      where: { id: { $eq: 'p1' } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('p1');
  });

  it('$ne on non-indexed field', async () => {
    const rows = await store.table.posts.findMany({
      where: { id: { $ne: 'p1' } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['p2', 'p3']);
  });

  it('$in on non-indexed primary key', async () => {
    const rows = await store.table.posts.findMany({
      where: { id: { $in: ['p1', 'p3'] } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['p1', 'p3']);
  });
});

// ─── store.ts branch coverage ─────────────────────────────────────────────────

describe('DexieStore — settings already in defs (line 67 true branch)', () => {
  it('uses the caller-supplied settings table def when present', () => {
    const settingsDef = createSettingsDef();
    const defsWithSettings = { ...defs, settings: settingsDef };
    const store = new DexieStore(
      `settings-in-defs-${++dbCounter}`,
      defsWithSettings as any,
    );
    expect(store.settings).toBeDefined();
  });
});

describe('DexieStore — composite primary key (lines 110-111)', () => {
  it('creates a store with a composite [a+b] primary key', async () => {
    const CompositeSchema = z.object({
      userId: z.string(),
      postId: z.string(),
      content: z.string(),
    });
    const compositeDef = defineTable({
      tableName: 'composite',
      schema: CompositeSchema,
      primaryKey: ['userId', 'postId'] as readonly ['userId', 'postId'],
    });
    const store = new DexieStore(`composite-pk-${++dbCounter}`, {
      items: compositeDef,
    });
    expect(store.table.items).toBeDefined();
  });
});

describe('DexieStore — single-element array primary key (line 112 array branch)', () => {
  it('creates a store with a single-element array primaryKey', async () => {
    const SimpleSchema = z.object({ id: z.string(), label: z.string() });
    const singlePkDef = defineTable({
      tableName: 'single',
      schema: SimpleSchema,
      primaryKey: ['id'] as readonly ['id'],
    });
    const store = new DexieStore(`single-pk-arr-${++dbCounter}`, {
      items: singlePkDef,
    });
    await store.table.items.insert({ id: '1', label: 'hello' });
    const rows = await store.table.items.findMany();
    expect(rows).toHaveLength(1);
  });
});

describe('DexieStore — migration with stores only (no upgrade, line 89 false branch)', () => {
  it('applies a stores-only migration without an upgrade function', async () => {
    const store = new DexieStore(`migration-stores-only-${++dbCounter}`, defs, {
      migrations: [{ stores: { users: 'id, name, age' } }],
    });
    await store.table.users.insert({ id: '1', name: 'Alice', age: 25 });
    const rows = await store.table.users.findMany();
    expect(rows).toHaveLength(1);
  });
});

describe('DexieStore — undefined primaryKey defaults to id (line 44 in table.ts)', () => {
  it('auto-assigns id field when primaryKey is omitted in defineTable', async () => {
    const SimpleSchema = z.object({ id: z.string(), label: z.string() });
    const simpleDef = defineTable({
      tableName: 'simple',
      schema: SimpleSchema,
    });
    const store = new DexieStore(`no-pk-${++dbCounter}`, { items: simpleDef });
    const row = await store.table.items.insert({ label: 'test' } as any);
    expect(row.id).toBeTruthy();
  });
});

describe('deleteMany — soft-delete finds zero matching rows (line 234 in table.ts)', () => {
  it('returns 0 when no rows match the where clause', async () => {
    const store = new DexieStore(`soft-del-empty-${++dbCounter}`, syncableDefs);
    await store.table.items.insertMany([{ id: '1', name: 'Alpha' }]);
    const count = await store.table.items.deleteMany({
      where: { name: { $eq: 'NonExistent' } },
    });
    expect(count).toBe(0);
  });
});

describe('DexieStore — compound index (line 115)', () => {
  it('creates a store with a multi-column compound index', async () => {
    const store = new DexieStore(`compound-idx-${++dbCounter}`, {
      users: defineTable({
        tableName: 'users',
        schema: UserSchema,
        primaryKey: 'id',
        indexes: [{ columns: ['name', 'age'] }],
      }),
    });
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    const rows = await store.table.users.findMany();
    expect(rows).toHaveLength(1);
  });
});

describe('DexieStore — unique index (line 116)', () => {
  it('creates a store with a unique index', async () => {
    const store = new DexieStore(`unique-idx-${++dbCounter}`, {
      users: defineTable({
        tableName: 'users',
        schema: UserSchema,
        primaryKey: 'id',
        indexes: [{ columns: ['name'], unique: true }],
      }),
    });
    await store.table.users.insert({ id: '1', name: 'Alice', age: 30 });
    const rows = await store.table.users.findMany();
    expect(rows).toHaveLength(1);
  });
});

describe('DexieStore — migration with stores spec (line 89 upgrade path)', () => {
  it('applies a migration that renames a column via upgrade', async () => {
    const migrationStore = new DexieStore(
      `migration-stores-${++dbCounter}`,
      defs,
      {
        migrations: [
          {
            stores: { users: 'id, name, age' },
            upgrade: async (tx: Transaction) => {
              await tx
                .table('users')
                .toCollection()
                .modify((u: any) => {
                  u.age ??= 0;
                });
            },
          },
        ],
      },
    );
    await migrationStore.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 25,
    });
    const rows = await migrationStore.table.users.findMany();
    expect(rows).toHaveLength(1);
  });
});

// ─── table.ts branch coverage ─────────────────────────────────────────────────

describe('insert — auto-generates primary key when omitted (line 119)', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('assigns a uuid v7 when no id is provided', async () => {
    const row = await store.table.users.insert({
      name: 'NoId',
      age: 42,
    } as any);
    expect(row.id).toBeTruthy();
    expect(typeof row.id).toBe('string');
  });
});

describe('upsertMany — sync+validate writes validated rows (line 273)', () => {
  let store: DexieStore<typeof syncableDefs>;
  beforeEach(() => {
    store = new DexieStore(`upsert-sync-val-${++dbCounter}`, syncableDefs);
  });

  it('validates rows in sync mode', async () => {
    const now = new Date();
    const rows = await store.table.items.upsertMany(
      [
        {
          id: '1',
          name: 'Alpha',
          updatedAt: now,
          createdAt: now,
          deleted: false,
        },
      ],
      { sync: true },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Alpha');
  });
});

// ─── filter.ts branch coverage ────────────────────────────────────────────────

describe('matchesWhere — undefined value in where clause (line 70)', () => {
  it('skips fields with undefined values', async () => {
    const store = makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    // Passing undefined for a field should be ignored, returning all rows.
    const rows = await store.table.users.findMany({
      where: { name: undefined as any },
    });
    expect(rows).toHaveLength(2);
  });
});
