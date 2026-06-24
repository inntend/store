import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { FindQuery } from './filter';
import { Base } from './schemas';
import type {
  DefaultSettingsValues,
  SettingsTableDef,
  StoreSettings,
} from './settings';
import { Store } from './store';
import type { AnyTableDef, MutableInput, StoreTable, TableDef } from './table';
import { normalizePrimaryKey } from './table';

// ─── Key schemas ──────────────────────────────────

/** Bits of entropy for a generated recovery phrase. */
export const PASS_PHRASE_STRENGTH = 128;

export const KEKType = z.enum(['account', 'recovery', 'passkey']);
export type KEKType = z.infer<typeof KEKType>;

/**
 * Key Derivation Function configuration (Argon2id).
 * Defaults are applied when calling `KeyConfig.parse({})`.
 */
export const KDFConfig = z
  .object({
    alg: z.union([z.literal('argon2id'), z.literal('none')]),
    memory: z.coerce.number(),
    iterations: z.coerce.number(),
    parallelism: z.coerce.number(),
    saltBytes: z.coerce.number(),
    keyBytes: z.coerce.number(),
  })
  .default({
    alg: 'argon2id',
    memory: 65536, // 64 MiB
    iterations: 3,
    parallelism: 4,
    saltBytes: 32, // 32-byte salt
    keyBytes: 32, // 32-byte keys for AES-256
  });
export type KDFConfig = z.infer<typeof KDFConfig>;

/**
 * Symmetric Key Encryption configuration (AES-GCM).
 * Defaults are applied when calling `KeyConfig.parse({})`.
 */
export const SKEConfig = z
  .object({
    alg: z.literal('AES-GCM'),
    ivBytes: z.coerce.number(),
    tagBytes: z.coerce.number(),
  })
  .default({
    alg: 'AES-GCM',
    ivBytes: 12, // 96-bit IV
    tagBytes: 16, // 128-bit auth tag
  });
export type SKEConfig = z.infer<typeof SKEConfig>;

/**
 * Configuration for HKDF key derivation and HMAC computation.
 * Used by `CryptoManager.loadComputeKey` and `CryptoManager.compute`.
 */
export const ComputeConfig = z
  .object({
    hash: z.enum(['SHA-256', 'SHA-512']),
    keyBytes: z.coerce.number(),
    outputBytes: z.coerce.number().optional(),
  })
  .default({ hash: 'SHA-256', keyBytes: 32 });
export type ComputeConfig = z.infer<typeof ComputeConfig>;

/** Combined algorithm configuration for both KDF and SKE. */
export const KeyConfig = z.object({ kdf: KDFConfig, ske: SKEConfig });
export type KeyConfig = z.infer<typeof KeyConfig>;

/** Encrypted payload stored alongside a key or a field value. */
export const CryptoPayload = z.object({ iv: z.string(), cipher: z.string() });
export type CryptoPayload = z.infer<typeof CryptoPayload>;

/**
 * Schema for a stored KEK-wrapped MEK record.
 * Users reference this in their `defineTable` call for their key table.
 */
export const Key = Base.extend({
  type: KEKType,
  /** Algorithm config used when this key was created — kept for future rotation. */
  config: KeyConfig,
  /** The MEK encrypted with the KEK. */
  content: CryptoPayload,
  /** URL-safe base64 salt used to derive the KEK. */
  salt: z.string(),
  /** Encrypted sentinel `"MEK is verified!"` — used to verify the MEK on load. */
  verify: CryptoPayload,
}).strict();
export type Key = z.infer<typeof Key>;

/**
 * Pre-built `TableDef` for the `Key` schema. Include this in your store
 * definitions so the adapter creates the required table, then pass your defs
 * to both the adapter and `createCryptoStore`.
 *
 * @example
 * import { keyTableDef } from '@inntend/store';
 * const defs = { ...yourTables, key: keyTableDef };
 * const raw = new DexieStore('db', defs);
 * const { store, setMek } = createCryptoStore(raw, defs, manager);
 */
export const keyTableDef: TableDef<typeof Key, 'id'> = {
  tableName: 'key',
  schema: Key,
  primaryKey: 'id',
  indexes: [{ columns: ['type'] }, { columns: ['createdAt'] }],
};

// ─── CryptoManager ────────────────────────────────────────────────────────────

/**
 * Abstraction over a cryptographic backend (e.g. WebCrypto).
 * `TKey` is the runtime key handle — typically `CryptoKey` in browsers.
 *
 * Users supply a `CryptoManager<TKey>` implementation when calling
 * `createCryptoStore`. The library uses it for both key management
 * (`cryptoManager`) and field-level encryption (`CryptoStoreTable`).
 */
