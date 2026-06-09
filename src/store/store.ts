import {
  createSettingsDef,
  createSettingsHelper,
  type DefaultSettingsValues,
  type SettingsTableDef,
  type StoreSettings,
} from './settings';
import type { AnyTableDef, StoreTable, TableDef } from './table';

// ─── StoreType ────────────────────────────────────────────────────────────────

/**
 * Maps a record of TableDefs to the corresponding StoreTable record.
 * The settings table (identified by its `SettingsTableDef` type) is excluded —
 * it is accessible via `store.settings`, not `store.table`.
 */
export type StoreType<T extends Record<string, AnyTableDef>> = {
  [K in keyof T as T[K] extends SettingsTableDef
    ? never
    : K]: T[K] extends TableDef<infer S, infer PK, infer _Out>
    ? StoreTable<S, PK>
    : never;
};

// ─── defineStore ──────────────────────────────────────────────────────────────

/**
 * Groups a set of `TableDef`s into a store definition that is passed to an
 * adapter's `setupStore`. Also serves as the second argument to `encryptedStore`
 * (which reads `encryptedFields` from each def).
 *
 * A settings table is automatically injected under the key `"settings"` (or a
 * custom name). Pass `{ settings: false }` to opt out.
 *
 * Pass the type explicitly for exhaustiveness checking:
 * ```ts
 * defineStore<{ users: typeof userDef; posts: typeof postDef }>({ users: userDef, posts: postDef })
 * ```
 * Or let TypeScript infer it when exhaustiveness isn't needed.
 */
export function defineStore<T extends Record<string, AnyTableDef>>(
  defs: T,
): T & { settings: SettingsTableDef };
export function defineStore<
  T extends Record<string, AnyTableDef>,
  N extends string,
>(defs: T, options: { settings: N }): T & Record<N, SettingsTableDef>;
export function defineStore<T extends Record<string, AnyTableDef>>(
  defs: T,
  options: { settings: false },
): T;
export function defineStore<T extends Record<string, AnyTableDef>>(
  defs: T,
  options?: { settings?: string | false },
): unknown {
  if (options?.settings === false) return defs;
  const name =
    typeof options?.settings === 'string' ? options.settings : 'settings';
  return { ...defs, [name]: createSettingsDef() };
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Base class for all store implementations. Holds the instantiated table objects
 * and the settings helper. Subclasses (DexieStore, DrizzleStore) handle
 * adapter-specific setup and pass the created table instances to this constructor.
 *
 * Access tables via `store.table.<name>` and settings via `store.settings`.
 */
export class Store<
  T extends Record<string, AnyTableDef>,
  V extends Record<string, unknown> = DefaultSettingsValues,
> {
  /** All user-defined tables keyed by their name in the store definition. */
  readonly table: StoreType<T>;
  /** Typed key-value settings store (JSON-serialized values under the hood). */
  readonly settings: StoreSettings<V>;

  constructor(
    table: StoreType<T>,
    settingsTable: StoreTable<SettingsTableDef['schema'], 'key'>,
  ) {
    this.table = table;
    this.settings = createSettingsHelper<V>(settingsTable);
  }
}
