import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type DrizzleCompatibleDB, DrizzleStore } from '../../src/drizzle';
import { defineTable, type StoreSettings } from '../../src/store';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().min(0),
});

const PostSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().min(1),
  status: z.enum(['draft', 'published']),
});

const defs = {
  users: defineTable({
    tableName: 'users',
    schema: UserSchema,
    primaryKey: 'id',
    indexes: [
      { columns: ['email'], unique: true },
      { columns: ['name'] },
      { columns: ['age'] },
    ],
  }),
  posts: defineTable({
    tableName: 'posts',
    schema: PostSchema,
    primaryKey: 'id',
    indexes: [{ columns: ['userId'] }, { columns: ['status'] }],
  }),
};

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
  }),
};

// ─── In-memory SQLite via node:sqlite + drizzle sqlite-proxy ─────────────────

function makeStore() {
  const sqlite = new DatabaseSync(':memory:');

  sqlite.exec(`
    CREATE TABLE users (
      id    TEXT    PRIMARY KEY,
      name  TEXT    NOT NULL,
      email TEXT    NOT NULL UNIQUE,
      age   INTEGER NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE TABLE posts (
      id      TEXT PRIMARY KEY,
      userId  TEXT NOT NULL,
      title   TEXT NOT NULL,
      status  TEXT NOT NULL
    )
  `);

  // The settings table is auto-injected by setupStore; must be createdAt in SQLite
  // because the Drizzle adapter does not auto-create tables (unlike Dexie).
  sqlite.exec(`
    CREATE TABLE __store_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql);
    if (method === 'run') {
      stmt.run(...params);
      return { rows: [] };
    }
    if (method === 'get') {
      const row = stmt.get(...params) as Record<string, unknown> | undefined;
      return { rows: row ? Object.values(row) : [] };
    }
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return { rows: rows.map((r) => Object.values(r)) };
  });

  return new DrizzleStore(db as unknown as DrizzleCompatibleDB, defs);
}

function makeSyncableStore() {
  const sqlite = new DatabaseSync(':memory:');

  sqlite.exec(`
    CREATE TABLE items (
      id       TEXT    PRIMARY KEY,
      name     TEXT    NOT NULL,
      updatedAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    )
  `);

  sqlite.exec(`
    CREATE TABLE __store_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql);
    if (method === 'run') {
      stmt.run(...params);
      return { rows: [] };
    }
    if (method === 'get') {
      const row = stmt.get(...params) as Record<string, unknown> | undefined;
      return { rows: row ? Object.values(row) : [] };
    }
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return { rows: rows.map((r) => Object.values(r)) };
  });

  return new DrizzleStore(db as unknown as DrizzleCompatibleDB, syncableDefs);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('store-drizzle demo', () => {
  let store: DrizzleStore<typeof defs>;

  beforeEach(async () => {
    store = await makeStore();
  });

  it('insert and get', async () => {
    const alice = {
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
    };
    const inserted = await store.table.users.insert(alice);
    expect(inserted).toEqual(alice);
    expect(await store.table.users.find('1')).toEqual(alice);
  });

  it('find with where — numeric range', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'alice@example.com', age: 30 },
      { id: '2', name: 'Bob', email: 'bob@example.com', age: 17 },
      { id: '3', name: 'Carol', email: 'carol@example.com', age: 25 },
    ]);

    const adults = await store.table.users.findMany({
      where: { age: { $gte: 18 } },
      orderBy: { name: 'asc' },
    });
    expect(adults.map((u) => u.name)).toEqual(['Alice', 'Carol']);
  });

  it('find with $like', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'alice@example.com', age: 30 },
      { id: '2', name: 'Adrian', email: 'adrian@example.com', age: 22 },
      { id: '3', name: 'Bob', email: 'bob@example.com', age: 25 },
    ]);

    const aNames = await store.table.users.findMany({
      where: { name: { $like: 'A%' } },
    });
    expect(aNames).toHaveLength(2);
    expect(aNames.every((u) => u.name.startsWith('A'))).toBe(true);
  });

  it('find with $or', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'alice@vip.com', age: 30 },
      { id: '2', name: 'Bob', email: 'bob@example.com', age: 17 },
      { id: '3', name: 'Carol', email: 'carol@example.com', age: 25 },
    ]);

    // Alice matches email branch; Bob matches age branch; Carol matches neither
    const results = await store.table.users.findMany({
      where: { $or: [{ age: { $lt: 18 } }, { email: { $like: '%@vip.com' } }] },
    });
    expect(results).toHaveLength(2);
    expect(results.map((u) => u.id).sort()).toEqual(['1', '2']);
  });

  it('update', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
    });
    const updated = await store.table.users.update('1', { age: 31 });
    expect(updated.age).toBe(31);
    expect(updated.name).toBe('Alice');
  });

  it('delete', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
    });
    await store.table.users.delete('1');
    expect(await store.table.users.find('1')).toBeUndefined();
  });

  it('updateMany', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'alice@example.com', age: 30 },
      { id: '2', name: 'Bob', email: 'bob@example.com', age: 15 },
      { id: '3', name: 'Carol', email: 'carol@example.com', age: 25 },
    ]);

    const n = await store.table.users.updateMany(
      { where: { age: { $lt: 18 } } },
      { name: 'Minor' },
    );
    expect(n).toBe(1);
    expect((await store.table.users.find('2'))!.name).toBe('Minor');
    expect((await store.table.users.find('1'))!.name).toBe('Alice');
  });

  it('deleteMany and count', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'alice@example.com', age: 30 },
      { id: '2', name: 'Bob', email: 'bob@example.com', age: 15 },
      { id: '3', name: 'Carol', email: 'carol@example.com', age: 25 },
    ]);

    expect(
      await store.table.users.count({ where: { age: { $gte: 18 } } }),
    ).toBe(2);
    const removed = await store.table.users.deleteMany({
      where: { age: { $lt: 18 } },
    });
    expect(removed).toBe(1);
    expect(await store.table.users.count()).toBe(2);
  });

  it('two tables — posts belong to users', async () => {
    await store.table.users.insertMany([
      { id: 'u1', name: 'Alice', email: 'alice@example.com', age: 30 },
      { id: 'u2', name: 'Bob', email: 'bob@example.com', age: 25 },
    ]);
    await store.table.posts.insertMany([
      { id: 'p1', userId: 'u1', title: 'Hello World', status: 'published' },
      { id: 'p2', userId: 'u1', title: 'Draft post', status: 'draft' },
      { id: 'p3', userId: 'u2', title: "Bob's post", status: 'published' },
    ]);

    // Find all published posts by Alice
    const alicePosts = await store.table.posts.findMany({
      where: {
        $and: [{ userId: { $eq: 'u1' } }, { status: { $eq: 'published' } }],
      },
    });
    expect(alicePosts).toHaveLength(1);
    expect(alicePosts[0]!.title).toBe('Hello World');

    // Count draft posts
    expect(
      await store.table.posts.count({ where: { status: { $eq: 'draft' } } }),
    ).toBe(1);

    // Delete all of Alice's posts, then verify only Bob's remains
    const removed = await store.table.posts.deleteMany({
      where: { userId: { $eq: 'u1' } },
    });
    expect(removed).toBe(2);
    const remaining = await store.table.posts.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.userId).toBe('u2');
  });
});

