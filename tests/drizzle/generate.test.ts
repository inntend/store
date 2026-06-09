import { DatabaseSync } from 'node:sqlite';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type DrizzleCompatibleDB, DrizzleStore } from '../../src/drizzle';
import { zodToSqliteTables } from '../../src/drizzle/generate';
import { defineStore, defineTable } from '../../src/store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(ddl: string): DrizzleCompatibleDB {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(ddl);
  return drizzle(async (sql, params, method) => {
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
  }) as unknown as DrizzleCompatibleDB;
}

// ─── Column type mapping ──────────────────────────────────────────────────────

describe('zodToSqliteTables — column mapping', () => {
  const AllTypesSchema = z.object({
    id: z.string(),
    count: z.number().int(),
    score: z.number(),
    active: z.boolean(),
    createdAt: z.date(),
    status: z.enum(['a', 'b']),
    nickname: z.string().optional(),
    bio: z.string().nullable(),
    tag: z.string().default('none'),
  });

  const defs = defineStore({
    items: defineTable({
      tableName: 'items',
      schema: AllTypesSchema,
      primaryKey: 'id',
    }),
  });

  const { items } = zodToSqliteTables(defs);
  const cols = getTableColumns(items);

  it('uses tableName from def', () => {
    expect(getTableName(items)).toBe('items');
  });

  it('maps z.string() → SQLiteText, notNull', () => {
    expect(cols.id.columnType).toBe('SQLiteText');
    expect(cols.id.notNull).toBe(true);
  });

  it('maps z.number().int() → SQLiteInteger, notNull', () => {
    expect(cols.count.columnType).toBe('SQLiteInteger');
    expect(cols.count.notNull).toBe(true);
  });

  it('maps z.int() → SQLiteInteger, notNull', () => {
    const defs = defineStore({
      t: defineTable({
        tableName: 't',
        schema: z.object({ id: z.string(), mv: z.int().default(0) }),
        primaryKey: 'id',
      }),
    });
    const { t } = zodToSqliteTables(defs);
    const c = getTableColumns(t);
    expect(c.mv.columnType).toBe('SQLiteInteger');
    expect(c.mv.notNull).toBe(true);
  });

  it('maps z.int() → SQL type "integer" (not "real")', () => {
    const defs = defineStore({
      t: defineTable({
        tableName: 't',
        schema: z.object({ id: z.string(), mv: z.int().default(0) }),
        primaryKey: 'id',
      }),
    });
    const { t } = zodToSqliteTables(defs);
    const c = getTableColumns(t);
    expect(c.mv.getSQLType()).toBe('integer');
  });

  it('passes default values from Zod schema to Drizzle column', () => {
    const defs = defineStore({
      t: defineTable({
        tableName: 't',
        schema: z.object({
          id: z.string(),
          mv: z.int().default(0),
          ev: z.int().default(5),
          tag: z.string().default('none'),
        }),
        primaryKey: 'id',
      }),
    });
    const { t } = zodToSqliteTables(defs);
    const c = getTableColumns(t);
    expect(c.mv.default).toBe(0);
    expect(c.ev.default).toBe(5);
    expect(c.tag.default).toBe('none');
  });

  it('maps z.number() → SQLiteReal, notNull', () => {
    expect(cols.score.columnType).toBe('SQLiteReal');
    expect(cols.score.notNull).toBe(true);
  });

  it('maps z.boolean() → SQLiteBoolean (integer mode), notNull', () => {
    expect(cols.active.columnType).toBe('SQLiteBoolean');
    expect(cols.active.notNull).toBe(true);
  });

  it('maps z.date() → SQLiteTimestamp (integer/timestamp_ms mode), notNull', () => {
    expect(cols.createdAt.columnType).toBe('SQLiteTimestamp');
    expect(cols.createdAt.notNull).toBe(true);
  });

  it('maps z.enum() → SQLiteText, notNull', () => {
    expect(cols.status.columnType).toBe('SQLiteText');
    expect(cols.status.notNull).toBe(true);
  });

  it('optional field → not notNull', () => {
    expect(cols.nickname.notNull).toBe(false);
  });

  it('nullable field → not notNull', () => {
    expect(cols.bio.notNull).toBe(false);
  });

  it('field with default → still notNull (default ≠ nullable)', () => {
    expect(cols.tag.notNull).toBe(true);
  });
});

