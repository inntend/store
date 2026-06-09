import { z } from 'zod';
import type { FindQuery } from './filter';

// ─── Managed field types ──────────────────────────────────────────────────────

/**
 * Field names that the library manages automatically. Callers do not need to
 * provide these in write operations — adapters stamp them on every write.
 */
export type ManagedFieldNames =
  | 'updatedAt'
  | 'createdAt'
  | 'deleted'
  | 'mv'
  | 'ev'
  | 'syncedAt';

/** Extracts the managed key names that are present in schema `S`. */
export type ManagedKeys<S extends z.ZodObject<z.ZodRawShape>> = Extract<
  keyof z.infer<S>,
  ManagedFieldNames
>;

/**
 * Input type for regular (non-sync) write operations.
 * Managed fields are omitted; the primary key is optional so the adapter can
 * auto-generate a UUID v7 when the caller does not supply one.
 */
export type MutableInput<
  S extends z.ZodObject<z.ZodRawShape>,
  PK extends keyof z.infer<S> & string,
> = Omit<z.infer<S>, ManagedKeys<S> | PK> & Partial<Pick<z.infer<S>, PK>>;

// ─── TableDef ─────────────────────────────────────────────────────────────────

export type AnyTableDef = TableDef<
  z.ZodObject<z.ZodRawShape>,
  string,
  z.ZodObject<z.ZodRawShape>
>;

export type IndexSpec<S extends z.ZodObject<z.ZodRawShape>> = {
  columns: readonly [
    keyof z.infer<S> & string,
    ...(keyof z.infer<S> & string)[],
  ];
  unique?: boolean;
  /** Defaults to `<table>_<col1>_<col2>_idx` when omitted. */
  name?: string;
};

export interface TableDef<
  S extends z.ZodObject<z.ZodRawShape>,
  PK extends keyof z.infer<S> & string = keyof z.infer<S> & string,
  Out extends z.ZodObject<z.ZodRawShape> = S,
> {
  tableName: string;
  schema: S;
  /** Primary key field(s). Single string or non-empty tuple for composite keys. */
  primaryKey?: PK | readonly [PK, ...PK[]];
  indexes?: IndexSpec<S>[];
  /**
   * Fields to encrypt at rest via `createCryptoStore()`. Listed fields are passed
   * through the CryptoManager encrypt/decrypt on every write/read. The PK is never
   * encrypted. Leave empty (or omit) for plaintext tables.
   */
  encryptedFields?: ReadonlyArray<keyof z.infer<S> & string>;
  /**
   * Zod schema describing the decrypted shape returned by `createCryptoStore()`.
   * When provided, decrypted rows are validated against this schema and the
   * encrypted store's read methods are typed to return `z.infer<Out>` instead
   * of `z.infer<S>`. Required when migrations change the row shape.
   */
  decryptedSchema?: Out;
  /**
   * Blind indexes for equality search on encrypted fields.
   * Each entry declares an `indexField` (plain string column) that stores a
   * deterministic HMAC of `sourceField` (which must be in `encryptedFields`).
   * `createCryptoStore` computes the HMAC on every write and recomputes it
   * during `reencrypt` (MEK rotation). The namespace is auto-derived from
   * the table name so indexes across tables are key-isolated.
   */
  computedIndexes?: ReadonlyArray<{
    /** Plain column that stores the HMAC value. */
    indexField: keyof z.infer<S> & string;
    /** Encrypted field whose plaintext is hashed. Supports dot-notation for nested fields (e.g. `"address.city"`). */
    sourceField: string;
  }>;
}

/**
 * Declares a single table: its Zod schema, primary key, optional indexes, and
 * optional encrypted fields. The returned object is the single source of truth
 * for both the adapter (which derives the DB schema from it) and the
 * `createCryptoStore()` wrapper (which reads `encryptedFields` from it).
 *
 * @example
 * const userDef = defineTable({
 *   tableName: 'users',
 *   schema: z.object({ id: z.string(), name: z.string(), email: z.string() }),
 *   primaryKey: 'id',
 *   indexes: [{ columns: ['email'], unique: true }],
 * });
 */
export function defineTable<
  S extends z.ZodObject<z.ZodRawShape>,
  PK extends keyof z.infer<S> & string,
  Out extends z.ZodObject<z.ZodRawShape> = S,
>(def: TableDef<S, PK, Out>): TableDef<S, PK, Out> {
  return def;
}

// ─── StoreTable ───────────────────────────────────────────────────────────────
//
// Every adapter (store-drizzle, store-dexie) returns an object satisfying this
// interface per table. Higher-level abstractions like sync() only need a subset
// of these operations (findMany + upsertMany) via SyncableStoreTable.
//
// Auto-stamping convention — adapters automatically manage special fields
// when they are present in the schema (detected by name at table-creation time):
//
//   updatedAt: Date    — always set to `now` on every write (insert/update/delete)
//   createdAt: Date    — set to `now` on insert; never touched by update or delete
//   deleted: boolean — set to `false` on insert; set to `true` by soft-delete
//
// Callers do not need to provide these fields — any values passed in are
// silently overridden. Tables without these fields are unaffected.
//
// Soft-delete: when a schema has `deleted`, calling `delete` / `deleteMany`
// sets `deleted = true` and stamps `updatedAt` instead of removing the row.
// Pass `{ hard: true }` to bypass soft-delete and remove the row permanently.
// Tables without `deleted` always hard-delete regardless of the option.
//
// The settings table (see bottom of file) intentionally omits all managed
// fields — it is a plain key-value store that does not participate in sync.

