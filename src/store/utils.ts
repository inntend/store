import { z } from 'zod';

// ─── Shared store types ────────────────────────────────────────────────────────

/**
 * Minimum fields a record must have to participate in sync or pull.
 */
export type SyncableMeta = { id: string; updatedAt: Date; syncedAt?: Date };

/** Subset of StoreTable operations required by the sync/pull functions. */
export interface SyncableStoreTable<T extends SyncableMeta> {
  findMany(query?: {
    where?: Record<string, unknown>;
    deleted?: true;
    orderBy?: Record<string, 'asc' | 'desc'>;
    limit?: number;
    offset?: number;
  }): Promise<T[]>;
  upsertMany(data: T[], options?: { sync?: boolean }): Promise<T[]>;
}

/**
 * Per-table operations required by `sync`, `syncClient`, `pull`, and `pullClient`.
 * Method shorthand syntax gives TypeScript bi-variant parameter checking —
 * this allows `StoreTable<ConcreteSchema>` (whose `upsertMany` expects the full
 * concrete type) to satisfy this interface, because `ConcreteType extends
 * SyncableMeta` satisfies bi-variance.
 */
export interface SyncableTableOps {
  findMany(query?: object): Promise<SyncableMeta[]>;
  upsertMany(
    data: SyncableMeta[],
    options?: { sync?: boolean },
  ): Promise<SyncableMeta[]>;
}

/** A store-shaped object accepted by `sync`, `syncClient`, `pull`, and `pullClient`. */
export type SyncableStore = Record<string, SyncableTableOps>;

export type SyncResult = {
  data: Record<string, SyncableMeta[]>;
  /** `true` when any table had more records beyond `pageSize`. */
  hasMore: boolean;
  /** The page size used by the server. Client uses this to advance `pageOffset`. */
  pageSize?: number;
  /**
   * Per-table next offsets for tables with more rows (per-table paging mode).
   * The client echoes this back verbatim to fetch the next page; an empty
   * object means the pull is complete.
   */
  pageOffsets?: Record<string, number>;
};

/**
 * Validates a single syncable record from the network.
 * `updatedAt` is coerced from an ISO string to a `Date` (JSON serialization
 * drops the Date type). Extra fields are preserved via `.loose()`.
 */
export const syncableMetaSchema = z
  .object({
    id: z.string(),
    updatedAt: z.coerce.date(),
    syncedAt: z.coerce.date().optional(),
  })
  .loose();

/** Pre-built schema for parsing arrays of syncable records from the network. */
export const syncableMetaArraySchema = z.array(syncableMetaSchema);

// ─── Private helpers ───────────────────────────────────────────────────────────

export async function batchUpsert(
  table: SyncableStoreTable<SyncableMeta>,
  items: SyncableMeta[],
  batchSize?: number,
): Promise<string[]> {
  if (!items.length) return [];
  const size = batchSize ?? items.length;
  for (let i = 0; i < items.length; i += size) {
    await table.upsertMany(items.slice(i, i + size), { sync: true });
  }
  return items.map((r) => r.id);
}