// ─── z.object() → JSON text column ───────────────────────────────────────────

describe('zodToSqliteTables — z.object() JSON field', () => {
  const Schema = z.object({
    id: z.string(),
    meta: z.object({ key: z.string(), value: z.number() }),
    tags: z.object({ list: z.array(z.string()) }).optional(),
  });

  const defs = defineStore({
    items: defineTable({
      tableName: 'items',
      schema: Schema,
      primaryKey: 'id',
    }),
  });

  const { items } = zodToSqliteTables(defs);
  const cols = getTableColumns(items);

  it('maps z.object() → SQLiteTextJson, notNull', () => {
    expect(cols.meta.columnType).toBe('SQLiteTextJson');
    expect(cols.meta.notNull).toBe(true);
    expect(cols.meta.getSQLType()).toBe('text');
  });

  it('maps z.object().optional() → SQLiteTextJson, not notNull', () => {
    expect(cols.tags.columnType).toBe('SQLiteTextJson');
    expect(cols.tags.notNull).toBe(false);
  });
});

describe('zodToSqliteTables — unsupported type', () => {
  it('throws for truly unsupported types (e.g. z.never)', () => {
    const defs = defineStore({
      bad: defineTable({
        tableName: 'bad',
        schema: z.object({ id: z.string(), x: z.never() }),
        primaryKey: 'id',
      }),
    });
    expect(() => zodToSqliteTables(defs)).toThrow(/unsupported Zod type/);
  });

  it('throws when indexing a JSON field', () => {
    const defs = defineStore({
      bad: defineTable({
        tableName: 'bad',
        schema: z.object({ id: z.string(), meta: z.object({ x: z.number() }) }),
        primaryKey: 'id',
        indexes: [{ columns: ['meta'] }],
      }),
    });
    expect(() => zodToSqliteTables(defs)).toThrow(/cannot index JSON field/);
  });
});

// ─── Index auto-naming + unique constraint ────────────────────────────────────

describe('zodToSqliteTables — index auto-naming', () => {
  it('enforces unique index derived from def', async () => {
    const Schema = z.object({ id: z.string(), email: z.string() });
    const defs = defineStore({
      users: defineTable({
        tableName: 'users',
        schema: Schema,
        primaryKey: 'id',
        indexes: [{ columns: ['email'], unique: true }],
      }),
    });
    const db = await makeDb(
      'CREATE TABLE users (id TEXT, email TEXT, PRIMARY KEY (id), UNIQUE (email))',
    );
    const store = new DrizzleStore(db, defs);
    await store.table.users.insert({ id: '1', email: 'a@b.com' });
    await expect(
      store.table.users.insert({ id: '2', email: 'a@b.com' }),
    ).rejects.toThrow();
  });
});

// ─── Integration — single primary key ────────────────────────────────────────

