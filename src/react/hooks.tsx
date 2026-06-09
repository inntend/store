import type { ComponentType, ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import type { AnyTableDef, DefaultSettingsValues, Store } from '../store';
import type { EncryptedStore } from '../store/crypto';
import { buildUseAutoPull, buildUsePull } from './pull';
import { buildUseSync, type SyncState } from './sync';

// ─── Types ────────────────────────────────────────────────────────────────────

type Subscription = { unsubscribe: () => void };
type ObservableLike<T> = {
  subscribe: (observer: {
    next: (value: T) => void;
    error?: (err: unknown) => void;
  }) => Subscription;
};
/** Wraps a query function in a reactive observable (e.g. Dexie's `liveQuery`). */
export type LiveQueryFactory = <T>(
  querier: () => Promise<T> | T,
) => ObservableLike<T>;

export type StoreContextType<
  TDefs extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
> = {
  store: Store<TDefs, V>;
  liveQuery: LiveQueryFactory;
};

export type EncryptedStoreContextType<
  TDefs extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
> = {
  rawStore: Store<TDefs, V>;
  store: EncryptedStore<TDefs, V>;
  liveQuery: LiveQueryFactory;
};

// ─── Shared builders ──────────────────────────────────────────────────────────

const defaultSyncStateCtx = {
  syncState: 'online' as SyncState,
  setSyncState: (_: SyncState) => {},
};

type SyncStateCtx = typeof defaultSyncStateCtx;

/**
 * Core factory shared by `createStoreContext` and `createEncryptedStoreContext`.
 * Creates the SyncState context, Provider, and all common hooks.
 * `getRawStore` extracts the `Store<TDefs>` used by sync/pull from the context value.
 */
export function buildHooks<
  TDefs extends Record<string, AnyTableDef>,
  Ctx extends { liveQuery: LiveQueryFactory },
>(
  RawContext: React.Context<Ctx | null>,
  getRawStore: (ctx: Ctx) => Store<TDefs, any>,
  getCheckAndFix?: (
    ctx: Ctx,
  ) => ((written: Record<string, string[]>) => Promise<void>) | undefined,
): {
  StoreContext: {
    Provider: ComponentType<{ value: Ctx; children?: ReactNode }>;
  };
  useStoreContext: () => Ctx;
  useSyncState: () => SyncStateCtx;
  useLiveQuery: <T>(
    querier: () => Promise<T> | T,
    deps?: unknown[],
  ) => T | undefined;
  useSync: ReturnType<typeof buildUseSync<TDefs>>;
  usePull: ReturnType<typeof buildUsePull<TDefs>>;
  useAutoPull: ReturnType<typeof buildUseAutoPull<TDefs>>;
} {
  const SyncStateContext = createContext(defaultSyncStateCtx);

  function Provider({ value, children }: { value: Ctx; children?: ReactNode }) {
    const [syncState, setSyncState] = useState<SyncState>('online');
    return (
      <RawContext.Provider value={value}>
        <SyncStateContext.Provider value={{ syncState, setSyncState }}>
          {children}
        </SyncStateContext.Provider>
      </RawContext.Provider>
    );
  }

  function useStoreContext(): Ctx {
    const ctx = useContext(RawContext);
    if (!ctx) throw new Error('StoreContext not initialized.');
    return ctx;
  }

  function useSyncState() {
    return useContext(SyncStateContext);
  }

  function useLiveQuery<T>(
    querier: () => Promise<T> | T,
    deps?: unknown[],
  ): T | undefined {
    const { liveQuery } = useStoreContext();
    const [value, setValue] = useState<T | undefined>(undefined);
    useEffect(() => {
      const sub = liveQuery(querier).subscribe({ next: setValue });
      return () => sub.unsubscribe();
      // biome-ignore lint/correctness/useExhaustiveDependencies: deps are forwarded by the caller
    }, deps ?? []);
    return value;
  }

  const useSync = buildUseSync<TDefs>(
    () => getRawStore(useStoreContext()),
    () => useContext(SyncStateContext),
    getCheckAndFix ? () => getCheckAndFix(useStoreContext()) : undefined,
  );
  const usePull = buildUsePull<TDefs>(
    () => getRawStore(useStoreContext()),
    () => useContext(SyncStateContext),
  );
  const useAutoPull = buildUseAutoPull<TDefs>(
    () => getRawStore(useStoreContext()),
    () => useContext(SyncStateContext),
    getCheckAndFix ? () => getCheckAndFix(useStoreContext()) : undefined,
  );

  return {
    StoreContext: { Provider },
    useStoreContext,
    useSyncState,
    useLiveQuery,
    useSync,
    usePull,
    useAutoPull,
  };
}

// ─── createStoreContext ───────────────────────────────────────────────────────

/**
 * Creates a typed React context + hooks for a store without field-level encryption.
 * Call once at the app level, then use the returned hooks everywhere.
 *
 * @example
 * // store-context.ts
 * export const { StoreContext, useStore, useLiveQuery, useSync } = createStoreContext<typeof defs>()
 *
 * // App.tsx
 * import { liveQuery } from "dexie"
 * <StoreContext.Provider value={{ store, liveQuery }}>
 *   <App />
 * </StoreContext.Provider>
 */
export function createStoreContext<
  TDefs extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
>() {
  const RawContext = createContext<StoreContextType<TDefs, V> | null>(null);
  const base = buildHooks<TDefs, StoreContextType<TDefs, V>>(
    RawContext,
    (ctx) => ctx.store,
  );

  function useStore(): Store<TDefs, V> {
    return base.useStoreContext().store;
  }

  return { ...base, useStore };
}

// ─── createEncryptedStoreContext ──────────────────────────────────────────────

/**
 * Creates a typed React context + hooks for a store with field-level encryption.
 * Call once at the app level, then use the returned hooks everywhere.
 *
 * @example
 * // store-context.ts
 * export const { StoreContext, useStore, useRawStore, useLiveQuery, useSync } =
 *   createEncryptedStoreContext<typeof defs>()
 *
 * // App.tsx
 * import { liveQuery } from "dexie"
 * const raw = new DexieStore('mydb', defs)
 * const { store: encrypted, setMek } = createCryptoStore(raw, defs, myManager)
 * <StoreContext.Provider value={{ store: encrypted, rawStore: raw, liveQuery }}>
 *   <App />
 * </StoreContext.Provider>
 */
export function createEncryptedStoreContext<
  TDefs extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
>() {
  const RawContext = createContext<EncryptedStoreContextType<TDefs, V> | null>(
    null,
  );
  const base = buildHooks<TDefs, EncryptedStoreContextType<TDefs, V>>(
    RawContext,
    (ctx) => ctx.rawStore,
  );

  function useStore(): EncryptedStore<TDefs, V> {
    return base.useStoreContext().store;
  }

  function useRawStore(): Store<TDefs, V> {
    return base.useStoreContext().rawStore;
  }

  return { ...base, useStore, useRawStore };
}
