import { z } from 'zod';
import type { ConflictResolution, SyncCheckpoint } from './sync';
import { defineTable, StoreTable, TableDef } from './table';

// ─── Settings table ───────────────────────────────────────────────────────────
//
// A built-in key-value table for local, per-client configuration. Typical uses:
//   lastSynced   — ISO timestamp of the last successful sync
//   conflictResolution — last used conflict resolution strategy, for resuming
//   theme      — UI preference stored locally
//
// Design decisions:
//   • Keys are a Zod enum (not a plain string) so adapters validate them at the
//     DB level and TypeScript can type `get`/`set` per key.
//   • Values are always JSON-serialized strings, keeping the schema simple and
//     adapter-neutral. Callers decode via the generic `V` type param of
//     `createSettingsHelper<V>`.
//   • No `updatedAt`/`createdAt`/`deleted` fields — this table is intentionally
//     local-only and never participates in sync.
//   • `defineStore` injects the settings TableDef automatically (default key
//     "settings"). Both adapters (Dexie, Drizzle) treat it as a normal table:
//     Dexie creates it in IndexedDB automatically; Drizzle requires a matching
//     DDL statement because it never auto-creates tables.
//
// To opt out:   defineStore(defs, { settings: false })
// Custom name:  defineStore(defs, { settings: 'config' })
// Custom keys:  call createSettingsDef(name) with your own TableDef and pass
//               createSettingsHelper<MyValueMap>(store.myTable).
export const SETTINGS_KEYS = [
  'lastSynced',
  'conflictResolution',
  'pull',
  'reencryptVersion',
  'syncCheckpoint',
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

const SETTINGS_SCHEMA = z.object({
  key: z.enum(SETTINGS_KEYS),
  value: z.string(),
});
type SettingsSchema = typeof SETTINGS_SCHEMA;

export type SettingsTableDef = TableDef<SettingsSchema, 'key'>;

/**
 * Resolves the `SettingsTableDef` used by both adapters.
 * Priority: explicit `settingsKeys` → `defs.settings` → default.
 */
export function resolveSettingsDef<ExtraKeys extends string>(
  defs: Record<string, unknown>,
  settingsKeys?: readonly ExtraKeys[],
): SettingsTableDef {
  if (settingsKeys?.length) return createSettingsDef(settingsKeys);
  if ('settings' in defs) return defs.settings as SettingsTableDef;
  return createSettingsDef();
}

/**
 * Creates a `TableDef` for the settings table. Defaults to `"__store_settings"`.
 *
 * Pass `extraKeys` to register additional keys on top of the built-in ones.
 * The extra keys are merged into the zod enum so they are validated at runtime.
 */
export function createSettingsDef(
  extraKeys?: readonly string[],
  tableName: string = '__store_settings',
): SettingsTableDef {
  const allKeys = extraKeys?.length
    ? ([...SETTINGS_KEYS, ...extraKeys] as [string, ...string[]])
    : (SETTINGS_KEYS as unknown as [string, ...string[]]);
  const schema = z.object({ key: z.enum(allKeys), value: z.string() });
  return defineTable({
    tableName,
    schema,
    primaryKey: 'key',
  }) as SettingsTableDef;
}

/** Per-table pull coverage stored in settings. */
export type PullSettingsStore = Record<
  string,
  { full?: boolean; ranges?: { from: string; to: string }[] }
>;

/** Default value type map for the built-in settings keys. */
export type DefaultSettingsValues = {
  lastSynced: string;
  conflictResolution: ConflictResolution;
  pull: PullSettingsStore;
  reencryptVersion: number;
  syncCheckpoint: SyncCheckpoint;
};

/** Typed interface for reading and writing settings entries. */
export interface StoreSettings<
  V extends Record<string, unknown> = DefaultSettingsValues,
> {
  get<K extends keyof V & string>(key: K): Promise<V[K] | undefined>;
  set<K extends keyof V & string>(key: K, value: V[K]): Promise<void>;
  delete(key: keyof V & string): Promise<void>;
  getAll(): Promise<Partial<V>>;
}

class SettingsTable<V extends Record<string, unknown> = DefaultSettingsValues>
  implements StoreSettings<V>
{
  constructor(private readonly table: StoreTable<SettingsSchema, 'key'>) {}

  async get<K extends keyof V & string>(key: K) {
    const row = await this.table.find(key as string as SettingsKey);
    return row ? (JSON.parse(row.value) as V[K]) : undefined;
  }

  async set<K extends keyof V & string>(key: K, value: V[K]) {
    await this.table.upsertMany([
      { key: key as string as SettingsKey, value: JSON.stringify(value) },
    ]);
  }

  async delete(key: keyof V & string) {
    await this.table.delete(key as string as SettingsKey);
  }

  async getAll() {
    const rows = await this.table.findMany();
    return Object.fromEntries(
      rows.map((r) => [r.key, JSON.parse(r.value)]),
    ) as Partial<V>;
  }
}

/**
 * Wraps a raw settings `StoreTable` with a typed `StoreSettings` API.
 * Values are JSON-serialized on write and deserialized on read.
 *
 * Supply a custom value map type `V` to override or extend the default types:
 * ```ts
 * type MySettings = DefaultSettingsValues & { theme: 'dark' | 'light' };
 * const settings = createSettingsHelper<MySettings>(store.settings);
 * ```
 */
export function createSettingsHelper<
  V extends Record<string, unknown> = DefaultSettingsValues,
>(table: StoreTable<SettingsSchema, 'key'>): StoreSettings<V> {
  return new SettingsTable<V>(table);
}
