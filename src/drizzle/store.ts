import type { InferInsertModel, SQL } from 'drizzle-orm';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTable,
} from 'drizzle-orm/sqlite-core';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import {
  type AnyTableDef,
  type DefaultSettingsValues,
  type FindQuery,
  type ManagedKeys,
  type MutableInput,
  resolveSettingsDef,
  type SettingsTableDef,
  Store,
  stripManaged,
  type StoreTable,
  type StoreType,
  type TableDef,
  type WhereClause,
} from '../store';
import { zodToSqliteTables } from './generate';
import { normalizePrimaryKey } from './utils';

type DrizzleTable = SQLiteTable;
type Column = SQLiteColumn;

/** Split `arr` into sub-arrays of at most `size` elements. */
function slices<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Any Drizzle SQLite database instance — covers `better-sqlite3`, `bun:sqlite`,
 * `@sqlite.org/sqlite-wasm` (via sqlite-proxy), Turso/libSQL, and others.
 * Cast your db instance to this type when the exact generics don't match.
 */
export type DrizzleCompatibleDB = BaseSQLiteDatabase<any, any, any>;

// ─── Query translation ────────────────────────────────────────────────────────

function col(table: DrizzleTable, name: string): Column {
  return (table as unknown as Record<string, Column>)[name]!;
}

function translateWhere<S extends z.ZodObject<z.ZodRawShape>>(
  table: DrizzleTable,
  where: WhereClause<S>,
): SQL | undefined {
  const parts: SQL[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === '$and') {
      const sub = (value as WhereClause<S>[])
        .map((c) => translateWhere(table, c))
        .filter((c): c is SQL => c !== undefined);
      const c = and(...sub);
      if (c) parts.push(c);
    } else if (key === '$or') {
      const sub = (value as WhereClause<S>[])
        .map((c) => translateWhere(table, c))
        .filter((c): c is SQL => c !== undefined);
      const c = or(...sub);
      if (c) parts.push(c);
    } else {
      const f = value as Record<string, unknown>;
      const column = col(table, key);
      if ('$eq' in f) parts.push(eq(column, f.$eq));
      if ('$ne' in f) parts.push(ne(column, f.$ne));
      if ('$gt' in f) parts.push(gt(column, f.$gt as number));
      if ('$gte' in f) parts.push(gte(column, f.$gte as number));
      if ('$lt' in f) parts.push(lt(column, f.$lt as number));
      if ('$lte' in f) parts.push(lte(column, f.$lte as number));
      if ('$in' in f) {
        // Split large lists into OR-ed chunks to stay under SQLite's 999-variable limit.
        const vals = f.$in as unknown[];
        const c = or(...slices(vals, 900).map((s) => inArray(column, s)));
        if (c) parts.push(c);
      }
      if ('$nin' in f) {
        const vals = f.$nin as unknown[];
        const c = and(...slices(vals, 900).map((s) => notInArray(column, s)));
        if (c) parts.push(c);
      }
      if ('$like' in f) parts.push(like(column, f.$like as string));
    }
  }
  return parts.length === 0
    ? undefined
    : parts.length === 1
      ? parts[0]
      : and(...parts);
}

// ─── DrizzleStoreTable ────────────────────────────────────────────────────────

class DrizzleStoreTable<
  S extends z.ZodObject<z.ZodRawShape>,
  PK extends keyof z.infer<S> & string,
