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
  /** Max records returned per table per response page. Omit for unbounded. */
  pageSize?: number;
  /**
   * Soft cap on the JSON-serialized size of the pulled window rows per response
   * (bytes). Applied only in per-table paging mode (client sent `pageOffsets`).
   * At least one row is always returned so pagination makes progress. Conflict
   * (`server-wins`) rows are never dropped — they are bounded by the client's
   * own delta and the client would otherwise never learn the server version.
   */
  maxPageBytes?: number;
  /** Max records per `upsertMany` call. Omit for a single call per table. */
  batchSize?: number;
  /** Table names to exclude from sync. Default: `['settings']`. */
  skip?: string[];
};

export type SyncClientParams = {
  /**
   * The only network abstraction. Call your server's `sync` endpoint here.
   * The full client delta is included on the first request (or spread across
   * `pushOnly` requests when it exceeds the push limits); pull continuation
   * requests pass `{}`.
   */
  fetcher: (params: {
    current: Date;
    from: Date;
    to: Date;
    delta: Record<string, SyncableMeta[]>;
    /** Legacy global offset — only sent when talking to an old server. */
    pageOffset?: number;
    /** Per-table pull offsets. `{}` on the first request of a new sync. */
    pageOffsets?: Record<string, number>;
    /** When true the server only applies the delta and returns conflicts. */
    pushOnly?: boolean;
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
  /**
   * Push chunking: when the local delta exceeds either limit, it is split into
   * several `pushOnly` requests instead of one unbounded upload. Keeps request
   * bodies small enough for server-side limits (e.g. Durable Object RPC) and
   * makes retries after a failed push far cheaper.
   */
  maxPushRecords?: number;
  maxPushBytes?: number;
  /**
   * Resume point from a previously failed sync (see `onCheckpoint`). When it
   * matches `from`, the client skips delta collection/push and continues
   * pulling from the stored per-table offsets instead of restarting from page
   * zero — a retry costs only the remaining pages.
   */
  checkpoint?: SyncCheckpoint;
  /**
   * Called with pull progress after each applied page (and with `null` once
   * the sync completes). Persist the value and pass it back as `checkpoint`
   * on the next attempt to resume instead of restarting.
   */
  onCheckpoint?: (checkpoint: SyncCheckpoint | null) => void | Promise<void>;
};

/**
 * Pull progress of a partially completed sync. `from`/`to` freeze the server
 * window; `pageOffsets` holds the next per-table offsets to request.
 */
export type SyncCheckpoint = {
  from: string;
  to: string;
  pageOffsets: Record<string, number>;
};

export type SyncClientResult = {
  /** Persist this as the next `from`. */
  syncedTo: Date;
  /** IDs written per table during this sync, for post-sync revalidation. */
  written: Record<string, string[]>;
  /** Number of local delta records sent to the server. */
  pushed: number;
};

/** Default max records per push chunk. */
export const MAX_PUSH_RECORDS = 500;
/** Default max JSON-serialized bytes per push chunk. */
export const MAX_PUSH_BYTES = 4_000_000;

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
  pageOffsets: z.record(z.string(), z.number().int().nonnegative()).optional(),
  pushOnly: z.boolean().optional(),
  conflictResolution: conflictResolutionSchema.optional(),
});

// ─── Private helpers ───────────────────────────────────────────────────────────

function discoverTables(store: SyncableStore, skip: string[]): string[] {
  const skipSet = new Set(skip);
  return Object.keys(store).filter((t) => !skipSet.has(t));
}

/** Approximate wire size of a record — matches JSON serialization. */
function recordSize(row: SyncableMeta): number {
  return JSON.stringify(row).length;
}

type DeltaResult = {
  tableName: string;
  accepted: SyncableMeta[];
  serverWins: SyncableMeta[];
};

