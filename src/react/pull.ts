import { useEffect, useRef, useState } from 'react';
import type { AnyTableDef, Store } from '../store';
import type {
  PullClientParams,
  PullQueriesFor,
  PullQuery,
  PullSchemas,
} from '../store/pull';
import { pullClient } from '../store/pull';
import type { SyncableStore } from '../store/utils';
import type { SyncState } from './sync';

export type { PullQuery, PullSchemas };

export type UsePullOptions<
  TDefs extends Record<string, AnyTableDef> = Record<string, AnyTableDef>,
> = {
  /**
   * The only network abstraction — call your server's `pull` endpoint here.
   * Receives `{ queries, pageOffset }`.
   */
  fetcher: PullClientParams['fetcher'];
  /** Per-table queries — full `where`/`orderBy`/`limit`/`offset`/`deleted` support. */
  queries: PullQueriesFor<TDefs>;
  /** Max records per `upsertMany` call on the client side. */
  batchSize?: number;
  /**
   * Override the store used for pull table operations. When omitted the store
   * from the nearest `StoreContext.Provider` is used. Useful in tests to inject
   * a mock store without wrapping in a full provider.
   */
  store?: SyncableStore;
};

export type UsePullResult = {
  /**
   * Trigger a pull. Drops the call if one is already in flight or if
   * `syncState` is not `'online'`.
   */
  pull: () => Promise<void>;
  pulling: boolean;
};

/**
 * Factory that builds a `usePull` hook bound to a specific store getter.
 * Used internally by `createStoreContext` and `createEncryptedStoreContext`.
 *
 * Respects `syncState` — only runs when state is `'online'`.
 * Guards against concurrent calls via a ref.
 */
export function buildUsePull<TDefs extends Record<string, AnyTableDef>>(
  getStore: () => Store<TDefs>,
  getSyncState: () => { syncState: SyncState },
) {
  return function usePull(options: UsePullOptions<TDefs>): UsePullResult {
    const ctxStore = getStore();
    const syncStore =
      options.store ?? (ctxStore.table as unknown as SyncableStore);

    const [pulling, setPulling] = useState(false);
    const pullingRef = useRef(false);
    const { syncState } = getSyncState();
    const syncStateRef = useRef<SyncState>('online');
    syncStateRef.current = syncState;

    const pull = async () => {
      if (syncStateRef.current !== 'online') return;
      if (pullingRef.current) return;
      pullingRef.current = true;
      setPulling(true);
      try {
        await pullClient(syncStore, {
          fetcher: options.fetcher,
          queries: options.queries as Record<string, PullQuery>,
          batchSize: options.batchSize,
        });
      } finally {
        pullingRef.current = false;
        setPulling(false);
      }
    };

    return { pull, pulling };
  };
}

/** True when every point of `query` is covered by at least one interval in `ranges`. */
function isRangeCovered(
  ranges: { from: string; to: string }[] | undefined,
  query: { from: string; to: string },
): boolean {
  if (!ranges?.length) return false;
  const sorted = ranges
    .filter((r) => r.to >= query.from && r.from <= query.to)
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  let cursor = query.from;
  for (const r of sorted) {
    if (r.from > cursor) return false;
    if (r.to > cursor) cursor = r.to;
    if (cursor >= query.to) return true;
  }
  return false;
}

