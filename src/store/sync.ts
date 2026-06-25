import { z } from 'zod';
import {
  batchUpsert,
  type SyncableMeta,
  type SyncableStore,
  type SyncResult,
  syncableMetaArraySchema,
  syncableMetaSchema,
} from './utils';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SyncOptions = {
  /** Max records returned per server response page. Omit for unbounded. */
  pageSize?: number;
  /** Max records per `upsertMany` call. Omit for a single call per table. */
  batchSize?: number;
  /** Table names to exclude from sync. Default: `['settings']`. */
  skip?: string[];
};

export type SyncClientParams = {
  /**
   * The only network abstraction. Call your server's `sync` endpoint here.
   * On page 0 the full client delta is included; subsequent pages pass `{}`.
   */
  fetcher: (params: {
    current: Date;
    from: Date;
    to: Date;
    delta: Record<string, SyncableMeta[]>;
    pageOffset: number;
    conflictResolution?: ConflictResolution;
  }) => Promise<SyncResult | undefined>;
  /** Max records per `upsertMany` call on the client side. */
  batchSize?: number;
  /**
   * Conflict resolution strategy to send to the server.
   * Defaults to `'lww'` (last-write-wins).
   * The server applies this when the same record exists on both sides.
   */
  conflictResolution?: ConflictResolution;
  /**
   * Table names to exclude from sync. Default: `['settings']`. Mirrors the
   * server `SyncOptions.skip` — use it to keep device-local/ephemeral tables
   * (e.g. short-TTL locks) out of the delta entirely. A caller-provided list
   * replaces the default, so include `'settings'` if you still want it skipped.
   */
  skip?: string[];
};

export type SyncClientResult = {
  /** Persist this as the next `from`. */
  syncedTo: Date;
  /** IDs written per table during this sync, for post-sync revalidation. */
  written: Record<string, string[]>;
};

// ─── Errors ────────────────────────────────────────────────────────────────────

/** Maximum tolerated difference between client-reported time and server time. */
export const CLOCK_SKEW_TOLERANCE_MINUTES = 5;

export class ClockSkewError extends Error {
  readonly clientTime: Date;
  readonly serverTime: Date;
  constructor(clientTime: Date, serverTime: Date) {
    super(
      `Clock skew detected: client current time ${clientTime.toISOString()} differs from server time ${serverTime.toISOString()} by more than ${CLOCK_SKEW_TOLERANCE_MINUTES} minutes. Please correct your clock and try again.`,
    );
    this.name = 'ClockSkewError';
    this.clientTime = clientTime;
    this.serverTime = serverTime;
  }
}

// ─── Conflict resolution ───────────────────────────────────────────────────────

export const conflictResolutionSchema = z.enum([
  'lww',
  'server-wins',
  'client-wins',
]);
/** How the server resolves a conflict when the same record exists on both sides. */
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;

// ─── Zod schemas ───────────────────────────────────────────────────────────────

/**
 * Validates and coerces the raw HTTP request body for the `sync` endpoint.
 * Export this to use in framework middleware or tRPC input schemas.
 *
 * @example
 * // Hono
 * app.post('/sync', zValidator('json', syncParamsSchema), async (c) => {
 *   const result = await sync(store, c.req.valid('json'), { pageSize: 200 });
 *   return c.json(result);
 * });
 */
export const syncParamsSchema = z.object({
  current: z.coerce.date(),
  from: z.coerce.date(),
  to: z.coerce.date().optional(),
  delta: z.record(z.string(), z.array(syncableMetaSchema)),
  pageOffset: z.number().int().nonnegative().optional(),
  conflictResolution: conflictResolutionSchema.optional(),
});

// ─── Private helpers ───────────────────────────────────────────────────────────

function discoverTables(store: SyncableStore, skip: string[]): string[] {
  const skipSet = new Set(skip);
  return Object.keys(store).filter((t) => !skipSet.has(t));
}

// ─── sync ──────────────────────────────────────────────────────────────────────

/**
 * Server-side bidirectional delta sync. Operates on all tables in the store
 * except those in `options.skip` (default: `['settings']`).
 *
 * Call this from your HTTP handler and pass the raw request body as `params` —
 * it is validated and date-coerced internally via Zod. For framework-level
 * validation, use the exported `syncParamsSchema` in your middleware instead.
 *
 * ```
 * POST /sync   body: { current, from, to?, delta, pageOffset?, conflictResolution? }
 * response:    { data, hasMore, pageSize? }
 * ```
 *
 * **Conflict resolution:** controlled by `conflictResolution` in the request body.
 * Defaults to `'lww'`. Only applied on the first page (`pageOffset === 0`);
 * subsequent pages fetch server records only (client sends `delta: {}`).
 *
 * **Batching:** `batchSize` splits large `upsertMany` calls into chunks at the
 * application level (independent of the adapter's own SQL variable-limit chunking).
 */
