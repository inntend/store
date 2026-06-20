import { generateMnemonic, mnemonicToSeed } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { v7 as uuidv7 } from 'uuid';
import type { AnyTableDef, DefaultSettingsValues, Store } from '../store';
import type {
  ComputeConfig,
  CryptoManager,
  createCryptoStore,
  EncryptedStore,
  KEKType,
  Key,
} from '../store/crypto';
import {
  ComputeConfig as ComputeConfigSchema,
  cryptoManager,
  PASS_PHRASE_STRENGTH,
  toB64,
} from '../store/crypto';
import { buildHooks, type LiveQueryFactory } from './hooks';
import { createPasskeyHooks } from './passkey';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function findKey<TDefs extends Record<string, AnyTableDef>>(
  store: EncryptedStore<TDefs, any>,
  type: KEKType,
) {
  return (
    await store.table.key.findMany({
      where: { type: { $eq: type } },
      orderBy: { ev: 'desc', createdAt: 'desc' },
      limit: 1,
    })
  )?.[0];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type EncryptionSetupPhase = 'loading' | 'recovery' | 'failed';

/**
 * The value passed to `<StoreContext.Provider value={...}>` when using a
 * crypto store. The Provider manages `mek` state internally and syncs it to
 * the store closure — callers never need to wire this up themselves.
 */
export type CryptoProviderValue<
  TDefs extends Record<string, AnyTableDef>,
  TKey,
  V extends Record<string, unknown> = DefaultSettingsValues,
> = {
  rawStore: Store<TDefs, V>;
  /** Result of `createCryptoStore(rawStore, defs, manager)`. */
  cryptoStore: ReturnType<typeof createCryptoStore<TDefs, TKey, V>>;
  /** The same `CryptoManager` passed to `createCryptoStore` — used for `useKeyManagement`. */
  manager: CryptoManager<TKey>;
  liveQuery: LiveQueryFactory;
};

/**
 * Internal context shape. TKey is erased to `unknown` so the context can be
 * shared by the TKey-agnostic hooks in the shared library. `bind<TKey>()`
 * restores the concrete type for the Provider and key-management hooks.
 */
export type CryptoContextBase<
  TDefs extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
> = {
  rawStore: Store<TDefs, V>;
  store: EncryptedStore<TDefs, V>;
  liveQuery: LiveQueryFactory;
  mek: unknown;
  setMek: (mek: unknown, ev?: number) => void;
  keyManager: {
    updateKey: (...args: any[]) => Promise<any>;
    loadKey: (...args: any[]) => Promise<any>;
    updateMasterKey: (...args: any[]) => Promise<any>;
  };
  reencrypt:
    | ((
        oldMek: unknown,
        onProgress?: (done: number, total: number) => void,
      ) => Promise<void>)
    | undefined;
  forceReencrypt: (() => Promise<void>) | undefined;
  checkAndFix:
    | ((written: Record<string, string[]>) => Promise<void>)
    | undefined;
  computeKeyCache: Map<string, unknown>;
  clearComputeKeyCache: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  managerLoadComputeKey:
    | ((
        config: ComputeConfig,
        mek: unknown,
        namespace?: Uint8Array,
      ) => Promise<unknown>)
    | undefined;
  managerCompute:
    | ((
        config: ComputeConfig,
        key: unknown,
        data: Uint8Array,
      ) => Promise<Uint8Array>)
    | undefined;
};

// ─── createCryptoStoreContext ─────────────────────────────────────────────────

/**
 * Creates a typed React context + hooks for an E2EE-encrypted store.
 * Call once at the app or shared-library level — no `TKey` needed here.
 * Then call `.bind<TKey>()` in platform-specific code to get the
 * `Provider`, `useMek`, and `useKeyManagement` hooks typed for your
 * platform's key handle (e.g. `CryptoKey` on web).
 *
 * **Shared library pattern:**
 * ```ts
 * // shared-lib/store-context.ts
 * const _ctx = createCryptoStoreContext<typeof defs>();
 * export const {
 *   bind, useStore, useRawStore, useHasMek,
 *   useLiveQuery, useSync, useSyncState, useAutoPull,
 * } = _ctx;
 *
 * // web/store-context.ts
 * import { bind } from 'shared-lib/store-context';
 * export const { StoreContext, useMek, useKeyManagement } = bind<CryptoKey>();
 *
 * // web/App.tsx
 * const raw = new DexieStore('db', defs);
 * const cryptoStore = createCryptoStore(raw, defs, myManager);
 * <StoreContext.Provider value={{ rawStore: raw, cryptoStore, manager: myManager, liveQuery }}>
 *   <App />
 * </StoreContext.Provider>
 * ```
 *
 * **Single-environment pattern** (no shared lib needed):
 * ```ts
 * // context.ts
 * const _ctx = createCryptoStoreContext<typeof defs>();
 * export const { useStore, useRawStore, useHasMek, useLiveQuery, useSync, useSyncState } = _ctx;
 * export const { StoreContext, useMek, useKeyManagement } = _ctx.bind<CryptoKey>();
 * ```
 */
export function createCryptoStoreContext<
  TDefs extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
>() {
  const InnerContext = createContext<CryptoContextBase<TDefs, V> | null>(null);

  const base = buildHooks<TDefs, CryptoContextBase<TDefs, V>>(
    InnerContext,
    (ctx) => ctx.rawStore,
    (ctx) => ctx.checkAndFix,
  );

  // ── TKey-agnostic hooks ──────────────────────────────────────────────────

  function useStore(): EncryptedStore<TDefs, V> {
    return base.useStoreContext().store;
  }

  function useRawStore(): Store<TDefs, V> {
    return base.useStoreContext().rawStore;
  }

  /** `true` when an encryption key has been loaded via `setMek`. */
  function useHasMek(): boolean {
    return base.useStoreContext().mek !== undefined;
  }

  /**
   * Returns a stable `computeIndex(data)` function that produces a
   * deterministic, one-directional hash of `data` using the loaded MEK.
   * Call it at write-time to store the hash and again at query-time to
   * produce a matching hash for filtering.
   *
   * Returns `undefined` while the MEK is not loaded.
   *
   * @param namespace  Optional label that keeps keys for different fields
   *                   independent. Omit for a single global compute key.
   * @param config     Optional compute config; defaults to SHA-256 / 32-byte key.
   */
  function useComputeIndex(
    namespace?: string,
    config?: Partial<ComputeConfig>,
  ): ((data: string | Uint8Array) => Promise<string>) | undefined {
    const ctx = base.useStoreContext();
    const resolvedConfig = ComputeConfigSchema.parse(config);

    const { mek, computeKeyCache, managerLoadComputeKey, managerCompute } = ctx;
    const { hash, keyBytes, outputBytes } = resolvedConfig;

    const fn = useCallback(
      async (data: string | Uint8Array) => {
        const cfg = { hash, keyBytes, outputBytes };
        const cacheKey = `${namespace ?? ''}:${hash}:${keyBytes}`;
        let computeKey = computeKeyCache.get(cacheKey);
        if (!computeKey) {
          const ns = namespace
            ? new TextEncoder().encode(namespace)
            : undefined;
          computeKey = await managerLoadComputeKey!(cfg, mek, ns);
          computeKeyCache.set(cacheKey, computeKey);
        }
        const dataBytes =
          typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const result = await managerCompute!(cfg, computeKey, dataBytes);
        const out = outputBytes ? result.slice(0, outputBytes) : result;
        return toB64(out);
      },
      [
        mek,
        namespace,
        hash,
        keyBytes,
        outputBytes,
        computeKeyCache,
        managerLoadComputeKey,
        managerCompute,
      ],
    );

    if (!ctx.mek || !ctx.managerLoadComputeKey || !ctx.managerCompute)
      return undefined;

    return fn;
  }

  function useForceReencrypt(version: number) {
    const hasMek = useHasMek();
    const ctx = base.useStoreContext();

    useEffect(() => {
      if (!hasMek || !ctx.forceReencrypt) return;
      let cancelled = false;

      (async () => {
        // Cast needed: V is generic so V['reencryptVersion'] resolves to unknown
        // even though DefaultSettingsValues guarantees it is number at runtime.
        const s = ctx.rawStore.settings as unknown as {
          get(k: 'reencryptVersion'): Promise<number | undefined>;
          set(k: 'reencryptVersion', v: number): Promise<void>;
        };
        const stored = (await s.get('reencryptVersion')) ?? 0;
        if (stored >= version) return;
        await ctx.forceReencrypt!();
        if (!cancelled) await s.set('reencryptVersion', version);
      })().catch((err) => console.error('[forceReencrypt] error:', err));

      return () => {
        cancelled = true;
      };
    }, [hasMek, ctx, version]);
  }

  // ── bind<TKey>() — platform-specific layer ───────────────────────────────

  /**
   * Binds a concrete key type `TKey` to the shared context and returns the
   * Provider component and key-management hooks typed for that key type.
   *
   * Call once per platform environment. The returned `StoreContext.Provider`,
   * `useMek`, and `useKeyManagement` are all consistent with the same `TKey`.
   *
   * @example
   * // web/store-context.ts
   * export const { StoreContext, useMek, useKeyManagement } = bind<CryptoKey>();
   */
  function bind<TKey>() {
    /**
     * Provider that accepts a `CryptoProviderValue` and manages `mek` state
     * internally. On each `setMek` call it syncs the key both to React state
     * (triggering re-renders) and to the store closure (enabling crypto ops).
     */
    function CryptoProvider({
      value,
      children,
    }: {
      value: CryptoProviderValue<TDefs, TKey, V>;
      children?: ReactNode;
    }) {
      const [mek, _setMek] = useState<TKey | undefined>(undefined);
      const [computeKeyCache, setComputeKeyCache] = useState(
        new Map<string, unknown>(),
      );

      const setMek = (k: TKey | undefined, ev?: number) => {
        _setMek(k);
        value.cryptoStore.setMek(k, ev);
        setComputeKeyCache(new Map());
      };

      // Create the cryptoManager utility once per manager reference
      const keyManager = useMemo(
        () => cryptoManager(value.manager),
        [value.manager],
      );

      const innerValue: CryptoContextBase<TDefs, V> = {
        rawStore: value.rawStore,
        store: value.cryptoStore.store,
        liveQuery: value.liveQuery,
        mek: mek as unknown,
        setMek: setMek as (mek: unknown, ev?: number) => void,
        keyManager,
        computeKeyCache,
        clearComputeKeyCache: () => setComputeKeyCache(new Map()),
        managerLoadComputeKey: value.manager.loadComputeKey.bind(
          value.manager,
        ) as (
          config: ComputeConfig,
          mek: unknown,
          namespace?: Uint8Array,
        ) => Promise<unknown>,
        managerCompute: value.manager.compute.bind(value.manager) as (
          config: ComputeConfig,
          key: unknown,
          data: Uint8Array,
        ) => Promise<Uint8Array>,
        reencrypt: value.cryptoStore.reencrypt
          ? (oldMek, onProgress) =>
              value.cryptoStore.reencrypt(oldMek as TKey, onProgress)
          : undefined,
        forceReencrypt: value.cryptoStore.forceReencrypt,
        checkAndFix: value.cryptoStore.checkAndFix,
      };

      // base.StoreContext.Provider also injects the SyncStateContext
      return (
        <base.StoreContext.Provider value={innerValue}>
          {children}
        </base.StoreContext.Provider>
      );
    }

    /**
     * Returns the current MEK state and setters.
     * - `mek` — the loaded `TKey` handle, or `undefined` if no key is loaded.
     * - `setMek(k)` — load a key (call with the result of `loadKey`).
     * - `clearMek()` — unload the key (e.g. on sign-out).
     */
    function useMek(): {
      mek: TKey | undefined;
      setMek: (k: TKey | undefined) => void;
      clearMek: () => void;
    } {
      const ctx = base.useStoreContext();
      return {
        mek: ctx.mek as TKey | undefined,
        setMek: ctx.setMek as (k: TKey | undefined) => void,
        clearMek: () => ctx.setMek(undefined),
      };
    }

    /**
     * Returns the `CryptoManager`-backed key management utilities:
     * - `updateKey(type, secret, oldKey?, oldSecret?)` — create or rotate a key.
     * - `loadKey(storedKey, secret)` — unlock and return the MEK as `TKey`.
     *
     * The returned object is stable (created once per `manager` reference via
     * `useMemo` in the Provider), so it is safe to use as a hook dependency.
     */
    function useKeyManagement(): ReturnType<typeof cryptoManager<TKey>> {
      return base.useStoreContext().keyManager as ReturnType<
        typeof cryptoManager<TKey>
      >;
    }

    function useEncryption() {
      const { store, keyManager, setMek } = base.useStoreContext();

      const loadKey = async (
        type: KEKType,
        secret: Uint8Array,
      ): Promise<void> => {
        const key = (
          await store.table.key.findMany({
            where: { type: { $eq: type } },
            orderBy: { ev: 'desc', createdAt: 'desc' },
            limit: 1,
          })
        )?.[0];
        if (!key)
          throw new Error(
            `No ${type} key found — set up encryption before unlocking`,
          );
        const { mek, ev } = await keyManager.loadKey(key, secret);
        setMek(mek, ev);
      };

      const updatePassword = async (
        secret: Uint8Array,
        oldSecret?: Uint8Array,
      ) => {
        const keys = await store.table.key.findMany({
          where: { type: { $eq: 'account' } },
        });
        const newKey = await keyManager.updateKey(
          'account',
          secret,
          keys.length > 0 ? keys : undefined,
          oldSecret,
        );
        await store.table.key.upsertMany(newKey.storeKeys);
      };

      const updatePhrase = async (oldSecret?: string): Promise<string> => {
        const keys = await store.table.key.findMany({
          where: { type: { $eq: 'recovery' } },
        });
        const secretPhrase = generateMnemonic(wordlist, PASS_PHRASE_STRENGTH);
        const newKey = await keyManager.updateKey(
          'recovery',
          await mnemonicToSeed(secretPhrase),
          keys.length > 0 ? keys : undefined,
          oldSecret ? await mnemonicToSeed(oldSecret) : undefined,
        );
        await store.table.key.upsertMany(newKey.storeKeys);
        return secretPhrase;
      };

      const updateMasterKey = async (
        secret: Uint8Array,
        oldType?: KEKType,
        oldSecret?: Uint8Array,
      ): Promise<void> => {
        const existingKeys = oldType
          ? await store.table.key.findMany({
              where: { type: { $eq: oldType } },
            })
          : undefined;

        const result = await keyManager.updateMasterKey(
          secret,
          existingKeys?.length ? existingKeys : undefined,
          oldSecret,
        );

        setMek(result.cryptoKey);
        await store.table.key.upsertMany(result.accountStoreKeys);
        // Recovery keys wrap the MEK. Only delete them when a *fresh* MEK was
        // generated (no existingKeys). When re-wrapping an existing MEK (e.g.
        // password rotation), recovery keys unlock the same MEK and must be
        // kept — deleting them would silently break account recovery.
        if (!existingKeys?.length) {
          await store.table.key.deleteMany({
            where: { type: { $eq: 'recovery' } },
          });
        }
      };

      return { loadKey, updatePassword, updatePhrase, updateMasterKey };
    }

    function useEncryptionSetup(options: {
      getSecret: () => Promise<Uint8Array>;
      pullKeys: () => Promise<void>;
      onSuccess: () => void;
      getCachedKey?: () => Promise<TKey | undefined>;
      onKeyLoaded?: (key: TKey) => void;
    }): {
      phase: EncryptionSetupPhase;
      error: string;
      tryRecovery: (phrase: string) => Promise<void>;
    } {
      const { store, keyManager, setMek } = base.useStoreContext();
      const started = useRef(false);
      const [phase, setPhase] = useState<EncryptionSetupPhase>('loading');
      const [error, setError] = useState('');

      async function loadAccountKey(
        type: 'account' | 'recovery',
        secret: Uint8Array,
      ) {
        const key = await findKey(store, type);
        if (!key) throw new Error(`No ${type} key found`);
        const { mek, ev } = await keyManager.loadKey(key, secret);
        setMek(mek, ev);
        options.onKeyLoaded?.(mek as TKey);
      }

      async function doUpdateMasterKey(secret: Uint8Array) {
        const result = await keyManager.updateMasterKey(secret);
        setMek(result.cryptoKey);
        options.onKeyLoaded?.(result.cryptoKey as TKey);
        await store.table.key.upsertMany(result.accountStoreKeys);
        await store.table.key.deleteMany({
          where: { type: { $eq: 'recovery' } },
        });
      }

      async function fallback() {
        const recoveryKey = await findKey(store, 'recovery');
        setPhase(recoveryKey ? 'recovery' : 'failed');
      }

      // biome-ignore lint/correctness/useExhaustiveDependencies: intentional run-once on mount
      useEffect(() => {
        if (started.current) return;
        started.current = true;

        (async () => {
          if (options.getCachedKey) {
            const cached = await options.getCachedKey();
            if (cached) {
              setMek(cached);
              options.onSuccess();
              return;
            }
          }
          let secret: Uint8Array | undefined;
          try {
            secret = await options.getSecret();
          } catch {
            await fallback();
            return;
          }
          try {
            await options.pullKeys();
            const keys = await store.table.key.findMany({ limit: 1 });
            if (!keys.length) {
              await doUpdateMasterKey(secret);
              options.onSuccess();
              return;
            }
            await loadAccountKey('account', secret);
            options.onSuccess();
          } catch {
            await fallback();
          } finally {
            secret?.fill(0);
          }
        })().catch((err) =>
          setError(err instanceof Error ? err.message : 'Setup failed.'),
        );
      }, []);

      async function tryRecovery(phrase: string) {
        let seed: Uint8Array | undefined;
        try {
          seed = await mnemonicToSeed(phrase.trim());
          await loadAccountKey('recovery', seed);
          options.onSuccess();
        } catch {
          setError('Invalid recovery phrase. Check each word and try again.');
          throw new Error('Invalid recovery phrase');
        } finally {
          seed?.fill(0);
        }
      }

      return { phase, error, tryRecovery };
    }

    function useRecoveryPhrase(options: {
      getSecret: () => Promise<Uint8Array>;
      sync?: () => Promise<void>;
    }): {
      generate: () => Promise<void>;
      phrase: string;
      generating: boolean;
      error: string;
      clearPhrase: () => void;
    } {
      const { store, keyManager } = base.useStoreContext();
      const [phrase, setPhrase] = useState('');
      const [generating, setGenerating] = useState(false);
      const [error, setError] = useState('');

      async function generate() {
        setGenerating(true);
        setError('');
        let prf: Uint8Array | undefined;
        let phraseSeed: Uint8Array | undefined;
        try {
          prf = await options.getSecret();
          // Gather all account keys (one per MEK version) to wrap under the phrase
          const accountKeys = await store.table.key.findMany({
            where: { type: { $eq: 'account' } },
          });
          if (accountKeys.length === 0)
            throw new Error('No account key found.');
          const existingRecovery = await findKey(store, 'recovery');
          const newPhrase = generateMnemonic(wordlist, PASS_PHRASE_STRENGTH);
          phraseSeed = await mnemonicToSeed(newPhrase);
          const { storeKeys } = await keyManager.updateKey(
            'recovery',
            phraseSeed,
            accountKeys,
            prf,
          );
          // Assign the existing recovery key id (if any) to the first record;
          // additional MEK-version records get fresh ids.
          await store.table.key.upsertMany(
            (
              storeKeys as Pick<
                Key,
                'id' | 'type' | 'config' | 'content' | 'salt' | 'verify'
              >[]
            ).map((sk, i) => ({
              ...sk,
              id: i === 0 ? (existingRecovery?.id ?? uuidv7()) : uuidv7(),
            })),
          );
          await options.sync?.();
          setPhrase(newPhrase);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to generate.');
        } finally {
          prf?.fill(0);
          phraseSeed?.fill(0);
          setGenerating(false);
        }
      }

      return {
        generate,
        phrase,
        generating,
        error,
        clearPhrase: () => setPhrase(''),
      };
    }

    function useRecoveryStatus(options: {
      userEmail: string | undefined | null;
    }): {
      hasEmail: boolean;
      hasPhrase: boolean;
      isComplete: boolean;
      loading: boolean;
    } {
      const { store } = base.useStoreContext();

      const hasEmail =
        !!options.userEmail && !options.userEmail.endsWith('@passkey.invalid');

      const recoveryKeys = base.useLiveQuery(
        async () =>
          store.table.key.findMany({
            where: { type: { $eq: 'recovery' } },
            limit: 1,
          }),
        [],
      );

      const hasPhrase = recoveryKeys !== undefined && recoveryKeys.length > 0;

      return {
        hasEmail,
        hasPhrase,
        isComplete: hasEmail && hasPhrase,
        loading: recoveryKeys === undefined,
      };
    }

    /**
     * Hook for MEK rotation: re-encrypts every row with the current MEK,
     * recomputes blind indexes, and bumps `ev`. Call after loading the new MEK
     * via `setMek`, passing the previous MEK as `oldMek`.
     * Returns `undefined` when no MEK is loaded or `reencrypt` is unavailable.
     */
    function useReencryption():
      | {
          reencrypt: (
            oldMek: TKey,
            onProgress?: (done: number, total: number) => void,
          ) => Promise<void>;
        }
      | undefined {
      const ctx = base.useStoreContext();
      if (!ctx.mek || !ctx.reencrypt) return undefined;
      return {
        reencrypt: ctx.reencrypt as (
          oldMek: TKey,
          onProgress?: (done: number, total: number) => void,
        ) => Promise<void>,
      };
    }

    return {
      StoreContext: {
        Provider: CryptoProvider as ComponentType<{
          value: CryptoProviderValue<TDefs, TKey, V>;
          children?: ReactNode;
        }>,
      },
      useMek,
      useKeyManagement,
      useEncryption,
      useEncryptionSetup,
      useRecoveryPhrase,
      useRecoveryStatus,
      useReencryption,
      ...createPasskeyHooks<TDefs>(base.useStoreContext),
    };
  }

  return {
    /**
     * Binds `TKey` to the context and returns the platform-specific
     * `StoreContext.Provider`, `useMek`, and `useKeyManagement`.
     * Call once per platform (e.g. once in `web/store-context.ts`).
     */
    bind,
    useStoreContext: base.useStoreContext,
    useSyncState: base.useSyncState,
    useLiveQuery: base.useLiveQuery,
    useSync: base.useSync,
    usePull: base.usePull,
    useAutoPull: base.useAutoPull,
    useStore,
    useRawStore,
    useHasMek,
    useComputeIndex,
    useForceReencrypt,
  };
}