export interface StoreTable<
  S extends z.ZodObject<z.ZodRawShape>,
  PK extends keyof z.infer<S> & string = keyof z.infer<S> & string,
> {
  /** The Zod schema this table was created with. */
  schema: S;
  /**
   * Returns the record with the given primary key, or `undefined` if not found.
   * Soft-deleted rows (`deleted = true`) are excluded unless `{ deleted: true }` is passed.
   * Pass `{ validate: true }` to run the returned row through the table's Zod schema.
   */
  find(
    id: z.infer<S>[PK],
    options?: Pick<FindQuery<S>, 'deleted'> & { validate?: boolean },
  ): Promise<z.infer<S> | undefined>;
  /**
   * Returns all records matching the query. Omit `query` to return everything.
   * Supports `where` (field filters + `$and`/`$or`), `orderBy`, `limit`, `offset`, and `deleted`.
   * Soft-deleted rows are excluded by default; pass `{ deleted: true }` to include them.
   * Pass `{ validate: true }` in options to run each returned row through the table's Zod schema.
   */
  findMany(
    query?: FindQuery<S>,
    options?: { validate?: boolean },
  ): Promise<z.infer<S>[]>;
  /**
   * Returns the number of records matching the optional `where` clause.
   * Soft-deleted rows are excluded by default; pass `{ deleted: true }` to include them.
   */
  count(query?: Pick<FindQuery<S>, 'where' | 'deleted'>): Promise<number>;
  /**
   * Auto-stamps `updatedAt`, `createdAt`, and `deleted`. Managed fields
   * (`updatedAt`, `createdAt`, `deleted`, `mv`, `ev`, `syncedAt`) are omitted
   * from the input type — callers do not need to provide them. The primary key
   * is optional: if omitted the adapter auto-generates a UUID v7.
   * Pass `{ validate: true }` to run the returned row through the table's Zod schema.
   */
  insert(
    data: MutableInput<S, PK>,
    options?: { validate?: boolean },
  ): Promise<z.infer<S>>;
  /**
   * Auto-stamps `updatedAt`, `createdAt`, and `deleted` on every row.
   * Managed fields are omitted from the input type. PK is optional (auto-generated when absent).
   * Pass `{ validate: true }` to run each returned row through the table's Zod schema.
   */
  insertMany(
    data: MutableInput<S, PK>[],
    options?: { validate?: boolean },
  ): Promise<z.infer<S>[]>;
  /**
   * Auto-stamps `updatedAt`. Managed fields are excluded from the partial type.
   * Pass `{ validate: true }` to run the returned row through the table's Zod schema.
   */
  update(
    id: z.infer<S>[PK],
    partial: Partial<Omit<z.infer<S>, ManagedKeys<S>>>,
    options?: { validate?: boolean },
  ): Promise<z.infer<S>>;
  /** Same strip-and-stamp behavior as `update`, applied to all matching rows. */
  updateMany(
    query: Pick<FindQuery<S>, 'where'>,
    partial: Partial<Omit<z.infer<S>, ManagedKeys<S>>>,
  ): Promise<number>;
  /**
   * Soft-deletes by default when schema has `deleted` (sets `deleted=true`,
   * stamps `updatedAt`). Pass `{ hard: true }` to remove the row permanently.
   * Tables without `deleted` always hard-delete.
   */
  delete(id: z.infer<S>[PK], options?: { hard?: boolean }): Promise<void>;
  /** Same soft/hard logic as `delete`, applied to all matching rows. */
  deleteMany(
    query?: Pick<FindQuery<S>, 'where'>,
    options?: { hard?: boolean },
  ): Promise<number>;
  /**
   * Inserts or fully replaces rows by primary key.
   *
   * In regular mode (default), timestamps are managed automatically:
   * `updatedAt` is always set to now; `createdAt` and `deleted` are set only on
   * insert and preserved unchanged on conflict. Managed fields are omitted from
   * the input type; PK is optional (auto-generated when absent).
   *
   * Pass `{ sync: true }` to skip all auto-stamping — use this when the caller
   * (e.g. sync()) has already resolved conflicts and set the correct timestamps.
   * In sync mode the full row type is required.
   */
  upsertMany(
    data: MutableInput<S, PK>[],
    options?: { sync?: false },
  ): Promise<z.infer<S>[]>;
  upsertMany(
    data: z.infer<S>[],
    options: { sync: true },
  ): Promise<z.infer<S>[]>;
}