> implements StoreTable<S, PK>
{
  readonly schema: S;
  private readonly pk: Column;
  private readonly pkName: string;
  private readonly partialSchema: z.ZodObject<z.ZodRawShape>;
  private readonly hasModified: boolean;
  private readonly hasCreated: boolean;
  private readonly hasDeleted: boolean;
  private readonly insertChunkSize: number;
  private readonly maxVars: number;

  constructor(
    private readonly db: DrizzleCompatibleDB,
    private readonly def: TableDef<S, PK>,
    private readonly table: DrizzleTable,
    maxVars: number,
  ) {
    this.schema = def.schema;
    [this.pkName] = normalizePrimaryKey(def.primaryKey);
    this.pk = col(table, this.pkName as string);
    this.partialSchema = def.schema.partial();
    // Detect which "managed" fields exist in the schema once at creation time.
    // All write methods share these flags to decide what to stamp.
    this.hasModified = 'updatedAt' in def.schema.shape;
    this.hasCreated = 'createdAt' in def.schema.shape;
    this.hasDeleted = 'deleted' in def.schema.shape;
    // Multi-row INSERT uses numRows × numColumns bind variables. Cap batch sizes
    // so no statement exceeds maxVars (caller declares the environment's limit).
    const numCols = Object.keys(def.schema.shape).length;
    this.insertChunkSize = Math.max(1, Math.floor(maxVars / numCols));
    this.maxVars = maxVars;
  }

  async find(
    id: z.infer<S>[PK],
    options?: Pick<FindQuery<S>, 'deleted'> & { validate?: boolean },
  ) {
    type Doc = z.infer<S>;
    const parts: (SQL | undefined)[] = [eq(this.pk, id)];
    if (this.hasDeleted && !options?.deleted)
      parts.push(eq(col(this.table, 'deleted'), false));
    const row = (
      await this.db
        .select()
        .from(this.table)
        .where(and(...(parts.filter(Boolean) as SQL[])))
        .limit(1)
    )[0] as Doc | undefined;
    if (options?.validate && row !== undefined)
      return this.def.schema.parse(row) as Doc;
    return row;
  }

  async findMany(query?: FindQuery<S>, options?: { validate?: boolean }) {
    type Doc = z.infer<S>;

    // SQLite counts total bind variables per statement — OR-chunking doesn't help.
    // When a $in list exceeds maxVars, split into multiple queries and merge.
    if (query?.where) {
      for (const [key, val] of Object.entries(query.where)) {
        if (val && typeof val === 'object' && '$in' in val) {
          const vals = (val as { $in: unknown[] }).$in;
          if (vals.length > this.maxVars) {
            const allRows: Doc[] = [];
            for (const chunk of slices(vals, this.maxVars)) {
              const rows = await this.findMany(
                { ...query, where: { ...query.where, [key]: { $in: chunk } } },
                options,
              );
              allRows.push(...rows);
            }
            return allRows;
          }
        }
      }
    }

    const parts: (SQL | undefined)[] = [];
    if (query?.where) parts.push(translateWhere(this.table, query.where));
    if (this.hasDeleted && !query?.deleted)
      parts.push(eq(col(this.table, 'deleted'), false));
    const cond = parts.filter((p): p is SQL => p !== undefined);
    let q: any = this.db
      .select()
      .from(this.table)
      .where(cond.length ? and(...cond) : undefined);
    if (query?.orderBy) {
      q = q.orderBy(
        ...Object.entries(query.orderBy).map(([k, d]) =>
          d === 'desc' ? desc(col(this.table, k)) : asc(col(this.table, k)),
        ),
      );
    }
    if (query?.limit !== undefined) q = q.limit(query.limit);
    if (query?.offset !== undefined) q = q.offset(query.offset);
    const rows = (await q) as Doc[];
    if (options?.validate)
      return rows.map((r) => this.def.schema.parse(r) as Doc);
    return rows;
  }

  async count(query?: Pick<FindQuery<S>, 'where' | 'deleted'>) {
    const parts: (SQL | undefined)[] = [];
    if (query?.where) parts.push(translateWhere(this.table, query.where));
    if (this.hasDeleted && !query?.deleted)
      parts.push(eq(col(this.table, 'deleted'), false));
    const cond = parts.filter((p): p is SQL => p !== undefined);
    const [row] = await this.db
      .select({ n: count() })
      .from(this.table)
      .where(cond.length ? and(...cond) : undefined);
    return Number((row as { n: unknown }).n);
  }

  /** Returns `data` with a generated UUID v7 inserted at `pkName` when absent. */
  private withPk(data: Record<string, unknown>): Record<string, unknown> {
    if (data[this.pkName] !== undefined) return data;
    return { ...data, [this.pkName]: uuidv7() };
  }

  async insert(data: MutableInput<S, PK>, options?: { validate?: boolean }) {
    type Doc = z.infer<S>;
    const now = new Date();
    const stamped = {
      ...this.withPk(data as Record<string, unknown>),
      ...(this.hasModified && { updatedAt: now }),
      ...(this.hasCreated && { createdAt: now }),
      ...(this.hasDeleted && { deleted: false }),
    };
    const [row] = await this.db
      .insert(this.table)
      .values(this.def.schema.parse(stamped) as InferInsertModel<DrizzleTable>)
      .returning();
    if (options?.validate) return this.def.schema.parse(row) as Doc;
    return row as Doc;
  }

  async insertMany(
    data: MutableInput<S, PK>[],
    options?: { validate?: boolean },
  ) {
    type Doc = z.infer<S>;
    if (data.length === 0) return [];
    const now = new Date();
    const parsed = data.map((d) =>
      this.def.schema.parse({
        ...this.withPk(d as Record<string, unknown>),
        ...(this.hasModified && { updatedAt: now }),
        ...(this.hasCreated && { createdAt: now }),
        ...(this.hasDeleted && { deleted: false }),
      }),
    ) as InferInsertModel<DrizzleTable>[];
    const allRows: Doc[] = [];
    for (const batch of slices(parsed, this.insertChunkSize)) {
      const rows = await this.db.insert(this.table).values(batch).returning();
      allRows.push(...(rows as Doc[]));
    }
    if (options?.validate)
      return allRows.map((r) => this.def.schema.parse(r) as Doc);
    return allRows;
  }

  async update(
    id: z.infer<S>[PK],
    partial: Partial<Omit<z.infer<S>, ManagedKeys<S>>>,
    options?: { validate?: boolean },
  ) {
    type Doc = z.infer<S>;
    const now = new Date();
    // `createdAt` is set-once by insert; `deleted` is managed by delete.
    // Strip both from the partial so callers can't accidentally mutate them.
    const rest = stripManaged(
      partial as Record<string, unknown>,
    );
    const stamped = { ...rest, ...(this.hasModified && { updatedAt: now }) };
    const [row] = await this.db
      .update(this.table)
      .set(
        this.partialSchema.parse(stamped) as Partial<
          InferInsertModel<DrizzleTable>
        >,
      )
      .where(eq(this.pk, id))
      .returning();
    if (row === undefined) throw new Error(`Record "${String(id)}" not found`);
    if (options?.validate) return this.def.schema.parse(row) as Doc;
    return row as Doc;
  }

  async updateMany(
    query: Pick<FindQuery<S>, 'where'>,
    partial: Partial<Omit<z.infer<S>, ManagedKeys<S>>>,
  ) {
    const now = new Date();
    const rest = stripManaged(
      partial as Record<string, unknown>,
    );
    const stamped = { ...rest, ...(this.hasModified && { updatedAt: now }) };
    let cond: SQL | undefined = query.where
      ? translateWhere(this.table, query.where)
      : undefined;
    // Exclude soft-deleted rows — consistent with DexieStoreTable.updateMany
    // which calls findMany() (excludes deleted by default).
    if (this.hasDeleted)
      cond = and(cond, eq(col(this.table, 'deleted'), false));
    const rows = await this.db
      .update(this.table)
      .set(
        this.partialSchema.parse(stamped) as Partial<
          InferInsertModel<DrizzleTable>
        >,
      )
      .where(cond)
      .returning();
    return rows.length;
  }

  async delete(id: z.infer<S>[PK], options?: { hard?: boolean }) {
    // Soft-delete by default when the schema tracks `deleted`.
    // Pass { hard: true } to actually remove the row.
    if (this.hasDeleted && !options?.hard) {
      const now = new Date();
      const patch = {
        deleted: true,
        ...(this.hasModified && { updatedAt: now }),
      };
      await this.db.update(this.table).set(patch).where(eq(this.pk, id));
    } else {
      await this.db.delete(this.table).where(eq(this.pk, id));
    }
  }

  async deleteMany(
    query?: Pick<FindQuery<S>, 'where'>,
    options?: { hard?: boolean },
  ) {
    const cond = query?.where
      ? translateWhere(this.table, query.where)
      : undefined;
    // Same soft/hard logic as `delete`, applied to all matching rows.
    // Add `deleted = false` so already-soft-deleted rows are not double-counted.
    if (this.hasDeleted && !options?.hard) {
      const now = new Date();
      const patch = {
        deleted: true,
        ...(this.hasModified && { updatedAt: now }),
      };
      const softCond = and(cond, eq(col(this.table, 'deleted'), false));
      const rows = await this.db
        .update(this.table)
        .set(patch)
        .where(softCond)
        .returning();
      return rows.length;
    }
    // Hard delete: count first so we can return how many rows were removed.
    const [row] = await this.db
      .select({ n: count() })
      .from(this.table)
      .where(cond);
    const n = Number((row as { n: unknown }).n);
    if (n === 0) return 0;
    await this.db.delete(this.table).where(cond);
    return n;
  }

  async upsertMany(
    data: MutableInput<S, PK>[] | z.infer<S>[],
    options?: { sync?: boolean },
  ) {
    type Doc = z.infer<S>;
    if (data.length === 0) return [];
    const now = new Date();
    // Regular mode: stamp `updatedAt` on every row. For `createdAt` and `deleted`
    // we always write `now`/`false` into the INSERT values, but those columns
    // are excluded from the ON CONFLICT DO UPDATE set clause below, so the DB
    // simply ignores them when a row already exists and keeps its stored values.
    // This is the Drizzle-side trick for "set-once on insert, preserve on conflict"
    // without a read-before-write round-trip (contrast with the Dexie adapter,
    // which has to bulkGet first because IndexedDB has no such SQL mechanism).
    const stamped = options?.sync
      ? (data as z.infer<S>[])
      : data.map((d) => ({
          ...this.withPk(d as Record<string, unknown>),
          ...(this.hasModified && { updatedAt: now }),
          ...(this.hasCreated && { createdAt: now }), // only used on fresh inserts
          ...(this.hasDeleted && { deleted: false }), // only used on fresh inserts
        }));
    const parsed = stamped.map((d) =>
      this.def.schema.parse(d),
    ) as InferInsertModel<DrizzleTable>[];
    // Build the conflict-update set. In regular mode, exclude `createdAt` and
    // `deleted` so the DB keeps their stored values. In sync mode include
    // everything — the LWW caller has already resolved conflicts.
    const setOnceFields = new Set(
      options?.sync ? [] : ['createdAt', 'deleted'],
    );
    const setClause = Object.fromEntries(
      Object.keys(this.def.schema.shape)
        .filter((k) => k !== this.pkName && !setOnceFields.has(k))
        .map((k) => [k, sql.raw(`excluded.${k}`)]),
    );
    const allRows: Doc[] = [];
    for (const batch of slices(parsed, this.insertChunkSize)) {
      const rows = await this.db
        .insert(this.table)
        .values(batch)
        .onConflictDoUpdate({ target: this.pk, set: setClause })
        .returning();
      allRows.push(...(rows as Doc[]));
    }
    return allRows.map((r) => this.def.schema.parse(r) as Doc);
  }
}