// ─── auto-stamping ────────────────────────────────────────────────────────────

describe('auto-stamping', () => {
  let store: DrizzleStore<typeof syncableDefs>;

  beforeEach(async () => {
    store = await makeSyncableStore();
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
  let store: DrizzleStore<typeof defs>;

  beforeEach(async () => {
    store = await makeStore();
  });

  it('delete removes the row even without { hard: true }', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
    });
    await store.table.users.delete('1');
    expect(await store.table.users.find('1')).toBeUndefined();
  });

  it('deleteMany removes matching rows even without { hard: true }', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'alice@example.com', age: 30 },
      { id: '2', name: 'Bob', email: 'bob@example.com', age: 15 },
    ]);
    const n = await store.table.users.deleteMany({
      where: { age: { $lt: 18 } },
    });
    expect(n).toBe(1);
    expect(await store.table.users.find('2')).toBeUndefined();
    expect(await store.table.users.find('1')).not.toBeUndefined();
  });
});

// ─── upsertMany ───────────────────────────────────────────────────────────────

describe('upsertMany', () => {
  let store: DrizzleStore<typeof syncableDefs>;

  beforeEach(async () => {
    store = await makeSyncableStore();
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

// ─── soft-delete filtering (find / findMany / count) ─────────────────────────
//
// Tables whose schema includes `deleted: boolean` automatically exclude rows
// with `deleted = true` from find, findMany, and count. Pass `{ deleted: true }`
// to override and include them.

describe('soft-delete filtering', () => {
  let store: DrizzleStore<typeof syncableDefs>;
  const base = {
    updatedAt: new Date(),
    createdAt: new Date(),
    deleted: false,
  };

  beforeEach(async () => {
    store = await makeSyncableStore();
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

  it('deleteMany soft-delete does not double-count already-deleted rows', async () => {
    await store.table.items.insertMany([
      { id: '1', name: 'Alice', ...base },
      { id: '2', name: 'Bob', ...base },
    ]);
    await store.table.items.delete('1'); // soft-delete
    // Soft-deleting "all" should only affect the 1 live row
    const n = await store.table.items.deleteMany();
    expect(n).toBe(1);
  });

  it('tables without deleted field are unaffected', async () => {
    const s = await makeStore();
    await s.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'a@b.com', age: 30 },
      { id: '2', name: 'Bob', email: 'b@b.com', age: 25 },
    ]);
    expect(await s.table.users.findMany()).toHaveLength(2);
    expect(await s.table.users.count()).toBe(2);
  });
});

function makeStoreNoSettings() {
  const sqlite = new DatabaseSync(':memory:');

  sqlite.exec(`
    CREATE TABLE users (
      id    TEXT    PRIMARY KEY,
      name  TEXT    NOT NULL,
      email TEXT    NOT NULL UNIQUE,
      age   INTEGER NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE TABLE posts (
      id      TEXT PRIMARY KEY,
      userId  TEXT NOT NULL,
      title   TEXT NOT NULL,
      status  TEXT NOT NULL
    )
  `);

  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql);
    if (method === 'run') {
      stmt.run(...params);
      return { rows: [] };
    }
    if (method === 'get') {
      const row = stmt.get(...params) as Record<string, unknown> | undefined;
      return { rows: row ? Object.values(row) : [] };
    }
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return { rows: rows.map((r) => Object.values(r)) };
  });

  // Add settings table so DrizzleStore can use it (always injected in new API)
  sqlite.exec(`
    CREATE TABLE __store_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  return new DrizzleStore(db as unknown as DrizzleCompatibleDB, defs);
}

function makeStoreCustomSettings() {
  const sqlite = new DatabaseSync(':memory:');

  sqlite.exec(`
    CREATE TABLE users (
      id    TEXT    PRIMARY KEY,
      name  TEXT    NOT NULL,
      email TEXT    NOT NULL UNIQUE,
      age   INTEGER NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE TABLE posts (
      id      TEXT PRIMARY KEY,
      userId  TEXT NOT NULL,
      title   TEXT NOT NULL,
      status  TEXT NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE TABLE __store_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql);
    if (method === 'run') {
      stmt.run(...params);
      return { rows: [] };
    }
    if (method === 'get') {
      const row = stmt.get(...params) as Record<string, unknown> | undefined;
      return { rows: row ? Object.values(row) : [] };
    }
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return { rows: rows.map((r) => Object.values(r)) };
  });

  return new DrizzleStore(db as unknown as DrizzleCompatibleDB, defs);
}