describe('zodToSqliteTables — integration, single PK', () => {
  const UserSchema = z.object({
    id: z.string(),
    name: z.string(),
    age: z.number().int(),
    score: z.number(),
    active: z.boolean(),
  });

  const defs = defineStore({
    users: defineTable({
      tableName: 'users',
      schema: UserSchema,
      primaryKey: 'id',
    }),
  });

  async function makeStore() {
    const db = await makeDb(`
      CREATE TABLE users (
        id     TEXT    NOT NULL,
        name   TEXT    NOT NULL,
        age    INTEGER NOT NULL,
        score  REAL    NOT NULL,
        active INTEGER NOT NULL,
        PRIMARY KEY (id)
      )
    `);
    return new DrizzleStore(db, defs);
  }

  it('insert and find', async () => {
    const store = await makeStore();
    const row = { id: '1', name: 'Alice', age: 30, score: 9.5, active: true };
    await store.table.users.insert(row);
    expect(await store.table.users.find('1')).toEqual(row);
  });

  it('findMany with where', async () => {
    const store = await makeStore();
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30, score: 9.5, active: true },
      { id: '2', name: 'Bob', age: 17, score: 5.0, active: false },
      { id: '3', name: 'Carol', age: 25, score: 8.2, active: true },
    ]);
    const adults = await store.table.users.findMany({
      where: { age: { $gte: 18 } },
    });
    expect(adults).toHaveLength(2);
    expect(adults.map((u) => u.id).sort()).toEqual(['1', '3']);
  });

  it('update and delete', async () => {
    const store = await makeStore();
    await store.table.users.insert({
      id: '1',
      name: 'Alice',
      age: 30,
      score: 9.5,
      active: true,
    });
    await store.table.users.update('1', { age: 31 });
    expect((await store.table.users.find('1'))!.age).toBe(31);
    await store.table.users.delete('1');
    expect(await store.table.users.find('1')).toBeUndefined();
  });
});

// ─── Integration — composite primary key ─────────────────────────────────────

describe('zodToSqliteTables — integration, composite PK', () => {
  const TagSchema = z.object({
    userId: z.string(),
    tag: z.string(),
    weight: z.number(),
  });

  const defs = defineStore({
    tags: defineTable({
      tableName: 'tags',
      schema: TagSchema,
      primaryKey: ['userId', 'tag'],
      indexes: [{ columns: ['tag'], name: 'tags_tag_idx' }],
    }),
  });

  async function makeStore() {
    const db = await makeDb(`
      CREATE TABLE tags (
        userId TEXT NOT NULL,
        tag    TEXT NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (userId, tag)
      )
    `);
    return new DrizzleStore(db, defs);
  }

  it('allows same userId with different tags', async () => {
    const store = await makeStore();
    await store.table.tags.insertMany([
      { userId: 'u1', tag: 'typescript', weight: 0.9 },
      { userId: 'u1', tag: 'react', weight: 0.8 },
      { userId: 'u2', tag: 'typescript', weight: 0.5 },
    ]);
    const u1Tags = await store.table.tags.findMany({
      where: { userId: { $eq: 'u1' } },
    });
    expect(u1Tags).toHaveLength(2);
  });

  it('allows same tag with different userIds', async () => {
    const store = await makeStore();
    await store.table.tags.insertMany([
      { userId: 'u1', tag: 'typescript', weight: 0.9 },
      { userId: 'u2', tag: 'typescript', weight: 0.5 },
    ]);
    const tsRows = await store.table.tags.findMany({
      where: { tag: { $eq: 'typescript' } },
    });
    expect(tsRows).toHaveLength(2);
  });
});

// ─── Integration — multi-table ────────────────────────────────────────────────

describe('zodToSqliteTables — integration, multi-table', () => {
  const UserSchema = z.object({ id: z.string(), name: z.string() });
  const PostSchema = z.object({
    id: z.string(),
    userId: z.string(),
    title: z.string(),
    status: z.enum(['draft', 'published']),
  });

  const defs = defineStore({
    users: defineTable({
      tableName: 'users',
      schema: UserSchema,
      primaryKey: 'id',
    }),
    posts: defineTable({
      tableName: 'posts',
      schema: PostSchema,
      primaryKey: 'id',
      indexes: [{ columns: ['userId'] }, { columns: ['userId', 'status'] }],
    }),
  });

  it('two-table CRUD via generated tables', async () => {
    const db = await makeDb(`
      CREATE TABLE users (id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (id));
      CREATE TABLE posts (
        id     TEXT NOT NULL,
        userId TEXT NOT NULL,
        title  TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (id)
      )
    `);
    const store = new DrizzleStore(db, defs);

    await store.table.users.insertMany([
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
    ]);
    await store.table.posts.insertMany([
      { id: 'p1', userId: 'u1', title: 'Hello', status: 'published' },
      { id: 'p2', userId: 'u1', title: 'Draft', status: 'draft' },
      { id: 'p3', userId: 'u2', title: "Bob's post", status: 'published' },
    ]);

    expect((await store.table.users.find('u1'))?.name).toBe('Alice');

    const aliceDrafts = await store.table.posts.findMany({
      where: {
        $and: [{ userId: { $eq: 'u1' } }, { status: { $eq: 'draft' } }],
      },
    });
    expect(aliceDrafts).toHaveLength(1);
    expect(aliceDrafts[0]!.title).toBe('Draft');
    expect(
      await store.table.posts.count({
        where: { status: { $eq: 'published' } },
      }),
    ).toBe(2);
  });
});

