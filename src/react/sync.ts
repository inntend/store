import { useEffect, useRef, useState } from 'react';
import {
  type AnyTableDef,
  type ConflictResolution,
  type Store,
  type SyncableStore,
  type SyncClientParams,
  syncClient,
} from '../store';

/** Auto-sync interval when online (ms). Override per hook via `refreshInterval`. */
export const SYNC_REFRESH_INTERVAL_MS = 30_000;

/** Initial backoff delay when offline (ms). Doubles on each failure. */
export const BACKOFF_INITIAL_MS = 5_000;

/** Maximum backoff delay when offline (ms). */
export const BACKOFF_MAX_MS = 60_000;

export type UseSyncOptions = {
  /**
   * The only network abstraction — call your server's `sync` endpoint here.
   * Receives `{ current, from, to, delta, pageOffset, conflictResolution? }`.
   * On page 0 the full client delta is included; subsequent pages pass `{}`.
   */
  fetcher: SyncClientParams['fetcher'];
  /** Max records per `upsertMany` call. */
  batchSize?: number;
  /**
   * Fallback `from` date used when `lastSynced` has never been persisted.
   */
  defaultFrom: Date;
  /**
   * Override the store used for sync table operations. When omitted the store
   * from the nearest `StoreContext.Provider` is used. Useful in tests to inject
   * a mock store without wrapping in a full provider.
   */
  store?: SyncableStore;
  /**
   * How often to automatically trigger sync when online (ms).
   * Defaults to SYNC_REFRESH_INTERVAL_MS. Pass 0 to disable auto-refresh.
   * Manual calls to sync() remain available regardless of this setting.
   */
  refreshInterval?: number;
};

/** `'online'` — sync runs normally. `'offline'` / `'disabled'` — `sync()` is a no-op. */
export type SyncState = 'online' | 'offline' | 'disabled';

export type UseSyncResult = {
  /**
   * Trigger a sync. Drops the call if one is already in flight or if
   * `syncState` is `'disabled'`. Callers may trigger manually while
   * `'offline'`; a successful sync transitions the state back to `'online'`.
   * Always syncs from `lastSynced` (or `defaultFrom` if never synced).
   */
  sync: () => Promise<void>;
  syncing: boolean;
  /** ISO string of the last successful sync, or `undefined` before the first. */
  lastSynced: string | undefined;
  /** Current sync state. Only `'online'` allows sync to run. */
  syncState: SyncState;
  setSyncState: (state: SyncState) => void;
};

/**
 * Factory that builds a `useSync` hook bound to a specific store getter.
 * Used internally by `createStoreContext` and `createEncryptedStoreContext`.
 *
 * - Reads `lastSynced` and `conflictResolution` from the store's settings on mount.
 * - Persists `syncedTo` back to settings after each successful sync.
 * - All mutable values (fetcher, batchSize, defaultFrom, conflictResolution) are
 *   read through refs inside timer callbacks so interval/backoff retries always
 *   see the latest option values even without re-registering the effect.
 * - Guards against concurrent calls via `syncingRef`.
 * - Detects network errors and transitions syncState to 'offline', then
 *   retries with exponential backoff until a sync succeeds.
 * - Auto-syncs on a configurable interval while online.
 */