export type CryptoManager<TKey> = {
  /** Derives raw key bytes from a user secret + salt using the KDF config. */
  deriveKey(
    config: KeyConfig,
    secret: Uint8Array,
    salt: Uint8Array,
  ): Promise<Uint8Array>;
  /** Imports raw key bytes into a usable key handle. */
  importKey(config: KeyConfig, bytes: Uint8Array): Promise<TKey>;
  /** Encrypts `data` bytes under `key`, returning a serializable payload. */
  encrypt(
    config: KeyConfig,
    key: TKey,
    data: Uint8Array,
  ): Promise<CryptoPayload>;
  /** Decrypts a `CryptoPayload` back to the original bytes. */
  decrypt(
    config: KeyConfig,
    key: TKey,
    data: CryptoPayload,
  ): Promise<Uint8Array>;
  /**
   * Derives a deterministic HMAC key from `mek` via HKDF.
   * Same mek (+ optional namespace) always yields the same compute key.
   * Pass a namespace to keep keys for different fields independent.
   */
  loadComputeKey(
    config: ComputeConfig,
    mek: TKey,
    namespace?: Uint8Array,
  ): Promise<TKey>;
  /**
   * Computes a one-directional deterministic HMAC of `data` under `key`.
   * Returns raw bytes; callers encode to base64 for storage.
   * Truncated to `config.outputBytes` when set.
   */
  compute(
    config: ComputeConfig,
    key: TKey,
    data: Uint8Array,
  ): Promise<Uint8Array>;
};

// ─── Types preserved from the old encrypt.ts ─────────────────────────────────

/**
 * Transforms a fully-decrypted row from version N to version N+1.
 * `migrations[i]` handles rows stored at `mv = i + 1`.
 * Chained cumulatively on read — a v1 row with two migrations runs [0] then [1].
 */
export type DataMigration = (
  row: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Per-table optional DataMigration arrays. Index i = handler for mv=i+1 rows. */
export type MigrationMap<TDefs extends Record<string, AnyTableDef>> = {
  [K in keyof TDefs]?: DataMigration[];
};

/**
 * Preserves the input PK in the output-schema type when the PK field is
 * present there too; widens to `string` otherwise (PK fields are never encrypted).
 */
type ResolvePK<
  PK extends string,
  OutSchema extends z.ZodObject<z.ZodRawShape>,
> = PK extends keyof z.infer<OutSchema> & string ? PK : string;

/** Every row returned by an encrypted table has `mv` set to `currentVersion`. */
type WithMvOut<T> = T & { mv: number };

/**
 * StoreTable variant where read results include `mv: number` (always currentVersion).
 * Write inputs use `MutableInput<S, PK>` — managed fields (including `mv`) are omitted.
 */
interface VersionedStoreTable<
  S extends z.ZodObject<z.ZodRawShape>,
  PK extends keyof z.infer<S> & string,
> {
  schema: S;
  /** Decrypts and migrates the stored row; returns `undefined` if not found. */
  find(id: z.infer<S>[PK]): Promise<WithMvOut<z.infer<S>> | undefined>;
  /** Decrypts and migrates every matching row. */
  findMany(query?: FindQuery<S>): Promise<WithMvOut<z.infer<S>>[]>;
  /** Row count — no decryption needed. */
  count(query?: Pick<FindQuery<S>, 'where'>): Promise<number>;
  /** Encrypts before storage; decrypts and migrates the returned row. */
  insert(data: MutableInput<S, PK>): Promise<WithMvOut<z.infer<S>>>;
  /** Encrypts each row before storage; decrypts and migrates the returned rows. */
  insertMany(data: MutableInput<S, PK>[]): Promise<WithMvOut<z.infer<S>>[]>;
  /** Encrypts the partial before patching; decrypts and migrates the returned row. */
  update(
    id: z.infer<S>[PK],
    partial: Partial<MutableInput<S, PK>>,
  ): Promise<WithMvOut<z.infer<S>>>;
  /** Encrypts the partial; returns the count of affected rows (no read-back). */
  updateMany(
    query: Pick<FindQuery<S>, 'where'>,
    partial: Partial<MutableInput<S, PK>>,
  ): Promise<number>;
  /** Passes straight through to the underlying store — no encrypted data involved. */
  delete(id: z.infer<S>[PK], options?: { hard?: boolean }): Promise<void>;
  /** Passes straight through to the underlying store — no encrypted data involved. */
  deleteMany(
    query?: Pick<FindQuery<S>, 'where'>,
    options?: { hard?: boolean },
  ): Promise<number>;
  /** Encrypts each row before upsert; decrypts and migrates the returned rows. */
  upsertMany(
    data: MutableInput<S, PK>[],
    options?: { sync?: false },
  ): Promise<WithMvOut<z.infer<S>>[]>;
  upsertMany(
    data: z.infer<S>[],
    options: { sync: true },
  ): Promise<WithMvOut<z.infer<S>>[]>;
}

/**
 * Maps each table to a VersionedStoreTable typed on the output schema.
 * Uses `decryptedSchema` from the TableDef when present, falling back to the
 * storage schema `S`.
 */
/**
 * Maps each user table to a VersionedStoreTable.
 * Excludes the settings table (always accessed via `store.settings`) and the
 * `key` table (re-added as a raw StoreTable in `EncryptedStore`).
 */
type EncryptedTableMap<TDefs extends Record<string, AnyTableDef>> = {
  [K in keyof TDefs as TDefs[K] extends SettingsTableDef
    ? never
    : K extends 'key'
      ? never
      : K]: TDefs[K] extends TableDef<infer _S, infer PK, infer Out>
    ? VersionedStoreTable<Out, ResolvePK<PK, Out>>
    : never;
};

/**
 * A `Store` whose tables are all wrapped with field-level encryption/decryption.
 * The `settings` property is inherited unchanged from the underlying store.
 *
 * `table.key` is always typed as a raw `StoreTable<typeof Key, 'id'>` — keys are
 * never re-encrypted (doing so would create a circular dependency). You must
 * include `keyTableDef` in your store definitions so the adapter creates the table.
 */
export type EncryptedStore<
  TDefs extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
> = {
  table: EncryptedTableMap<TDefs> & { key: StoreTable<typeof Key, 'id'> };
  settings: StoreSettings<V>;
};

// ─── CryptoStoreTable ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type AnyTable = StoreTable<any, any>;

/**
 * Wraps an underlying `StoreTable` with async field-level encryption using a
 * `CryptoManager`. All encrypted fields are encrypted on write and decrypted
 * on read. `DataMigration`s are applied cumulatively after decryption.
 *
 * Throws `'Encryption key not loaded'` on any read or write if the MEK has
 * not been set via `createCryptoStore(...).setMek(mek)`.
 */
type ComputedIndexSpec = { indexField: string; sourceField: string };

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce(
      (curr, key) =>
        curr != null && typeof curr === 'object'
          ? (curr as Record<string, unknown>)[key]
          : undefined,
      obj as unknown,
    );
}