// ─── Integration — JSON field inflate / serialize ─────────────────────────────

describe('zodToSqliteTables — integration, JSON field', () => {
  const Schema = z.object({
    id: z.string(),
    meta: z.object({ label: z.string(), count: z.number() }),
  });

  const defs = defineStore({
    items: defineTable({
      tableName: 'items',
      schema: Schema,
      primaryKey: 'id',
    }),
  });

  it('serializes on insert and inflates on read', async () => {
    const db = await makeDb(
      'CREATE TABLE items (id TEXT NOT NULL, meta TEXT NOT NULL, PRIMARY KEY (id))',
    );
    const store = new DrizzleStore(db, defs);

    await store.table.items.insert({
      id: '1',
      meta: { label: 'hello', count: 42 },
    });
    const row = await store.table.items.find('1');
    expect(row?.meta).toEqual({ label: 'hello', count: 42 });
    expect(typeof row?.meta).toBe('object');
  });

  it('validates JSON field via schema.parse when validate: true', async () => {
    const db = await makeDb(
      'CREATE TABLE items (id TEXT NOT NULL, meta TEXT NOT NULL, PRIMARY KEY (id))',
    );
    const store = new DrizzleStore(db, defs);

    await store.table.items.insert({
      id: '2',
      meta: { label: 'world', count: 7 },
    });
    const row = await store.table.items.find('2', { validate: true });
    expect(row?.meta).toEqual({ label: 'world', count: 7 });
  });
});

// ─── extraConfig callback coverage (lines 74-97 in generate.ts) ──────────────
// zodToSqliteTables calls sqliteTable(name, cols, extraConfigCallback).
// Drizzle only invokes that callback lazily when getTableConfig() is called,
// not when getTableColumns() is called.  The tests below trigger it explicitly.

describe('zodToSqliteTables — extraConfig callback (indexes + composite PK)', () => {
  it('builds primary-key and index extras for a simple table', () => {
    const { getTableConfig } = require('drizzle-orm/sqlite-core');
    const Schema = z.object({ id: z.string(), name: z.string() });
    const defs = defineStore({
      users: defineTable({
        tableName: 'users',
        schema: Schema,
        primaryKey: 'id',
        indexes: [{ columns: ['name'] }],
      }),
    });
    const { users } = zodToSqliteTables(defs);
    const config = getTableConfig(users);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.indexes).toHaveLength(1);
  });

  it('builds a unique index when idx.unique is true', () => {
    const { getTableConfig } = require('drizzle-orm/sqlite-core');
    const Schema = z.object({ id: z.string(), email: z.string() });
    const defs = defineStore({
      users: defineTable({
        tableName: 'users',
        schema: Schema,
        primaryKey: 'id',
        indexes: [{ columns: ['email'], unique: true }],
      }),
    });
    const { users } = zodToSqliteTables(defs);
    const config = getTableConfig(users);
    expect(config.uniqueConstraints).toHaveLength(1);
  });

  it('builds composite index columns ([a+b] form)', () => {
    const { getTableConfig } = require('drizzle-orm/sqlite-core');
    const Schema = z.object({
      id: z.string(),
      first: z.string(),
      last: z.string(),
    });
    const defs = defineStore({
      users: defineTable({
        tableName: 'users',
        schema: Schema,
        primaryKey: 'id',
        indexes: [{ columns: ['first', 'last'] }],
      }),
    });
    const { users } = zodToSqliteTables(defs);
    const config = getTableConfig(users);
    expect(config.indexes).toHaveLength(1);
  });
});