// ─── DrizzleStore ─────────────────────────────────────────────────────────────

/**
 * Drizzle (SQLite) backed store. Table schema objects (columns + indexes) are
 * derived automatically from each def — you do not need to write them by hand.
 *
 * Access tables via `store.table.<name>` and settings via `store.settings`.
 *
 * @param db      - Any Drizzle SQLite database instance (`DrizzleCompatibleDB`).
 * @param defs    - Record of TableDefs produced by `defineStore`.
 * @param maxVars - SQLite bind-variable limit. Standard SQLite: 999 (default 900).
 *                  Cloudflare Durable Objects: ~100 — pass 90 to stay safe.
 *
 * @example
 * const store = new DrizzleStore(db, defs);
 * store.table.users  // StoreTable<UserSchema, 'id'>
 * store.settings     // StoreSettings
 */
export class DrizzleStore<
  T extends Record<string, AnyTableDef>,
  ExtraKeys extends string = never,
> extends Store<T, DefaultSettingsValues & Record<ExtraKeys, unknown>> {
  constructor(
    db: DrizzleCompatibleDB,
    defs: T,
    {
      maxVars = 900,
      settingsKeys,
    }: { maxVars?: number; settingsKeys?: readonly ExtraKeys[] } = {},
  ) {
    const settingsDef = resolveSettingsDef(defs as Record<string, unknown>, settingsKeys);
    const settingsTable = new DrizzleStoreTable(
      db,
      settingsDef,
      zodToSqliteTables({ settings: settingsDef }).settings,
      maxVars,
    );

    // Derive Drizzle table objects from all defs (including settings).
    const { settings: _sd, ...userDefEntries } = defs;
    const drizzleTables = zodToSqliteTables(defs);
    const userTables = Object.fromEntries(
      Object.entries(userDefEntries).map(([key, def]) => [
        key,
        new DrizzleStoreTable(
          db,
          def as AnyTableDef,
          drizzleTables[key],
          maxVars,
        ),
      ]),
    ) as unknown as StoreType<T>;

    super(userTables, settingsTable);
  }
}