// ─── settings table ───────────────────────────────────────────────────────────
//
// setupStore automatically injects a settings table when one is not present in
// the defs. For the Drizzle adapter the SQLite table must still be createdAt
// explicitly (Drizzle does not auto-create tables).
// createSettingsHelper wraps the raw StoreTable with a typed API.

describe('settings table', () => {
  let store: DrizzleStore<typeof defs>;
  let settings: StoreSettings;

  beforeEach(async () => {
    store = await makeStore();
    settings = store.settings;
  });

  it('settings table is present in the store', () => {
    expect(store.settings).toBeDefined();
  });

  it('getAll returns all set entries', async () => {
    await settings.set('lastSynced', '2024-06-01T00:00:00.000Z');
    await settings.set('conflictResolution', 'lww');
    const all = await settings.getAll();
    expect(all).toEqual({
      conflictResolution: 'lww',
      lastSynced: '2024-06-01T00:00:00.000Z',
    });
  });

  it('settings entries are isolated from user tables', async () => {
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
    });
    await settings.set('conflictResolution', 'lww');
    expect(await store.table.users.count()).toBe(1);
    expect(await settings.getAll()).toEqual({ conflictResolution: 'lww' });
  });
});

describe('settings always injected', () => {
  it('settings is always present on the store', async () => {
    const store = await makeStoreNoSettings();
    expect(store.settings).toBeDefined();
  });

  it('user tables still work normally', async () => {
    const store = await makeStoreNoSettings();
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
    });
    expect(await store.table.users.count()).toBe(1);
  });
});

