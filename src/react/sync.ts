import { useEffect, useRef, useState } from 'react';
import {
  type AnyTableDef,
  type ConflictResolution,
  type Store,
  type SyncableStore,
  type SyncCheckpoint,
  type SyncClientParams,
  syncClient,
} from '../store';

/** Auto-sync interval when online (ms). Override per hook via `refreshInterval`. */
export const SYNC_REFRESH_INTERVAL_MS = 30_000;

/**
 * Ceiling for the adaptive idle interval (ms). After each sync that moved no
 * data in either direction the auto-sync delay doubles, up to this cap; any
 * data movement resets it to `refreshInterval`. Override via
 * `maxRefreshInterval`.
 */
export const SYNC_MAX_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Initial backoff delay when offline (ms). Doubles on each failure. */
export const BACKOFF_INITIAL_MS = 5_000;

/** Maximum backoff delay when offline (ms). */
export const BACKOFF_MAX_MS = 5 * 60_000;

/** ±20% randomization so many clients don't retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * `true` for errors where retrying cannot help (client errors such as 401/409,
 * excluding 408 timeout and 429 rate-limit). Detected via a numeric `status`
 * property on the error — attach it in your fetcher.
 */
function isNonRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

export type UseSyncOptions = {
  /**
   * The only network abstraction — call your server's `sync` endpoint here.
   * Receives `{ current, from, to, delta, pageOffset?, pageOffsets?,
   * pushOnly?, conflictResolution? }`. Attach the HTTP status code as a
   * `status` property on thrown errors so non-retryable failures (4xx) back
   * off immediately instead of ramping up.
   */
  fetcher: SyncClientParams['fetcher'];
  /** Max records per `upsertMany` call. */
  batchSize?: number;
  /**
   * Table names to exclude from sync. Default: `['settings']`. A caller-provided
   * list replaces the default (include `'settings'` to keep skipping it). Use to
   * keep device-local/ephemeral tables out of the synced delta. See
   * `SyncClientParams.skip`.
   */
  skip?: string[];
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
  /**
   * Ceiling for the adaptive idle interval (ms). Defaults to
   * SYNC_MAX_REFRESH_INTERVAL_MS (or `refreshInterval` when that is larger).
   */
  maxRefreshInterval?: number;
};

/** `'online'` — sync runs normally. `'offline'` / `'disabled'` — `sync()` is a no-op. */
export type SyncState = 'online' | 'offline' | 'disabled';