export async function sync(
  store: SyncableStore,
  params: unknown,
  options?: SyncOptions,
): Promise<SyncResult> {
  const {
    current,
    from,
    to: rawTo,
    delta,
    pageOffset = 0,
    conflictResolution = 'lww',
  } = syncParamsSchema.parse(params);

  const now = new Date();
  const skewMinutes = Math.abs(current.getTime() - now.getTime()) / 60_000;
  if (skewMinutes > CLOCK_SKEW_TOLERANCE_MINUTES) {
    throw new ClockSkewError(current, now);
  }

  const to = rawTo ?? now;
  const { pageSize, batchSize, skip = ['settings'] } = options ?? {};
  const tableNames = discoverTables(store, skip);

  const tableResults = await Promise.all(
    tableNames.map(async (tableName) => {
      const table = store[tableName]!;
      const items = (delta[tableName] ?? []) as SyncableMeta[];

      const windowQuery = {
        // Half-open on BOTH ends so a device never re-pulls its own pushes:
        // accepted rows are stamped syncedAt=to, so `$lt: to` drops them from
        // this sync, and `$gt: from` (from === the previous sync's `to`) drops
        // them next sync. `syncedTo` stays `to`, so the client's push cursor
        // (updatedAt >= from) is unaffected — no rows are missed on push.
        where: { syncedAt: { $gt: from, $lt: to } },
        deleted: true as const,
        ...(pageSize != null
          ? {
              orderBy: { syncedAt: 'asc' as const, id: 'asc' as const },
              limit: pageSize + 1,
              offset: pageOffset,
            }
          : {}),
      };

      if (items.length === 0) {
        const rows = await table.findMany(windowQuery);
        const hadMore = pageSize != null && rows.length > pageSize;
        if (hadMore) rows.pop();
        return { tableName, rows, hadMore };
      }

      // Conflict resolution: compare incoming delta against stored versions.
      const existing = await table.findMany({
        where: { id: { $in: items.map((i) => i.id) } },
        deleted: true,
      });
      const existingById = new Map(existing.map((r) => [r.id, r]));

      const accepted: SyncableMeta[] = [];
      const serverWins: SyncableMeta[] = [];
      for (const item of items) {
        const server = existingById.get(item.id);
        const clientAccepted =
          !server ||
          conflictResolution === 'client-wins' ||
          (conflictResolution === 'lww' && item.updatedAt >= server.updatedAt);
        if (clientAccepted) {
          accepted.push(item);
        } else {
          serverWins.push(server);
        }
      }

      if (accepted.length > 0) {
        await batchUpsert(
          table,
          accepted.map((item) => ({ ...item, syncedAt: to })),
          batchSize,
        );
      }

      const serverDelta = await table.findMany(windowQuery);
      const hadMore = pageSize != null && serverDelta.length > pageSize;
      if (hadMore) serverDelta.pop();

      // Outbound = (window records ∪ server-wins) − accepted
      const outbound = new Map<string, SyncableMeta>();
      for (const item of serverDelta) outbound.set(item.id, item);
      for (const item of serverWins) outbound.set(item.id, item);
      for (const item of accepted) outbound.delete(item.id);

      return { tableName, rows: [...outbound.values()], hadMore };
    }),
  );

  const data: Record<string, SyncableMeta[]> = {};
  let hasMore = false;
  for (const { tableName, rows, hadMore } of tableResults) {
    data[tableName] = rows;
    if (hadMore) hasMore = true;
  }

  return { data, hasMore, pageSize };
}

// ─── syncClient ────────────────────────────────────────────────────────────────

/**
 * Client-side sync orchestration: collects local delta → calls server via
 * `fetcher` → writes server's response back into the local store.
 * Abstracts only the network layer; everything else is handled internally.
 *
 * Auto-discovers all tables in the store (same skip list as the server, default
 * `['settings']`). No storage callbacks — returns `syncedTo` for the caller to
 * persist.
 *
 * ```ts
 * const { syncedTo } = await syncClient(store, new Date(lastSynced ?? 0), {
 *   fetcher: (p) => fetch('/sync', { method: 'POST', body: JSON.stringify(p) }).then(r => r.json()),
 * });
 * await settings.set('lastSynced', syncedTo.toISOString());
 * ```
 *
 * **Pagination:** when `pageSize` is set, the client loops automatically until
 * `hasMore` is `false`. Page 0 sends the full client delta; subsequent pages
 * send an empty delta (LWW already applied on page 0). The server must include
 * `pageSize` in every response where `hasMore=true`; omitting it throws.
 */
export async function syncClient(
  store: SyncableStore,
  from: Date,
  params: SyncClientParams,
): Promise<SyncClientResult> {
  const {
    fetcher,
    batchSize,
    conflictResolution,
    skip = ['settings'],
  } = params;
  const to = new Date();

  // syncClient shares the same skip default as sync() — both ends skip 'settings'
  // unless the caller overrides (e.g. to also drop device-local tables).
  const tableNames = discoverTables(store, skip);

  // Collect local changes for all tables in parallel.
  // `deleted: true` ensures soft-deleted rows propagate to the server.
  const deltas = await Promise.all(
    tableNames.map((t) =>
      store[t]!.findMany({
        where: { updatedAt: { $gte: from } },
        deleted: true,
      }),
    ),
  );
  const clientDelta = Object.fromEntries(
    tableNames.map((t, i) => [t, deltas[i]!]),
  );

  // Pagination loop: full delta on first page; empty delta on subsequent pages.
  let pageOffset = 0;
  let hasMore = true;
  const written: Record<string, string[]> = Object.fromEntries(
    tableNames.map((t) => [t, []]),
  );

  while (hasMore) {
    const delta = pageOffset === 0 ? clientDelta : {};
    const result = await fetcher({
      current: to,
      from,
      to,
      delta,
      pageOffset,
      conflictResolution,
    });

    const batchResults = await Promise.all(
      tableNames.map((t) =>
        batchUpsert(
          store[t],
          syncableMetaArraySchema.parse(result?.data?.[t] ?? []),
          batchSize,
        ),
      ),
    );
    tableNames.forEach((t, i) => written[t]!.push(...batchResults[i]!));

    hasMore = result?.hasMore ?? false;
    if (hasMore && result?.pageSize == null) {
      throw new Error(
        'syncClient: server returned hasMore=true without pageSize — cannot advance pagination',
      );
    }
    if (result?.pageSize != null) pageOffset += result.pageSize;
  }

  return { syncedTo: to, written };
}