describe('settings from custom store', () => {
  it('settings is present and functional', async () => {
    const store = await makeStoreCustomSettings();
    expect(store.settings).toBeDefined();
    await store.settings.set('conflictResolution', 'lww');
    expect(await store.settings.get('conflictResolution')).toBe('lww');
  });
});

// ─── Helper for filter / pagination tests ────────────────────────────────────
//
// A schema with every supported field type so each filter operator can be
// exercised in one place without repeated store setup.

const RichSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().int(),
  score: z.number(),
  active: z.boolean(),
  createdAt: z.date(),
});

const richDefs = {
  items: defineTable({
    tableName: 'items',
    schema: RichSchema,
    primaryKey: 'id',
  }),
};

function makeRichStore() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE items (
      id        TEXT    PRIMARY KEY,
      name      TEXT    NOT NULL,
      age       INTEGER NOT NULL,
      score     REAL    NOT NULL,
      active    INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE __store_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql);
    if (method === 'run') {
      stmt.run(...params);
      return { rows: [] };
    }
    if (method === 'get') {
      const row = stmt.get(...params) as Record<string, unknown> | undefined;
      return { rows: row ? Object.values(row) : [] };
    }
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return { rows: rows.map((r) => Object.values(r)) };
  });
  return new DrizzleStore(db as unknown as DrizzleCompatibleDB, richDefs);
}

type RichStore = ReturnType<typeof makeRichStore>;

const t0 = new Date('2020-01-01T00:00:00Z');
const t1 = new Date('2021-06-01T00:00:00Z');
const t2 = new Date('2022-12-31T00:00:00Z');

const seed = [
  { id: 'a', name: 'Alice', age: 30, score: 9.5, active: true, createdAt: t0 },
  { id: 'b', name: 'Bob', age: 17, score: 4.0, active: false, createdAt: t1 },
  { id: 'c', name: 'Carol', age: 25, score: 7.25, active: true, createdAt: t2 },
  { id: 'd', name: 'Dave', age: 17, score: 4.0, active: false, createdAt: t1 },
];

async function seedRich(store: RichStore) {
  await store.table.items.upsertMany(seed, { sync: true });
}

// ─── where: all filter operators ─────────────────────────────────────────────