export type UseSyncResult = {
  /**
   * Trigger a sync. If one is already in flight, a single follow-up run is
   * queued (so a burst of mutations coalesces into at most one extra request).
   * No-op while `syncState` is `'disabled'` or before settings have loaded.
   * Callers may trigger manually while `'offline'`; a successful sync
   * transitions the state back to `'online'`. Always syncs from `lastSynced`
   * (or `defaultFrom` if never synced).
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
 * - Reads `lastSynced`, `conflictResolution`, and `syncCheckpoint` from the
 *   store's settings on mount; no sync runs until that read completes, so the
 *   first auto-sync never mistakenly starts from `defaultFrom` while a real
 *   `lastSynced` exists.
 * - Persists `syncedTo` back to settings after each successful sync, and pull
 *   progress (`syncCheckpoint`) after each page — a failed multi-page sync
 *   resumes from where it stopped instead of restarting from page zero.
 * - All mutable values (fetcher, batchSize, defaultFrom, conflictResolution) are
 *   read through refs inside timer callbacks so interval/backoff retries always
 *   see the latest option values even without re-registering the effect.
 * - Guards against concurrent calls via `syncingRef`; manual calls during an
 *   in-flight sync queue one coalesced follow-up run.
 * - Detects network errors and transitions syncState to 'offline', then
 *   retries with jittered exponential backoff until a sync succeeds.
 *   Non-retryable errors (4xx) park at the maximum backoff immediately.
 * - Auto-syncs on an adaptive interval while online: quiet syncs (no data
 *   moved) double the delay up to `maxRefreshInterval`; any data movement
 *   resets it. Ticks are skipped while the document is hidden and a sync runs
 *   as soon as it becomes visible again.
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
    const pendingRef = useRef(false);
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

    // Sync must not run before the persisted settings are loaded — otherwise
    // the first tick would sync from `defaultFrom` and re-pull everything.
    // Auto-sync gates on the state; manual sync() awaits the promise.
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    const settingsReadyRef = useRef<Promise<void> | undefined>(undefined);
    const checkpointRef = useRef<SyncCheckpoint | undefined>(undefined);

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
    // Delay before the next auto-sync tick — adaptively stretched while idle.
    const nextDelayRef = useRef(refreshIntervalRef.current);

    useEffect(() => {
      settingsReadyRef.current = Promise.all([
        ctxStore.settings.get('lastSynced'),
        ctxStore.settings.get('conflictResolution'),
        ctxStore.settings.get('syncCheckpoint'),
      ]).then(([ls, cr, cp]) => {
        // Write the refs directly too: a manual sync() awaiting this promise
        // must see the loaded values before React re-renders.
        if (ls !== undefined) {
          lastSyncedRef.current = ls;
          setLastSyncedState(ls);
        }
        if (cr !== undefined) {
          conflictResolutionRef.current = cr;
          setConflictResolution(cr);
        }
        checkpointRef.current = cp as SyncCheckpoint | undefined;
        setSettingsLoaded(true);
      });
    }, [ctxStore.settings]);

    // Internal implementation — no syncState guard. Used by timers so that
    // the backoff retry can fire while syncState is 'offline'.
    // All mutable values are read through refs so interval callbacks always
    // see the latest options (fetcher, batchSize, defaultFrom, conflictResolution)
    // even when the hook re-renders without triggering a new effect.
    const runSync = async (coalesce = false) => {
      const state = syncStateRef.current;
      if (state === 'disabled') return;
      if (syncingRef.current) {
        // Queue exactly one follow-up so a burst of mutation-triggered calls
        // is not silently dropped (its data would otherwise wait a full tick).
        if (coalesce) pendingRef.current = true;
        return;
      }
      syncingRef.current = true;
      setSyncing(true);
      const { fetcher, batchSize, skip, defaultFrom } = optionsRef.current;
      const from = lastSyncedRef.current
        ? new Date(lastSyncedRef.current)
        : defaultFrom;
      try {
        const { syncedTo, written, pushed } = await syncClient(
          syncStore,
          from,
          {
            fetcher,
            batchSize,
            skip,
            conflictResolution: conflictResolutionRef.current,
            checkpoint: checkpointRef.current,
            onCheckpoint: async (cp) => {
              // Skip the settings write when there is nothing to clear —
              // most syncs are single-page and never create a checkpoint.
              if (cp == null && checkpointRef.current === undefined) return;
              checkpointRef.current = cp ?? undefined;
              if (cp) await ctxStore.settings.set('syncCheckpoint', cp);
              else await ctxStore.settings.delete('syncCheckpoint');
            },
          },
        );
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
        // Update the ref directly so a coalesced follow-up run (which starts
        // before React re-renders) syncs from the fresh cursor.
        lastSyncedRef.current = iso;
        setLastSyncedState(iso);
        // Success: reset backoff, restore online if we were offline.
        backoffDelayRef.current = BACKOFF_INITIAL_MS;
        if (syncStateRef.current === 'offline') setSyncState('online');
        // Adapt the auto-sync cadence: quiet syncs stretch the delay, any
        // data movement snaps it back to the base interval.
        const base = refreshIntervalRef.current;
        const cap = Math.max(
          base,
          optionsRef.current.maxRefreshInterval ?? SYNC_MAX_REFRESH_INTERVAL_MS,
        );
        const quiet =
          pushed === 0 && Object.values(written).every((ids) => !ids.length);
        nextDelayRef.current = quiet
          ? Math.min(Math.max(nextDelayRef.current, base) * 2, cap)
          : base;
      } catch (err) {
        console.error(
          '[useSync] sync failed:',
          err instanceof Error
            ? `${err.constructor.name}: ${err.message}`
            : err,
          err,
        );
        // Failure: go offline and trigger backoff (no-op when disabled).
        // 4xx errors (bad auth, clock skew, …) won't heal by hammering —
        // park at the maximum backoff immediately.
        if (isNonRetryable(err)) backoffDelayRef.current = BACKOFF_MAX_MS;
        if (syncStateRef.current !== 'disabled') {
          setSyncState('offline');
          setRetryTrigger((n) => n + 1);
        }
      } finally {
        syncingRef.current = false;
        setSyncing(false);
        if (pendingRef.current) {
          pendingRef.current = false;
          void runSync();
        }
      }
    };

    // Public API — blocked only when state is 'disabled'. Waits for the
    // persisted settings (lastSynced/checkpoint) before running so an early
    // call never syncs from `defaultFrom` while a real cursor exists. Callers
    // may manually trigger a retry while 'offline'; runSync will go
    // offline→online on success.
    const sync = async () => {
      if (syncStateRef.current === 'disabled') return;
      await settingsReadyRef.current;
      // Manual/mutation-triggered syncs signal activity: snap the adaptive
      // delay back to the base interval.
      nextDelayRef.current = refreshIntervalRef.current;
      return runSync(true);
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: runSync reads all mutable state via refs; retryTrigger is a trigger-only dep not referenced in the body
    useEffect(() => {
      if (!settingsLoaded) return;
      if (syncState === 'disabled') return;

      if (syncState === 'online') {
        // Reset backoff on entry to online (covers disabled→online transition too)
        backoffDelayRef.current = BACKOFF_INITIAL_MS;
        let cancelled = false;
        let id: ReturnType<typeof setTimeout> | undefined;
        let hiddenSkipped = false;
        const hidden = () => typeof document !== 'undefined' && document.hidden;

        // Self-rescheduling timer chain (instead of setInterval) so each tick
        // honors the current adaptive delay. Hidden documents skip the sync
        // but keep the chain alive; visibility restoration syncs immediately.
        const schedule = () => {
          if (cancelled) return;
          if (refreshIntervalRef.current <= 0) return;
          id = setTimeout(async () => {
            if (hidden()) {
              hiddenSkipped = true;
            } else {
              await runSync();
            }
            schedule();
          }, nextDelayRef.current);
        };
        void runSync().then(schedule);

        const onVisibility = () => {
          if (!hidden() && hiddenSkipped) {
            hiddenSkipped = false;
            nextDelayRef.current = refreshIntervalRef.current;
            void runSync();
          }
        };
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
          cancelled = true;
          if (id !== undefined) clearTimeout(id);
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }

      // offline: one-shot jittered backoff retry.
      // retryTrigger increments on each failure so this effect re-runs
      // even when syncState stays 'offline' across repeated failures.
      const delay = jitter(backoffDelayRef.current);
      backoffDelayRef.current = Math.min(
        backoffDelayRef.current * 2,
        BACKOFF_MAX_MS,
      );
      const id = setTimeout(() => {
        void runSync();
      }, delay);
      return () => clearTimeout(id);
    }, [syncState, retryTrigger, settingsLoaded]);

    return { sync, syncing, lastSynced, syncState, setSyncState };
  };
}
