import { z } from 'zod';
import { createFindQuerySchema, type FindQuery } from './filter';
import type { AnyTableDef, TableDef } from './table';
import {
  batchUpsert,
  type SyncableMeta,
  type SyncableStore,
  type SyncResult,
  syncableMetaArraySchema,
} from './utils';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Maps a store definition to per-table type-safe pull queries (all keys optional). */
export type PullQueriesFor<T extends Record<string, AnyTableDef>> = {
  [K in keyof T]?: T[K] extends TableDef<infer S, infer _PK, infer _Out>
    ? FindQuery<S>
    : never;
};

/** Per-table query forwarded from client to server in a pull request. */
export type PullQuery = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>;
  limit?: number;
  offset?: number;
  deleted?: true;
};

/**
 * A Zod schema or a `TableDef`-shaped object (which has a `.schema` property).
 * Both forms are accepted by `pull()` — the `TableDef` form lets you pass your
 * store definition directly without extracting the schema manually.
 */
type PullSchemaEntry =
  | z.ZodObject<z.ZodRawShape>
  | { schema: z.ZodObject<z.ZodRawShape> };

/**
 * Map of table name → Zod schema (or TableDef) passed to `pull()` on the server.
 * Only tables present in this map are queryable; any other table name in the
 * request is rejected. Each schema is used to validate the incoming `where`
 * and `orderBy` fields via `createFindQuerySchema`, so only known field names
 * and correct operator types are accepted.
 */
export type PullSchemas = Record<string, PullSchemaEntry>;

function resolveSchema(entry: PullSchemaEntry): z.ZodObject<z.ZodRawShape> {
  return entry instanceof z.ZodObject ? entry : entry.schema;
}

export type PullClientParams = {
  /**
   * The only network abstraction. Call your server's `pull` endpoint here.
   * `pageOffset` advances automatically on subsequent pages.
   */
  fetcher: (params: {
    queries: Record<string, PullQuery>;
    pageOffset: number;
  }) => Promise<SyncResult | undefined>;
  /** Per-table query — full `where`/`orderBy`/`limit`/`offset`/`deleted` support. */
  queries: Record<string, PullQuery>;
  /** Max records per `upsertMany` call on the client side. */
  batchSize?: number;
};

// ─── pull ──────────────────────────────────────────────────────────────────────

/**
 * Server-side one-way pull. Validates each table's incoming query against its
 * Zod schema — only tables present in `schemas` are queryable, and only valid
 * field names / operator types are accepted. Unknown tables in the request body
 * are rejected with a `ZodError`.
 *
 * **Pagination:** when `pageSize` is set, each table's result is limited to
 * `pageSize` records per page. `pageOffset` advances the window across pages
 * (applied on top of the query's own `offset`, if any).
 *
 * @example
 * // Hono
 * app.post('/pull', async (c) => {
 *   const result = await pull(store, await c.req.json(), schemas, { pageSize: 200 });
 *   return c.json(result);
 * });
 */
export async function pull(
  store: SyncableStore,
  params: unknown,
  schemas: PullSchemas,
  options?: { pageSize?: number },
): Promise<SyncResult> {
  const { pageSize } = options ?? {};

  // Parse the outer envelope: queries must be a record, pageOffset optional.
  const { queries, pageOffset = 0 } = z
    .object({
      queries: z.record(z.string(), z.unknown()),
      pageOffset: z.number().int().nonnegative().optional(),
    })
    .parse(params);

  const tableResults = await Promise.all(
    Object.entries(queries).map(async ([tableName, rawQuery]) => {
      // Reject tables not declared in schemas — unknown table names are an error.
      const schema = schemas[tableName];
      if (!schema) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['queries', tableName],
            message: `Unknown table '${tableName}'.`,
            input: rawQuery,
          },
        ]);
      }

      // Validate the query against the table's schema — rejects unknown fields
      // and wrong operator types (e.g. $gte on a string field).
      const query = createFindQuerySchema(resolveSchema(schema)).parse(
        rawQuery,
      );

      const effectiveQuery = {
        ...query,
        offset: (query.offset ?? 0) + pageOffset,
        ...(pageSize != null
          ? {
              orderBy: query.orderBy ?? { id: 'asc' as const },
              limit: pageSize + 1,
            }
          : {}),
      };
      const rows = await store[tableName]!.findMany(effectiveQuery);
      const hadMore = pageSize != null && rows.length > pageSize;
      if (hadMore) rows.pop();
      return { tableName, rows, hadMore };
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

// ─── pullClient ────────────────────────────────────────────────────────────────

/**
 * Client-side pull orchestration: calls the server's `pull` endpoint via
 * `fetcher` and writes the response into the local store. Server data always
 * wins (full overwrite). Handles pagination automatically.
 *
 * Tables present in `queries` but absent from `store` are silently skipped.
 * The server must include `pageSize` in every response where `hasMore=true`;
 * omitting it throws.
 *
 * ```ts
 * await pullClient(store, {
 *   queries: { notes: { where: { projectId: { $eq: 'p1' } }, orderBy: { updatedAt: 'desc' } } },
 *   fetcher: (p) => fetch('/pull', { method: 'POST', body: JSON.stringify(p) }).then(r => r.json()),
 * });
 * ```
 */
export async function pullClient(
  store: SyncableStore,
  params: PullClientParams,
): Promise<Record<string, string[]>> {
  const { fetcher, queries, batchSize } = params;
  const tableNames = Object.keys(queries).filter((t) => t in store);
  const written: Record<string, string[]> = {};

  let pageOffset = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await fetcher({ queries, pageOffset });

    const pageWritten = await Promise.all(
      tableNames.map(async (t) => {
        const ids = await batchUpsert(
          store[t]!,
          syncableMetaArraySchema.parse(result?.data?.[t] ?? []),
          batchSize,
        );
        return [t, ids] as [string, string[]];
      }),
    );

    for (const [t, ids] of pageWritten) {
      written[t] = [...(written[t] ?? []), ...ids];
    }

    hasMore = result?.hasMore ?? false;
    if (hasMore && result?.pageSize == null) {
      throw new Error(
        'pullClient: server returned hasMore=true without pageSize — cannot advance pagination',
      );
    }
    if (result?.pageSize != null) pageOffset += result.pageSize;
  }

  return written;
}