describe('findMany — where operators', () => {
  let store: RichStore;
  beforeEach(() => {
    store = makeRichStore();
  });

  it('$eq string', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { name: { $eq: 'Alice' } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('a');
  });

  it('$eq number', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { age: { $eq: 17 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('$ne', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { age: { $ne: 17 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('$gt', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { age: { $gt: 25 } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('a');
  });

  it('$gte', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { age: { $gte: 25 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('$lt', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { age: { $lt: 25 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('$lte', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { age: { $lte: 25 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'c', 'd']);
  });

  it('$in', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { id: { $in: ['a', 'c'] } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('$nin', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { id: { $nin: ['a', 'c'] } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('$like', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { name: { $like: 'C%' } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('c');
  });

  it('boolean $eq true', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { active: { $eq: true } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('boolean $eq false', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { active: { $eq: false } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('boolean $ne', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { active: { $ne: false } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('date $gte', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { createdAt: { $gte: t1 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'c', 'd']);
  });

  it('date $lt', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { createdAt: { $lt: t1 } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('a');
  });

  it('date $eq', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { createdAt: { $eq: t1 } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('$and combining two conditions', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { $and: [{ active: { $eq: false } }, { age: { $eq: 17 } }] },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('$or combining two conditions', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { $or: [{ age: { $gt: 28 } }, { name: { $eq: 'Carol' } }] },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('multiple operators on different fields combined implicitly (AND)', async () => {
    await seedRich(store);
    const rows = await store.table.items.findMany({
      where: { age: { $gte: 17, $lte: 25 }, active: { $eq: false } },
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('empty where clause returns all rows', async () => {
    await seedRich(store);
    expect(await store.table.items.findMany({ where: {} })).toHaveLength(4);
  });
});

// ─── findMany: limit, offset, orderBy ────────────────────────────────────────

describe('findMany — limit / offset / orderBy', () => {
  let store: RichStore;
  beforeEach(async () => {
    store = makeRichStore();
    await seedRich(store);
  });

  it('limit restricts number of results', async () => {
    const rows = await store.table.items.findMany({ limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('offset skips rows (requires limit in SQLite)', async () => {
    const all = await store.table.items.findMany({ orderBy: { id: 'asc' } });
    const page = await store.table.items.findMany({
      orderBy: { id: 'asc' },
      limit: 10,
      offset: 2,
    });
    expect(page).toHaveLength(2);
    expect(page[0]!.id).toBe(all[2]!.id);
  });

  it('limit + offset implements pagination', async () => {
    const page1 = await store.table.items.findMany({
      orderBy: { id: 'asc' },
      limit: 2,
      offset: 0,
    });
    const page2 = await store.table.items.findMany({
      orderBy: { id: 'asc' },
      limit: 2,
      offset: 2,
    });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect([...page1, ...page2].map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('orderBy asc', async () => {
    const rows = await store.table.items.findMany({ orderBy: { name: 'asc' } });
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('orderBy desc', async () => {
    const rows = await store.table.items.findMany({
      orderBy: { name: 'desc' },
    });
    expect(rows.map((r) => r.name)).toEqual(['Dave', 'Carol', 'Bob', 'Alice']);
  });

  it('orderBy multiple columns', async () => {
    const rows = await store.table.items.findMany({
      orderBy: { age: 'asc', name: 'asc' },
    });
    // age 17: Bob, Dave (alpha); age 25: Carol; age 30: Alice
    expect(rows.map((r) => r.name)).toEqual(['Bob', 'Dave', 'Carol', 'Alice']);
  });
});

// ─── validate option ──────────────────────────────────────────────────────────

describe('validate option', () => {
  let store: RichStore;
  beforeEach(async () => {
    store = makeRichStore();
    await seedRich(store);
  });

  it('find({ validate: true }) returns a valid row', async () => {
    const row = await store.table.items.find('a', { validate: true });
    expect(row).toBeDefined();
    expect(row!.id).toBe('a');
  });

  it('find({ validate: true }) returns undefined for missing id', async () => {
    expect(
      await store.table.items.find('missing', { validate: true }),
    ).toBeUndefined();
  });

  it('findMany({ validate: true }) returns rows', async () => {
    const rows = await store.table.items.findMany(undefined, {
      validate: true,
    });
    expect(rows).toHaveLength(4);
  });

  it('insert({ validate: true }) returns the inserted row', async () => {
    const row = await store.table.items.insert(
      {
        id: 'z',
        name: 'Zed',
        age: 40,
        score: 8.0,
        active: true,
      },
      { validate: true },
    );
    expect(row.id).toBe('z');
  });

  it('insertMany({ validate: true }) returns all inserted rows', async () => {
    const extra = [
      {
        id: 'e',
        name: 'Eve',
        age: 28,
        score: 6.0,
        active: true,
        createdAt: new Date(),
      },
    ];
    const rows = await store.table.items.insertMany(extra, { validate: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('e');
  });

  it('update({ validate: true }) returns the updated row', async () => {
    const row = await store.table.items.update(
      'a',
      { name: 'Alice Updated' },
      { validate: true },
    );
    expect(row.name).toBe('Alice Updated');
  });

  it('upsertMany returns all rows', async () => {
    const rows = await store.table.items.upsertMany([
      {
        id: 'a',
        name: 'Alice v2',
        age: 30,
        score: 9.5,
        active: true,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Alice v2');
  });
});

// ─── insertMany / upsertMany: edge cases ─────────────────────────────────────

describe('insertMany — edge cases', () => {
  it('returns empty array for empty input', async () => {
    const store = makeRichStore();
    expect(await store.table.items.insertMany([])).toEqual([]);
  });
});

describe('updateMany — no where clause', () => {
  it('updates all rows when no where is given', async () => {
    const store = makeRichStore();
    await seedRich(store);
    const n = await store.table.items.updateMany({}, { name: 'Everyone' });
    expect(n).toBe(4);
    const rows = await store.table.items.findMany();
    expect(rows.every((r) => r.name === 'Everyone')).toBe(true);
  });
});

describe('deleteMany — hard with no query', () => {
  it('hard-deletes all rows when called with no arguments', async () => {
    const store = makeRichStore();
    await seedRich(store);
    const n = await store.table.items.deleteMany(undefined, { hard: true });
    expect(n).toBe(4);
    expect(await store.table.items.count()).toBe(0);
  });
});

// ─── Large $in list — slices chunking ────────────────────────────────────────

describe('large $in list — chunked OR', () => {
  it('$in list > 900 items returns correct results', async () => {
    // Use a store with low enough cols that we can afford 1000 rows.
    const store = makeRichStore();

    // Insert 10 known rows; the rest of the $in list are phantom IDs.
    const known = Array.from({ length: 10 }, (_, i) => ({
      id: `known-${i}`,
      name: `Name ${i}`,
      age: 20 + i,
      score: 5.0,
      active: true,
      createdAt: t0,
    }));
    await store.table.items.insertMany(known);

    const ids = [
      ...known.map((r) => r.id),
      ...Array.from({ length: 995 }, (_, i) => `phantom-${i}`),
    ]; // 1005 IDs → must be chunked into ≥2 slices of ≤900

    const rows = await store.table.items.findMany({
      where: { id: { $in: ids } },
    });
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.id).sort()).toEqual(known.map((r) => r.id).sort());
  });

  it('$nin list > 900 items excludes no matching rows', async () => {
    const store = makeRichStore();
    await seedRich(store);

    // 995 phantom IDs that don't exist — all 4 seeded rows should still appear
    const phantoms = Array.from({ length: 995 }, (_, i) => `phantom-${i}`);
    const rows = await store.table.items.findMany({
      where: { id: { $nin: phantoms } },
    });
    expect(rows).toHaveLength(4);
  });
});

// ─── Small maxVars — insertChunkSize batching ─────────────────────────────────

describe('small maxVars — insert/upsert chunking', () => {
  function makeSmallVarStore() {
    // RichSchema has 6 columns → insertChunkSize = floor(18 / 6) = 3
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE items (
        id        TEXT    PRIMARY KEY,
        name      TEXT    NOT NULL,
        age       INTEGER NOT NULL,
        score     REAL    NOT NULL,
        active    INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);
    sqlite.exec(`
      CREATE TABLE __store_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const db = drizzle(async (sql, params, method) => {
      const stmt = sqlite.prepare(sql);
      if (method === 'run') {
        stmt.run(...params);
        return { rows: [] };
      }
      if (method === 'get') {
        const row = stmt.get(...params) as Record<string, unknown> | undefined;
        return { rows: row ? Object.values(row) : [] };
      }
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return { rows: rows.map((r) => Object.values(r)) };
    });
    return new DrizzleStore(db as unknown as DrizzleCompatibleDB, richDefs, {
      maxVars: 18,
    });
  }

  it('insertMany with 7 rows (3 batches of ≤3) inserts all rows', async () => {
    const store = makeSmallVarStore();
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      name: `Name ${i}`,
      age: 20 + i,
      score: 1.0,
      active: true,
      createdAt: t0,
    }));
    const inserted = await store.table.items.insertMany(rows);
    expect(inserted).toHaveLength(7);
    expect(await store.table.items.count()).toBe(7);
  });

  it('upsertMany with 7 rows (3 batches) upserts all rows', async () => {
    const store = makeSmallVarStore();
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      name: `Name ${i}`,
      age: 20 + i,
      score: 1.0,
      active: true,
      createdAt: t0,
    }));
    const upserted = await store.table.items.upsertMany(rows);
    expect(upserted).toHaveLength(7);
    expect(await store.table.items.count()).toBe(7);
  });
});

// ─── store.ts line 213 — insert without primary key (auto UUID) ───────────────

describe('insert — auto-generates primary key when omitted (line 213)', () => {
  it('assigns a uuid v7 when no id is provided', async () => {
    const store = await makeStore();
    const row = await store.table.users.insert({
      name: 'NoId',
      email: 'noid@example.com',
      age: 20,
    } as any);
    expect(row.id).toBeTruthy();
    expect(typeof row.id).toBe('string');
  });
});

// ─── translateWhere branch coverage (drizzle/store.ts lines 71,77,83,97,102) ──

describe('translateWhere — undefined where value (line 71)', () => {
  it('skips fields with undefined values', async () => {
    const store = await makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'a@a.com', age: 25 },
      { id: '2', name: 'Bob', email: 'b@b.com', age: 30 },
    ]);
    const rows = await store.table.users.findMany({
      where: { name: undefined as any },
    });
    expect(rows).toHaveLength(2);
  });
});

describe('translateWhere — $and with empty array (line 77 false branch)', () => {
  it('returns all rows when $and has no sub-clauses', async () => {
    const store = await makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'a@a.com', age: 25 },
    ]);
    const rows = await store.table.users.findMany({
      where: { $and: [] },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('translateWhere — $or with empty array (line 83 false branch)', () => {
  it('returns all rows when $or has no sub-clauses', async () => {
    const store = await makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'a@a.com', age: 25 },
    ]);
    const rows = await store.table.users.findMany({
      where: { $or: [] },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('translateWhere — $in with empty array (line 97 false branch)', () => {
  it('returns all rows when $in is empty', async () => {
    const store = await makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'a@a.com', age: 25 },
    ]);
    const rows = await store.table.users.findMany({
      where: { name: { $in: [] } },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('translateWhere — $nin with empty array (line 102 false branch)', () => {
  it('returns all rows when $nin is empty', async () => {
    const store = await makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', email: 'a@a.com', age: 25 },
    ]);
    const rows = await store.table.users.findMany({
      where: { name: { $nin: [] } },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('deleteMany — hard delete with no matching rows (line 365)', () => {
  it('returns 0 when no rows match', async () => {
    const store = await makeStore();
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      email: 'a@a.com',
      age: 25,
    });
    // users table has no `deleted` field → hard delete path
    const count = await store.table.users.deleteMany({
      where: { name: { $eq: 'NonExistent' } },
    });
    expect(count).toBe(0);
  });
});