// Per-row crypto runs on the JS thread (JSON (de)serialization + the WebCrypto /
// native-module bridge). Resolving thousands of these at once — e.g. an initial
// sync delta — floods the microtask queue and freezes the UI until it drains.
// Process in bounded chunks and yield a macrotask between them so the host can
// paint a frame and handle input. Batches ≤ chunk run in a single pass (no extra
// latency for ordinary reads/writes). The chunk size is tunable per store via
// `createCryptoStore`'s `chunkSize` option (smaller = smoother but slower).
const DEFAULT_CRYPTO_CHUNK = 64;

// A macrotask yield — gives the event loop a turn to render/handle input.
// setTimeout(0) is the one primitive available on web, React Native and Node.
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mapChunked<I, O>(
  items: I[],
  fn: (item: I) => Promise<O>,
  chunkSize: number = DEFAULT_CRYPTO_CHUNK,
): Promise<O[]> {
  const size = Math.max(1, chunkSize);
  if (items.length <= size) return Promise.all(items.map(fn));
  const out: O[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    if (i + size < items.length) await yieldToHost();
  }
  return out;
}

class CryptoStoreTable<TKey> implements AnyTable {
  readonly schema: any;

  constructor(
    private readonly underlying: AnyTable,
    private readonly manager: CryptoManager<TKey>,
    private readonly config: KeyConfig,
    private readonly getMek: () => TKey | undefined,
    private readonly encryptedFields: readonly string[],
    private readonly pkName: string,
    private readonly currentVersion: number,
    private readonly valSchema: z.ZodObject<z.ZodRawShape> | undefined,
    private readonly migrations: DataMigration[],
    private readonly tableName: string,
    private readonly getOldMek: () => TKey | undefined,
    private readonly getCurrentEv: () => number,
    private readonly computedIndexes: readonly ComputedIndexSpec[],
    private readonly computeConfig: ComputeConfig,
    // Rows per chunk for bulk encrypt/decrypt; the loop yields between chunks.
    private readonly chunkSize: number = DEFAULT_CRYPTO_CHUNK,
  ) {
    this.schema = underlying.schema;
  }