export function buildUseSync<TDefs extends Record<string, AnyTableDef>>(
  getStore: () => Store<TDefs>,
  getSyncState: () => {
    syncState: SyncState;
    setSyncState: (state: SyncState) => void;
  },
  getCheckAndFix?: () =>
    | ((written: Record<string, string[]>) => Promise<void>)
    | undefined,
) {
  return function useSync(options: UseSyncOptions): UseSyncResult {
    const ctxStore = getStore();
    // options.store overrides the context store for sync table operations.
    // Settings (lastSynced) always come from the context store.
    const syncStore =
      options.store ?? (ctxStore.table as unknown as SyncableStore);
    const [syncing, setSyncing] = useState(false);
    const syncingRef = useRef<boolean>(false);
    const [lastSynced, setLastSyncedState] = useState<string | undefined>(
      undefined,
    );
    const lastSyncedRef = useRef<string | undefined>(undefined);
    lastSyncedRef.current = lastSynced;

    const [conflictResolution, setConflictResolution] = useState<
      ConflictResolution | undefined
    >(undefined);
    const conflictResolutionRef = useRef<ConflictResolution | undefined>(
      undefined,
    );
    conflictResolutionRef.current = conflictResolution;

    const optionsRef = useRef(options);
    optionsRef.current = options;

    const checkAndFixRef = useRef<
      ((written: Record<string, string[]>) => Promise<void>) | undefined
    >(undefined);
    checkAndFixRef.current = getCheckAndFix?.();

    const { syncState, setSyncState } = getSyncState();
    const syncStateRef = useRef<SyncState>('online');
    syncStateRef.current = syncState;

    // Backoff and auto-refresh state
    const [retryTrigger, setRetryTrigger] = useState(0);
    const backoffDelayRef = useRef(BACKOFF_INITIAL_MS);
    const refreshIntervalRef = useRef(
      options.refreshInterval ?? SYNC_REFRESH_INTERVAL_MS,
    );
    refreshIntervalRef.current =
      options.refreshInterval ?? SYNC_REFRESH_INTERVAL_MS;

    useEffect(() => {
      Promise.all([
        ctxStore.settings.get('lastSynced'),
        ctxStore.settings.get('conflictResolution'),
      ]).then(([ls, cr]) => {
        if (ls !== undefined) setLastSyncedState(ls);
        if (cr !== undefined) setConflictResolution(cr);
      });
    }, [ctxStore.settings]);

    // Internal implementation — no syncState guard. Used by timers so that
    // the backoff retry can fire while syncState is 'offline'.
    // All mutable values are read through refs so interval callbacks always
    // see the latest options (fetcher, batchSize, defaultFrom, conflictResolution)
    // even when the hook re-renders without triggering a new effect.
    const runSync = async () => {
      const state = syncStateRef.current;
      if (state === 'disabled') return;
      if (syncingRef.current) return;
      syncingRef.current = true;
      setSyncing(true);
      const { fetcher, batchSize, defaultFrom } = optionsRef.current;
      const from = lastSyncedRef.current
        ? new Date(lastSyncedRef.current)
        : defaultFrom;
      try {
        const { syncedTo, written } = await syncClient(syncStore, from, {
          fetcher,
          batchSize,
          conflictResolution: conflictResolutionRef.current,
        });
        const checkAndFix = checkAndFixRef.current;
        if (
          checkAndFix &&
          Object.values(written).some((ids) => ids.length > 0)
        ) {
          try {
            await checkAndFix(written);
          } catch (err) {
            console.error('[useSync] checkAndFix failed:', err);
          }
        }
        const iso = syncedTo.toISOString();
        ctxStore.settings.set('lastSynced', iso);
        setLastSyncedState(iso);
        // Success: reset backoff, restore online if we were offline.
        backoffDelayRef.current = BACKOFF_INITIAL_MS;
        if (syncStateRef.current === 'offline')
          setSyncState('online');
      } catch (err) {
        console.error(
          '[useSync] sync failed:',
          err instanceof Error
            ? `${err.constructor.name}: ${err.message}`
            : err,
          err,
        );
        // Failure: go offline and trigger backoff (no-op when disabled)
        if (syncStateRef.current !== 'disabled') {
          setSyncState('offline');
          setRetryTrigger((n) => n + 1);
        }
      } finally {
        syncingRef.current = false;
        setSyncing(false);
      }
    };

    // Public API — blocked only when state is 'disabled'. Callers may manually
    // trigger a retry while 'offline'; runSync will go offline→online on success.
    const sync = async () => {
      if (syncStateRef.current === 'disabled') return;
      return runSync();
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: runSync reads all mutable state via refs; retryTrigger is a trigger-only dep not referenced in the body
    useEffect(() => {
      if (syncState === 'disabled') return;

      if (syncState === 'online') {
        // Reset backoff on entry to online (covers disabled→online transition too)
        backoffDelayRef.current = BACKOFF_INITIAL_MS;
        void runSync();
        const interval = refreshIntervalRef.current;
        if (interval <= 0) return;
        const id = setInterval(() => {
          void runSync();
        }, interval);
        return () => clearInterval(id);
      }

      // offline: one-shot backoff retry.
      // retryTrigger increments on each failure so this effect re-runs
      // even when syncState stays 'offline' across repeated failures.
      const delay = backoffDelayRef.current;
      backoffDelayRef.current = Math.min(delay * 2, BACKOFF_MAX_MS);
      const id = setTimeout(() => {
        void runSync();
      }, delay);
      return () => clearTimeout(id);
    }, [syncState, retryTrigger]);

    return { sync, syncing, lastSynced, syncState, setSyncState };
  };
}