/** Applies the incoming delta with conflict resolution; returns the outcome. */
async function applyDelta(
  store: SyncableStore,
  tableNames: string[],
  delta: Record<string, SyncableMeta[]>,
  conflictResolution: ConflictResolution,
  to: Date,
  batchSize?: number,
): Promise<DeltaResult[]> {
  return Promise.all(
    tableNames.map(async (tableName) => {
      const items = (delta[tableName] ?? []) as SyncableMeta[];
      if (items.length === 0)
        return { tableName, accepted: [], serverWins: [] };

      const table = store[tableName]!;
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

      return { tableName, accepted, serverWins };
    }),
  );
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
 * POST /sync   body: { current, from, to?, delta, pageOffset?, pageOffsets?,
 *                      pushOnly?, conflictResolution? }
 * response:    { data, hasMore, pageSize?, pageOffsets? }
 * ```
 *
 * **Conflict resolution:** controlled by `conflictResolution` in the request body.
 * Defaults to `'lww'`. Applied whenever a non-empty `delta` is sent.
 *
 * **Paging modes:**
 * - `pushOnly: true` — apply the delta only; respond with the conflict
 *   (`server-wins`) rows and no window pull. Used by clients to split a large
 *   delta into several bounded uploads.
 * - `pageOffsets` present — per-table offsets. Only the listed tables are
 *   pulled (`{}` means all tables from offset 0); the response's `pageOffsets`
 *   holds the next offset for every table with more rows, so exhausted tables
 *   are not re-queried on later pages. `options.maxPageBytes` additionally
 *   truncates oversized pages (large rows) without breaking resumption.
 * - `pageOffset` (legacy) — one global offset applied to every table; kept for
 *   backward compatibility with older clients.
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
    pageOffsets,
    pushOnly = false,
    conflictResolution = 'lww',
  } = syncParamsSchema.parse(params);

  const now = new Date();
  const skewMinutes = Math.abs(current.getTime() - now.getTime()) / 60_000;
  if (skewMinutes > CLOCK_SKEW_TOLERANCE_MINUTES) {
    throw new ClockSkewError(current, now);
  }

  const to = rawTo ?? now;
  const {
    pageSize,
    maxPageBytes,
    batchSize,
    skip = ['settings'],
  } = options ?? {};
  const tableNames = discoverTables(store, skip);

  // Apply the client delta first (all modes): accepted rows are stamped
  // syncedAt=to, so the half-open window `$lt: to` below never echoes them.
  const deltaResults = await applyDelta(
    store,
    tableNames,
    delta,
    conflictResolution,
    to,
    batchSize,
  );
  const deltaByTable = new Map(deltaResults.map((r) => [r.tableName, r]));

  if (pushOnly) {
    // Upload-only request: no window pull. Return the conflict rows so the
    // client immediately learns the server versions it must keep.
    const data: Record<string, SyncableMeta[]> = {};
    for (const { tableName, serverWins } of deltaResults) {
      data[tableName] = serverWins;
    }
    return { data, hasMore: false, pageSize };
  }

  const windowWhere = {
    // Half-open on BOTH ends so a device never re-pulls its own pushes:
    // accepted rows are stamped syncedAt=to, so `$lt: to` drops them from
    // this sync, and `$gt: from` (from === the previous sync's `to`) drops
    // them next sync. `syncedTo` stays `to`, so the client's push cursor
    // (updatedAt >= from) is unaffected — no rows are missed on push.
    where: { syncedAt: { $gt: from, $lt: to } },
    deleted: true as const,
  };

  // ── Per-table paging mode ────────────────────────────────────────────────
  if (pageOffsets !== undefined) {
    // `{}` = first page → pull all tables from 0. Otherwise pull only the
    // tables the client still has offsets for — exhausted tables cost nothing.
    const pullNames =
      Object.keys(pageOffsets).length > 0
        ? tableNames.filter((t) => Object.hasOwn(pageOffsets, t))
        : tableNames;

    const fetched = await Promise.all(
      pullNames.map(async (tableName) => {
        const offset = pageOffsets[tableName] ?? 0;
        const rows = await store[tableName]!.findMany({
          ...windowWhere,
          // orderBy is required even without pageSize so byte-budget
          // truncation resumes deterministically.
          orderBy: { syncedAt: 'asc' as const, id: 'asc' as const },
          offset,
          ...(pageSize != null ? { limit: pageSize + 1 } : {}),
        });
        const hadMore = pageSize != null && rows.length > pageSize;
        if (hadMore) rows.pop();
        return { tableName, offset, rows, hadMore };
      }),
    );

    // Byte budget: walk tables in order, keep rows until the budget runs out,
    // then truncate — the per-table offsets make the cut resumable. At least
    // one row overall is always kept so pagination is guaranteed to progress.
    let budget = maxPageBytes ?? Infinity;
    let includedAny = false;
    const data: Record<string, SyncableMeta[]> = {};
    const nextOffsets: Record<string, number> = {};

    for (const { tableName, offset, rows, hadMore } of fetched) {
      let included = rows.length;
      if (budget !== Infinity) {
        included = 0;
        for (const row of rows) {
          const size = recordSize(row);
          if (includedAny && size > budget) break;
          budget -= size;
          included++;
          includedAny = true;
        }
      }
      const kept = rows.slice(0, included);
      const truncated = included < rows.length;

      // Outbound = (kept window rows ∪ server-wins) − accepted
      const d = deltaByTable.get(tableName);
      const outbound = new Map<string, SyncableMeta>();
      for (const row of kept) outbound.set(row.id, row);
      for (const row of d?.serverWins ?? []) outbound.set(row.id, row);
      for (const row of d?.accepted ?? []) outbound.delete(row.id);
      data[tableName] = [...outbound.values()];

      // Offset math counts kept *window* rows (pre-dedup) — the next page
      // must continue after them regardless of outbound merging.
      if (hadMore || truncated) nextOffsets[tableName] = offset + included;
    }

    // Conflict rows for delta tables that were not pulled this page.
    for (const { tableName, serverWins } of deltaResults) {
      if (!(tableName in data) && serverWins.length > 0) {
        data[tableName] = serverWins;
      }
    }

    return {
      data,
      hasMore: Object.keys(nextOffsets).length > 0,
      pageSize,
      pageOffsets: nextOffsets,
    };
  }

  // ── Legacy global-offset mode ────────────────────────────────────────────
  const tableResults = await Promise.all(
    tableNames.map(async (tableName) => {
      const table = store[tableName]!;

      const windowQuery = {
        ...windowWhere,
        ...(pageSize != null
          ? {
              orderBy: { syncedAt: 'asc' as const, id: 'asc' as const },
              limit: pageSize + 1,
              offset: pageOffset,
            }
          : {}),
      };

      const rows = await table.findMany(windowQuery);
      const hadMore = pageSize != null && rows.length > pageSize;
      if (hadMore) rows.pop();

      const d = deltaByTable.get(tableName);
      if (!d || (d.accepted.length === 0 && d.serverWins.length === 0)) {
        return { tableName, rows, hadMore };
      }

      // Outbound = (window records ∪ server-wins) − accepted
      const outbound = new Map<string, SyncableMeta>();
      for (const item of rows) outbound.set(item.id, item);
      for (const item of d.serverWins) outbound.set(item.id, item);
      for (const item of d.accepted) outbound.delete(item.id);

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

/** Splits a delta into chunks bounded by record count and serialized bytes. */
function chunkDelta(
  delta: Record<string, SyncableMeta[]>,
  maxRecords: number,
  maxBytes: number,
): Record<string, SyncableMeta[]>[] {
  const chunks: Record<string, SyncableMeta[]>[] = [];
  let current: Record<string, SyncableMeta[]> = {};
  let count = 0;
  let bytes = 0;
  for (const [tableName, rows] of Object.entries(delta)) {
    for (const row of rows) {
      const size = recordSize(row);
      if (count > 0 && (count + 1 > maxRecords || bytes + size > maxBytes)) {
        chunks.push(current);
        current = {};
        count = 0;
        bytes = 0;
      }
      (current[tableName] ??= []).push(row);
      count++;
      bytes += size;
    }
  }
  if (count > 0) chunks.push(current);
  return chunks;
}

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
 * **Push chunking:** a delta above `maxPushRecords`/`maxPushBytes` is uploaded
 * as several bounded `pushOnly` requests before the pull starts, instead of one
 * unbounded body.
 *
 * **Pagination:** the client loops until the server reports no more pages.
 * Against a per-table-offset server it echoes back the response's
 * `pageOffsets`; against a legacy server it falls back to advancing the global
 * `pageOffset` by the server-provided `pageSize` (whose absence with
 * `hasMore=true` throws).
 *
 * **Resume:** pass `onCheckpoint`/`checkpoint` (see `SyncClientParams`) to
 * continue a failed sync from the last applied page instead of restarting.
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
    maxPushRecords = MAX_PUSH_RECORDS,
    maxPushBytes = MAX_PUSH_BYTES,
    checkpoint,
    onCheckpoint,
  } = params;

  // syncClient shares the same skip default as sync() — both ends skip 'settings'
  // unless the caller overrides (e.g. to also drop device-local tables).
  const tableNames = discoverTables(store, skip);
  const written: Record<string, string[]> = Object.fromEntries(
    tableNames.map((t) => [t, []]),
  );

  const applyData = async (result: SyncResult | undefined) => {
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
  };

  // A checkpoint is only valid for the exact same window start; `from` moves
  // only after a fully successful sync, so a mismatch means it is stale.
  const resume =
    checkpoint !== undefined && checkpoint.from === from.toISOString();

  let to: Date;
  let pushed = 0;
  let result: SyncResult | undefined;

  if (resume) {
    // Continue pulling the frozen window; the delta was already pushed by the
    // failed attempt (checkpoints are only written after the push succeeded).
    to = new Date(checkpoint.to);
    result = await fetcher({
      current: new Date(),
      from,
      to,
      delta: {},
      pageOffsets: checkpoint.pageOffsets,
      conflictResolution,
    });
  } else {
    to = new Date();

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
    pushed = deltas.reduce((n, rows) => n + rows.length, 0);

    const overRecords = pushed > maxPushRecords;
    const overBytes =
      overRecords ||
      deltas.reduce(
        (n, rows) => n + rows.reduce((m, r) => m + recordSize(r), 0),
        0,
      ) > maxPushBytes;

    if (overRecords || overBytes) {
      // Large delta: upload in bounded pushOnly chunks, then pull separately.
      for (const chunk of chunkDelta(
        clientDelta,
        maxPushRecords,
        maxPushBytes,
      )) {
        const pushResult = await fetcher({
          current: new Date(),
          from,
          to,
          delta: chunk,
          pushOnly: true,
          conflictResolution,
        });
        await applyData(pushResult); // conflict (server-wins) rows
      }
      result = await fetcher({
        current: new Date(),
        from,
        to,
        delta: {},
        pageOffset: 0,
        pageOffsets: {},
        conflictResolution,
      });
    } else {
      result = await fetcher({
        current: new Date(),
        from,
        to,
        delta: clientDelta,
        pageOffset: 0,
        pageOffsets: {},
        conflictResolution,
      });
    }
  }

  // Pull loop: prefer per-table offsets (resumable, skips exhausted tables);
  // fall back to the legacy global offset against older servers.
  let legacyOffset = 0;
  while (true) {
    await applyData(result);

    const offsets = result?.pageOffsets;
    if (offsets && Object.keys(offsets).length > 0) {
      await onCheckpoint?.({
        from: from.toISOString(),
        to: to.toISOString(),
        pageOffsets: offsets,
      });
      result = await fetcher({
        current: new Date(),
        from,
        to,
        delta: {},
        pageOffsets: offsets,
        conflictResolution,
      });
      continue;
    }

    if (result?.hasMore) {
      if (result.pageSize == null) {
        throw new Error(
          'syncClient: server returned hasMore=true without pageSize — cannot advance pagination',
        );
      }
      legacyOffset += result.pageSize;
      result = await fetcher({
        current: new Date(),
        from,
        to,
        delta: {},
        pageOffset: legacyOffset,
        conflictResolution,
      });
      continue;
    }

    break;
  }

  if (resume) {
    // Pages applied by the failed attempt are not in `written`. Reconstruct
    // them from the local store: pulled rows carry the server's syncedAt,
    // which lies inside the frozen (from, to) window.
    await Promise.all(
      tableNames.map(async (t) => {
        const rows = await store[t]!.findMany({
          where: { syncedAt: { $gt: from, $lt: to } },
          deleted: true,
        });
        const seen = new Set(written[t]);
        for (const row of rows) {
          if (!seen.has(row.id)) written[t]!.push(row.id);
        }
      }),
    );
  }

  await onCheckpoint?.(null);
  return { syncedTo: to, written, pushed };
}