  /**
   * Encrypts all listed fields, computes blind indexes from plaintext before
   * encryption, and stamps `mv = currentVersion`, `ev = getCurrentEv()`.
   */
  private async computeBlindIndexes(
    row: Row,
    mek: TKey,
  ): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    if (!this.computedIndexes.length) return result;
    const ns = new TextEncoder().encode(this.tableName);
    const ck = await this.manager.loadComputeKey(this.computeConfig, mek, ns);
    for (const ci of this.computedIndexes) {
      const val = getNestedValue(
        row as Record<string, unknown>,
        ci.sourceField,
      );
      result[ci.indexField] =
        val != null
          ? toB64(
              await this.manager.compute(
                this.computeConfig,
                ck,
                new TextEncoder().encode(
                  typeof val === 'string' ? val : JSON.stringify(val),
                ),
              ),
            )
          : null;
    }
    return result;
  }

  private async encRow(row: Row): Promise<Row> {
    const mek = this.getMek();
    if (!mek)
      throw new Error(
        'Encryption key not loaded — call setMek() before writing data',
      );
    const out: Row = {
      ...row,
      mv: this.currentVersion,
      ev: this.getCurrentEv(),
    };

    if (this.computedIndexes.length > 0) {
      const indexes = await this.computeBlindIndexes(out, mek);
      Object.assign(out, indexes);
    }

    await Promise.all(
      this.encryptedFields.map(async (f) => {
        if (f in out && out[f] != null) {
          const bytes = new TextEncoder().encode(JSON.stringify(out[f]));
          out[f] = await this.manager.encrypt(this.config, mek, bytes);
        }
      }),
    );
    return out;
  }

  async revalidateIds(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const mek = this.getMek();
    if (!mek) return 0;

    const rawRows = (await this.underlying.findMany({
      where: { id: { $in: ids } },
    })) as Row[];
    const rawById = new Map(rawRows.map((r) => [(r as any).id as string, r]));

    // Skip rows encrypted with an older MEK when that MEK is unavailable —
    // decRow would fall back to the current MEK and crypto.subtle.decrypt
    // would throw OperationError. Those rows will be handled on the next
    // reencrypt pass.
    const currentEv = this.getCurrentEv();
    const hasOldMek = !!this.getOldMek();
    const decryptableIds = hasOldMek
      ? ids
      : ids.filter((id) => {
          const raw = rawById.get(id);
          return !raw || (raw as any).ev === currentEv;
        });

    if (!decryptableIds.length) return 0;
    const decRows = await this.findMany({
      where: { id: { $in: decryptableIds } },
    });

    const toFix: Row[] = [];
    for (const row of decRows) {
      const raw = rawById.get((row as any).id as string);
      if (!raw) continue;
      if ((raw as any).ev !== this.getCurrentEv()) {
        toFix.push(row);
        continue;
      }
      if (!this.computedIndexes.length) continue;
      const expected = await this.computeBlindIndexes(row, mek);
      const stale = this.computedIndexes.some(
        (ci) => (raw as any)[ci.indexField] !== expected[ci.indexField],
      );
      if (stale) toFix.push(row);
    }

    if (toFix.length > 0) await this.upsertMany(toFix as any, { sync: true });
    return toFix.length;
  }

  /**
   * Selects the correct MEK based on row `ev`, decrypts all listed fields,
   * applies any pending `DataMigration`s, validates against `valSchema` if
   * provided, and re-stamps `mv = currentVersion`.
   */
  private async decRow(row: Row): Promise<Row> {
    const rowEv = (row.ev as number | undefined) ?? 0;
    const mek =
      rowEv < this.getCurrentEv()
        ? (this.getOldMek() ?? this.getMek())
        : this.getMek();
    if (!mek)
      throw new Error(
        'Encryption key not loaded — call setMek() before reading data',
      );
    const mv = Math.max(1, (row.mv as number | undefined) ?? 1);
    const out: Row = { ...row };
    await Promise.all(
      this.encryptedFields.map(async (f) => {
        if (f in out && out[f] != null) {
          const bytes = await this.manager.decrypt(
            this.config,
            mek,
            out[f] as CryptoPayload,
          );
          out[f] = JSON.parse(new TextDecoder().decode(bytes));
        }
      }),
    );
    let migrated: Row = out;
    for (let v = mv; v < this.currentVersion; v++) {
      migrated = (await this.migrations[v - 1]!(migrated)) as Row;
    }
    const validated = this.valSchema
      ? (this.valSchema.parse(migrated) as Row)
      : migrated;
    if (mv < this.currentVersion) {
      // sync:true preserves the original updatedAt — migration is a background
      // housekeeping write, not a user mutation, so it must not bump updatedAt
      // (which would pollute the sync delta with spurious changes).
      await this.underlying.upsertMany([await this.encRow(validated)], {
        sync: true,
      });
    }
    return { ...validated, mv: this.currentVersion };
  }

  async find(id: unknown, options?: any) {
    const r: Row | undefined = await this.underlying.find(id, options);
    if (r === undefined) return r;
    try {
      return await this.decRow(r);
    } catch (e) {
      throw new Error(`Failed to decrypt row ${String(id)}: ${e}`);
    }
  }

  async findMany(query?: unknown, _options?: any) {
    const rows: Row[] = await this.underlying.findMany(query as any);
    return mapChunked(
      rows,
      (row) =>
        this.decRow(row).catch((e) => {
          throw new Error(
            `Failed to decrypt row ${String(row[this.pkName])}: ${e}`,
          );
        }),
      this.chunkSize,
    );
  }

  async count(query?: unknown) {
    return this.underlying.count(query as any);
  }

  async insert(data: Row, _options?: any) {
    const enc = await this.encRow(data);
    return this.underlying.insert(enc).then((r: Row) => this.decRow(r));
  }

  async insertMany(data: Row[], _options?: any) {
    const encoded = await mapChunked(
      data,
      (r) => this.encRow(r),
      this.chunkSize,
    );
    const rows: Row[] = await this.underlying.insertMany(encoded);
    return mapChunked(rows, (r) => this.decRow(r), this.chunkSize);
  }

  async update(id: unknown, partial: Row, _options?: any) {
    // Read and decrypt the current row first (applies any pending migrations
    // via decRow's write-back).  Without this, decRow would run migration
    // functions on the caller's *new* values rather than the old stored ones,
    // silently corrupting data (e.g. a migration that adds 100 to a year field
    // would transform the caller's freshly supplied year value).
    const existing = await this.find(id);
    if (existing === undefined)
      throw new Error(`Record "${String(id)}" not found`);
    // Merge partial onto the fully-migrated row and stamp updatedAt.
    // updatedAt is stripped by the Zod parse inside upsertMany when the schema
    // doesn't declare it, so this is always safe.
    const merged: Row = { ...existing, ...partial, updatedAt: new Date() };
    const enc = await this.encRow(merged);
    // Use sync:true so mv=currentVersion is written — upsertMany without sync
    // would strip mv (it's in ManagedFieldNames) and leave the DB at the old mv.
    const rows = await this.underlying.upsertMany([enc], { sync: true });
    return this.decRow(rows[0]!);
  }

  async updateMany(query: unknown, partial: Row) {
    // Fetch and decrypt all matching rows first (excludes soft-deleted rows;
    // applies pending migrations via decRow).  Without this, decRow would run
    // migration functions on the caller's *new* values, and mv would never be
    // written (the adapters strip it in their updateMany SET clause).
    const rows = await this.findMany(query as any);
    if (rows.length === 0) return 0;
    const now = new Date();
    const encRows = await mapChunked(
      rows,
      (row) => this.encRow({ ...row, ...partial, updatedAt: now }),
      this.chunkSize,
    );
    // sync:true so mv=currentVersion is included in the upsert.
    await this.underlying.upsertMany(encRows, { sync: true });
    return rows.length;
  }

  async delete(id: unknown, options?: { hard?: boolean }) {
    return this.underlying.delete(id, options);
  }

  async deleteMany(query?: unknown, options?: { hard?: boolean }) {
    return this.underlying.deleteMany(query as any, options);
  }

  async upsertMany(data: Row[], options?: { sync?: boolean }) {
    const encoded = await mapChunked(
      data,
      (r) => this.encRow(r),
      this.chunkSize,
    );
    // Pass validate:false so the adapter skips schema validation on encrypted rows
    // (CryptoPayload objects are not the plain types the storage schema declares).
    // The underlying adapter's schema.parse() will run on the encrypted rows.
    // This is intentional: the storage schema declares encrypted fields as
    // CryptoPayload (e.g. CryptoPayload.optional()), so the parse succeeds.
    const rows: Row[] = await (options?.sync
      ? this.underlying.upsertMany(encoded, { sync: true })
      : this.underlying.upsertMany(encoded));
    return mapChunked(rows, (r) => this.decRow(r), this.chunkSize);
  }
}