/** Merges `newRange` into `existing` and returns a minimal non-overlapping sorted list. */
function mergeRanges(
  existing: { from: string; to: string }[] | undefined,
  newRange: { from: string; to: string },
): { from: string; to: string }[] {
  const combined = [...(existing ?? []), newRange].sort((a, b) =>
    a.from < b.from ? -1 : 1,
  );
  const out: { from: string; to: string }[] = [];
  for (const r of combined) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Per-table entry for `useAutoPull`. Either pull all data or a specific date range. */
export type AutoPullEntry =
  | { full: true }
  | {
      /** Date window to pull for this table. */
      range: { from: Date; to: Date };
      /** Schema field to filter against (e.g. `'updatedAt'`, `'date'`). Not stored in settings. */
      field: string;
    };

/** Per-table pull configuration — replaces both `queries` and `coverageRange`. */
export type AutoPullTables<
  TDefs extends Record<string, AnyTableDef> = Record<string, AnyTableDef>,
> = {
  [K in keyof TDefs]?: AutoPullEntry;
};

export type UseAutoPullOptions<
  TDefs extends Record<string, AnyTableDef> = Record<string, AnyTableDef>,
> = {
  fetcher: PullClientParams['fetcher'];
  /**
   * Per-table pull configuration. For each table, either:
   * - `{ full: true }` — pull all data (recorded in settings so it is not repeated)
   * - `{ range: { from, to }, field }` — pull the date window filtering on `field`
   */
  tables: AutoPullTables<TDefs>;
  batchSize?: number;
  store?: SyncableStore;
};

export type UseAutoPullResult = {
  pulling: boolean;
};

/**
 * Factory that builds a `useAutoPull` hook bound to a specific store getter.
 * Used internally by `createStoreContext` and `createEncryptedStoreContext`.
 *
 * Fires automatically on mount and whenever any table's coverage config changes or
 * `syncState` returns to `'online'`. Checks per-table coverage records in
 * settings and only calls the fetcher for uncovered tables/ranges.
 */
export function buildUseAutoPull<TDefs extends Record<string, AnyTableDef>>(
  getStore: () => Store<TDefs>,
  getSyncState: () => { syncState: SyncState },
  getCheckAndFix?: () =>
    | ((written: Record<string, string[]>) => Promise<void>)
    | undefined,
) {
  return function useAutoPull(
    options: UseAutoPullOptions<TDefs>,
  ): UseAutoPullResult {
    const ctxStore = getStore();
    const { syncState } = getSyncState();
    const syncStateRef = useRef<SyncState>('online');
    syncStateRef.current = syncState;

    const optionsRef = useRef(options);
    optionsRef.current = options;

    const [pulling, setPulling] = useState(false);
    const pullingRef = useRef(false);
    const checkAndFixRef = useRef<
      ((written: Record<string, string[]>) => Promise<void>) | undefined
    >(undefined);
    checkAndFixRef.current = getCheckAndFix?.();

    // Stable dep string capturing each table's coverage config (field excluded — not stored).
    const coverageKey = JSON.stringify(
      Object.keys(options.tables)
        .sort()
        .map((k) => {
          const e = options.tables[k as keyof typeof options.tables];
          if (!e || !('range' in e)) return [k, 'full'];
          return [k, e.range.from.toISOString(), e.range.to.toISOString()];
        }),
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: mutable state is read via refs
    useEffect(() => {
      if (syncStateRef.current !== 'online') return;
      if (pullingRef.current) return;

      const run = async () => {
        const { fetcher, tables, batchSize, store } = optionsRef.current;
        const syncStore = store ?? (ctxStore.table as unknown as SyncableStore);
        const tableEntries = Object.entries(tables).filter(
          (pair): pair is [string, AutoPullEntry] => pair[1] !== undefined,
        );

        const pullStore = (await ctxStore.settings.get('pull')) ?? {};

        // Single pass: determine which tables are uncovered and build their queries.
        const uncoveredEntries: [string, AutoPullEntry][] = [];
        const queries: Record<string, PullQuery> = {};
        for (const [t, entry] of tableEntries) {
          const isCovered = !('range' in entry)
            ? pullStore[t]?.full === true
            : pullStore[t]?.full === true ||
              isRangeCovered(pullStore[t]?.ranges, {
                from: entry.range.from.toISOString(),
                to: entry.range.to.toISOString(),
              });
          if (isCovered) continue;
          uncoveredEntries.push([t, entry]);
          if (!('range' in entry)) {
            queries[t] = {};
          } else {
            queries[t] = {
              where: {
                [entry.field]: {
                  $gte: entry.range.from,
                  $lte: entry.range.to,
                },
              },
            };
          }
        }
        if (uncoveredEntries.length === 0) return;

        // Re-check guards after async settings read
        if (syncStateRef.current !== 'online') return;
        if (pullingRef.current) return;
        pullingRef.current = true;
        setPulling(true);
        try {
          const written = await pullClient(syncStore, {
            fetcher,
            queries,
            batchSize,
          });
          const checkAndFix = checkAndFixRef.current;
          if (checkAndFix) await checkAndFix(written);

          const updated = { ...pullStore };
          for (const [table, entry] of uncoveredEntries) {
            const existing = updated[table] ?? {};
            if (!('range' in entry)) {
              updated[table] = { ...existing, full: true };
            } else {
              const r = {
                from: entry.range.from.toISOString(),
                to: entry.range.to.toISOString(),
              };
              updated[table] = {
                ...existing,
                ranges: mergeRanges(existing.ranges, r),
              };
            }
          }
          await ctxStore.settings.set('pull', updated);
        } finally {
          pullingRef.current = false;
          setPulling(false);
        }
      };

      void run();
    }, [coverageKey, syncState]);

    return { pulling };
  };
}