// ─── toB64 / fromB64 helpers ──────────────────────────────────────────────────

/** Encodes a `Uint8Array` to URL-safe base64 (no padding). */
export function toB64(bytes: Uint8Array): string {
  // Chunk to avoid exceeding the JS call-stack limit that a bare
  // String.fromCharCode(...bytes) spread would hit for large payloads.
  let s = '';
  for (let i = 0; i < bytes.length; i += 1024)
    s += String.fromCharCode(...bytes.subarray(i, i + 1024));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a URL-safe base64 string to `Uint8Array`. */
export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ─── cryptoManager ────────────────────────────────────────────────────────────

/**
 * Key management utilities built on top of a `CryptoManager<TKey>`.
 * Handles MEK generation, KEK derivation, key wrapping/unwrapping, and
 * the verification sentinel that protects against wrong-password acceptance.
 *
 * All raw key bytes (`Uint8Array`) are zeroed in `finally` blocks.
 * Only the opaque `TKey` handle (e.g. `CryptoKey`) is kept in memory.
 *
 * @example
 * const { updateKey, loadKey } = cryptoManager(myManager);
 *
 * // First-time setup — create a new MEK wrapped with the user's password
 * const { cryptoKey, storeKey } = await updateKey('account', passwordBytes);
 * await rawStore.table.keys.upsertMany([storeKey]);
 * setMek(cryptoKey);
 *
 * // Unlock — load an existing key
 * const mek = await loadKey(storedKey, passwordBytes);
 * setMek(mek);
 */
/** Minimal key data returned by `updateKey` / `updateMasterKey` — ready to persist. */
type PartialStoreKey = Pick<
  Key,
  'id' | 'type' | 'config' | 'content' | 'salt' | 'verify' | 'ev'
>;

export function cryptoManager<TKey>(manager: CryptoManager<TKey>): {
  /**
   * Creates or rotates KEK-wrapped MEK records.
   *
   * - No `existingKeys` (or empty): generates a fresh MEK, returns a single
   *   wrapped record.
   * - With `existingKeys` + `oldSecret`: re-derives the old KEK, decrypts each
   *   MEK version, re-wraps under the new KEK. The `cryptoKey` is the MEK from
   *   the highest-`ev` record. Each returned `storeKey` preserves the source `ev`.
   *
   * Returns `cryptoKey` (ready for `setMek`) and `storeKeys` to persist.
   */
  updateKey(
    type: KEKType,
    secret: Uint8Array,
    existingKeys?: Key[],
    oldSecret?: Uint8Array,
  ): Promise<{ cryptoKey: TKey; storeKeys: PartialStoreKey[] }>;
  /**
   * Loads a stored key: derives the KEK, decrypts the MEK, verifies it,
   * and returns the MEK as `TKey` plus the key record's `ev` version.
   * Pass `ev` to `setMek` so `_currentEv` is restored correctly.
   * Throws if the secret is incorrect.
   */
  loadKey(key: Key, secret: Uint8Array): Promise<{ mek: TKey; ev: number }>;
  /**
   * Sets or rotates the MEK wrapped under the account (password) key.
   *
   * - No `existingKeys`: generates a fresh random MEK.
   * - With `existingKeys` + `existingSecret`: re-wraps every MEK version under
   *   the new account KEK.
   *
   * Returns `cryptoKey` (ready for `setMek`) and `accountStoreKeys` to persist.
   */
  updateMasterKey(
    accountSecret: Uint8Array,
    existingKeys?: Key[],
    existingSecret?: Uint8Array,
  ): Promise<{ cryptoKey: TKey; accountStoreKeys: PartialStoreKey[] }>;
} {
  const SENTINEL = 'MEK is verified!';

  async function wrapMek(
    mekRaw: Uint8Array,
    newSecret: Uint8Array,
    refConfig: KeyConfig,
  ): Promise<{ salt: string; content: CryptoPayload }> {
    let kekRaw: Uint8Array | undefined;
    try {
      const saltBytes = crypto.getRandomValues(
        new Uint8Array(refConfig.kdf.saltBytes),
      );
      kekRaw = await manager.deriveKey(refConfig, newSecret, saltBytes);
      const kek = await manager.importKey(refConfig, kekRaw);
      kekRaw.fill(0);
      kekRaw = undefined;
      const content = await manager.encrypt(refConfig, kek, mekRaw);
      return { salt: toB64(saltBytes), content };
    } finally {
      kekRaw?.fill(0);
    }
  }

  async function decryptAndVerify(
    key: Key,
    secret: Uint8Array,
  ): Promise<{ mekRaw: Uint8Array; mekKey: TKey }> {
    let kekRaw: Uint8Array | undefined;
    let mekRaw: Uint8Array | undefined;
    try {
      kekRaw = await manager.deriveKey(key.config, secret, fromB64(key.salt));
      const kek = await manager.importKey(key.config, kekRaw);
      kekRaw.fill(0);
      kekRaw = undefined;
      mekRaw = await manager.decrypt(key.config, kek, key.content);
      const mekKey = await manager.importKey(key.config, mekRaw);
      const verifyBytes = await manager.decrypt(key.config, mekKey, key.verify);
      if (new TextDecoder().decode(verifyBytes) !== SENTINEL)
        throw new Error('Current secret is incorrect');
      const result = { mekRaw, mekKey };
      mekRaw = undefined; // ownership transferred to caller
      return result;
    } finally {
      kekRaw?.fill(0);
      mekRaw?.fill(0);
    }
  }

  return {
    updateKey: async (type, secret, existingKeys, oldSecret) => {
      const keyConfig = KeyConfig.parse({});
      const sentinel = new TextEncoder().encode(SENTINEL);

      if (existingKeys && existingKeys.length > 0) {
        if (!oldSecret)
          throw new Error(
            'Current secret is required to update KEK when a key exists',
          );
        // Sort descending by ev so storeKeys[0] wraps the latest MEK version
        const sorted = [...existingKeys].sort(
          (a, b) => (b.ev ?? 0) - (a.ev ?? 0),
        );
        const refConfig = sorted[0]!.config;

        // Derive new KEK once; all re-wrapped records share the same new salt
        let kekRaw: Uint8Array | undefined;
        let newKek: TKey;
        let newSalt: string;
        try {
          const saltBytes = crypto.getRandomValues(
            new Uint8Array(refConfig.kdf.saltBytes),
          );
          kekRaw = await manager.deriveKey(refConfig, secret, saltBytes);
          newKek = await manager.importKey(refConfig, kekRaw);
          kekRaw.fill(0);
          kekRaw = undefined;
          newSalt = toB64(saltBytes);
        } finally {
          kekRaw?.fill(0);
        }

        let latestMekKey: TKey | undefined;
        const storeKeys: PartialStoreKey[] = [];

        try {
          for (let i = 0; i < sorted.length; i++) {
            const existing = sorted[i]!;
            const { mekRaw, mekKey } = await decryptAndVerify(
              existing,
              oldSecret,
            );
            try {
              const content = await manager.encrypt(refConfig, newKek, mekRaw);
              const verify = await manager.encrypt(refConfig, mekKey, sentinel);
              if (i === 0) latestMekKey = mekKey;
              storeKeys.push({
                id: existing.id,
                type,
                config: refConfig,
                content,
                salt: newSalt,
                verify,
                ev: existing.ev ?? 0,
              });
            } finally {
              mekRaw.fill(0);
            }
          }
          return { cryptoKey: latestMekKey!, storeKeys };
        } finally {
          secret.fill(0);
          oldSecret.fill(0);
        }
      }

      // No existing keys — generate a fresh MEK
      let mekRaw: Uint8Array | undefined;
      try {
        mekRaw = crypto.getRandomValues(new Uint8Array(keyConfig.kdf.keyBytes));
        const { salt, content } = await wrapMek(mekRaw, secret, keyConfig);
        const mekKey = await manager.importKey(keyConfig, mekRaw);
        mekRaw.fill(0);
        mekRaw = undefined;
        secret.fill(0);
        const storeKey: PartialStoreKey = {
          id: uuidv7(),
          type,
          config: keyConfig,
          content,
          salt,
          verify: await manager.encrypt(
            keyConfig,
            mekKey,
            new TextEncoder().encode(SENTINEL),
          ),
          ev: 0,
        };
        return { cryptoKey: mekKey, storeKeys: [storeKey] };
      } finally {
        mekRaw?.fill(0);
        secret?.fill(0);
        oldSecret?.fill(0);
      }
    },

    loadKey: async (key, secret) => {
      const { mekRaw, mekKey } = await decryptAndVerify(key, secret);
      mekRaw.fill(0);
      return { mek: mekKey, ev: key.ev ?? 0 };
    },

    updateMasterKey: async (accountSecret, existingKeys, existingSecret) => {
      const keyConfig = KeyConfig.parse({});
      const sentinel = new TextEncoder().encode(SENTINEL);
      let mekRaw: Uint8Array | undefined;

      try {
        if (existingKeys && existingKeys.length > 0) {
          if (!existingSecret)
            throw new Error(
              'Current secret is required to rotate MEK when a key exists',
            );
          // Sort descending by ev — highest ev is the latest MEK version
          const sorted = [...existingKeys].sort(
            (a, b) => (b.ev ?? 0) - (a.ev ?? 0),
          );
          const refConfig = sorted[0]!.config;

          let kekRaw: Uint8Array | undefined;
          let newKek: TKey;
          let newSalt: string;
          try {
            const saltBytes = crypto.getRandomValues(
              new Uint8Array(refConfig.kdf.saltBytes),
            );
            kekRaw = await manager.deriveKey(
              refConfig,
              accountSecret,
              saltBytes,
            );
            newKek = await manager.importKey(refConfig, kekRaw);
            kekRaw.fill(0);
            kekRaw = undefined;
            newSalt = toB64(saltBytes);
          } finally {
            kekRaw?.fill(0);
          }

          let latestMekKey: TKey | undefined;
          const accountStoreKeys: PartialStoreKey[] = [];

          for (let i = 0; i < sorted.length; i++) {
            const existing = sorted[i]!;
            const { mekRaw: mr, mekKey } = await decryptAndVerify(
              existing,
              existingSecret,
            );
            try {
              const content = await manager.encrypt(refConfig, newKek, mr);
              const verify = await manager.encrypt(refConfig, mekKey, sentinel);
              if (i === 0) latestMekKey = mekKey;
              accountStoreKeys.push({
                id: existing.id,
                type: 'account',
                config: refConfig,
                content,
                salt: newSalt,
                verify,
                ev: existing.ev ?? 0,
              });
            } finally {
              mr.fill(0);
            }
          }

          accountSecret.fill(0);
          existingSecret.fill(0);
          return { cryptoKey: latestMekKey!, accountStoreKeys };
        }

        // No existing keys — generate fresh MEK
        mekRaw = crypto.getRandomValues(new Uint8Array(keyConfig.kdf.keyBytes));
        const { salt: accountSalt, content: accountContent } = await wrapMek(
          mekRaw,
          accountSecret,
          keyConfig,
        );
        const mekKey = await manager.importKey(keyConfig, mekRaw);
        mekRaw.fill(0);
        mekRaw = undefined;
        accountSecret.fill(0);

        return {
          cryptoKey: mekKey,
          accountStoreKeys: [
            {
              id: uuidv7(),
              type: 'account' as KEKType,
              config: keyConfig,
              content: accountContent,
              salt: accountSalt,
              verify: await manager.encrypt(keyConfig, mekKey, sentinel),
              ev: 0,
            },
          ],
        };
      } finally {
        mekRaw?.fill(0);
        accountSecret?.fill(0);
        existingSecret?.fill(0);
      }
    },
  };
}

// ─── createCryptoStore ────────────────────────────────────────────────────────

/**
 * Wraps a store's tables with async field-level encryption via a `CryptoManager`.
 * Only fields listed in `defineTable({ encryptedFields: [...] })` are encrypted;
 * tables without `encryptedFields` are passed through unchanged.
 * The `settings` table is always passed through unchanged.
 *
 * Returns an `EncryptedStore` with the same shape as `Store`, plus a `setMek`
 * function. Call `setMek(mek)` — typically via the React context — to provide
 * the in-memory MEK (`TKey`) before any read or write. Call `setMek(undefined)`
 * to clear the key (e.g. on sign-out).
 *
 * **`mv` versioning** — same behavior as the old `encryptedStore`:
 * `currentVersion = (migrations[table]?.length ?? 0) + 1`.
 * Writes stamp `mv = currentVersion`. On read, `DataMigration`s are applied
 * cumulatively; output always has `mv = currentVersion`.
 *
 * **Zod validation after decryption**:
 * - `defs[table].decryptedSchema` when present.
 * - Falls back to `defs[table].schema` only when no migrations are defined.
 * - No validation otherwise (storage schema may no longer match the migrated shape).
 *
 * @param rawStore  Store instance from an adapter (e.g. `new DexieStore(...)`).
 * @param defs      Same definitions passed to the adapter.
 * @param manager   `CryptoManager<TKey>` implementation supplied by the caller.
 * @param options.migrations  Per-table `DataMigration` arrays.
 * @param options.config      Algorithm config (defaults to `KeyConfig.parse({})`).
 *
 * @example
 * const raw = new DexieStore('db', defs);
 * const { store, setMek } = createCryptoStore(raw, defs, myManager);
 * // Pass store + setMek to your React context, then call setMek(mek) on unlock.
 */
export function createCryptoStore<
  TDefs extends Record<string, AnyTableDef>,
  TKey,
  V extends Record<string, unknown> = DefaultSettingsValues,
>(
  rawStore: Store<TDefs, V>,
  defs: TDefs,
  manager: CryptoManager<TKey>,
  options?: {
    migrations?: MigrationMap<TDefs>;
    config?: KeyConfig;
    /**
     * Rows per chunk for bulk encrypt/decrypt (findMany/upsertMany/…). The loop
     * yields a macrotask between chunks so large operations (e.g. an initial
     * sync delta) don't block the JS thread / freeze the UI. Smaller = smoother
     * but slower; larger = faster but longer frame hitches. Default 64.
     */
    chunkSize?: number;
  },
): {
  store: EncryptedStore<TDefs, V>;
  setMek(mek: TKey | undefined, ev?: number): void;
  reencrypt(
    oldMek: TKey,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void>;
  forceReencrypt(): Promise<void>;
  checkAndFix(written: Record<string, string[]>): Promise<void>;
} {
  let _mek: TKey | undefined;
  let _currentEv = 0;
  let _oldMek: TKey | undefined;
  const config = options?.config ?? KeyConfig.parse({});
  const defaultComputeConfig = ComputeConfig.parse(undefined);

  const encryptedTables = Object.fromEntries(
    Object.entries(rawStore.table).map(([key, table]) => {
      const encryptedFields = defs[key]?.encryptedFields ?? [];
      if (encryptedFields.length === 0) return [key, table];

      const t = table as AnyTable;

      const tableMigrations: DataMigration[] =
        (options?.migrations as Record<string, DataMigration[]> | undefined)?.[
          key
        ] ?? [];
      const currentVersion = tableMigrations.length + 1;

      // Use decryptedSchema from the TableDef when present; fall back to the
      // storage schema only when no migrations are defined (migrations may
      // change the shape so the storage schema would no longer be valid).
      const valSchema: z.ZodObject<z.ZodRawShape> | undefined =
        defs[key]?.decryptedSchema ??
        (tableMigrations.length === 0 ? defs[key]?.schema : undefined);

      const pkName = normalizePrimaryKey(defs[key]?.primaryKey)[0];

      const computedIndexes = (defs[key]?.computedIndexes ??
        []) as ComputedIndexSpec[];

      return [
        key,
        new CryptoStoreTable(
          t,
          manager,
          config,
          () => _mek,
          encryptedFields as readonly string[],
          pkName,
          currentVersion,
          valSchema,
          tableMigrations,
          key,
          () => _oldMek,
          () => _currentEv,
          computedIndexes,
          defaultComputeConfig,
          options?.chunkSize ?? DEFAULT_CRYPTO_CHUNK,
        ),
      ];
    }),
  );

  return {
    store: {
      table: encryptedTables,
      settings: rawStore.settings,
    } as EncryptedStore<TDefs, V>,
    setMek: (mek: TKey | undefined, ev?: number) => {
      _mek = mek;
      if (!mek) {
        _oldMek = undefined;
        _currentEv = 0;
      } else if (ev !== undefined) {
        _currentEv = ev;
      }
    },
    reencrypt: async (oldMek, onProgress) => {
      if (!_mek)
        throw new Error(
          'Encryption key not loaded — call setMek() before reencrypt',
        );
      _currentEv += 1;
      _oldMek = oldMek;
      try {
        for (const [name, encTable] of Object.entries(encryptedTables)) {
          const def = defs[name as keyof TDefs];
          if (!def?.encryptedFields?.length) continue;
          const pkField = normalizePrimaryKey(def.primaryKey)[0];

          // Fetch all raw rows that still carry the old ev — bounded, no loop
          const rawTable = (rawStore.table as Record<string, AnyTable>)[name]!;
          const needsMigration = await rawTable.findMany({
            where: { ev: { $lt: _currentEv } } as any,
          });
          const total = needsMigration.length;
          let done = 0;

          for (let i = 0; i < needsMigration.length; i += 100) {
            const ids = needsMigration
              .slice(i, i + 100)
              .map((r: any) => r[pkField] as string);
            const decrypted = await (
              encTable as CryptoStoreTable<TKey>
            ).findMany({ where: { [pkField]: { $in: ids } } as any });
            await (encTable as CryptoStoreTable<TKey>).upsertMany(
              decrypted as any,
              { sync: true },
            );
            done += ids.length;
            onProgress?.(done, total);
          }
        }
      } finally {
        _oldMek = undefined;
      }
    },
    forceReencrypt: async () => {
      if (!_mek)
        throw new Error(
          'Encryption key not loaded — call setMek() before forceReencrypt',
        );
      for (const [name, encTable] of Object.entries(encryptedTables)) {
        const def = defs[name as keyof TDefs];
        if (!def?.encryptedFields?.length) continue;
        const rows = await (encTable as CryptoStoreTable<TKey>).findMany({});
        if (rows.length > 0)
          await (encTable as CryptoStoreTable<TKey>).upsertMany(rows as any, {
            sync: true,
          });
      }
    },
    checkAndFix: async (written: Record<string, string[]>) => {
      await Promise.all(
        Object.entries(written).map(([name, ids]) => {
          const encTable = (encryptedTables as Record<string, AnyTable>)[name];
          const t = encTable as CryptoStoreTable<TKey>;
          return typeof t?.revalidateIds === 'function'
            ? t.revalidateIds(ids)
            : Promise.resolve(0);
        }),
      );
    },
  };
}
