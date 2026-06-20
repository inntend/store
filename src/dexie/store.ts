import Dexie, { type Transaction } from 'dexie';
import {
  type AnyTableDef,
  type DefaultSettingsValues,
  resolveSettingsDef,
  type SettingsTableDef,
  Store,
  type StoreType,
} from '../store';
import { DexieStoreTable } from './table';

// ─── DexieMigration ───────────────────────────────────────────────────────────

/**
 * One schema upgrade entry, applied as Dexie version 2, 3, … (version 1 is
 * always auto-derived from the `primaryKey` and `indexes` in each `TableDef`).
 *
 * `stores` follows Dexie's incremental schema syntax:
 *  - Only list tables that are **new or changed** in this upgrade.
 *  - Omitted tables carry over from the previous version unchanged.
 *  - Set a table to `null` to drop it.
 *
 * `upgrade` runs after the schema change and can transform existing data.
 * See https://dexie.org/docs/API-Reference#upgrade
 */
export type DexieMigration<TNames extends string = string> = {
  stores?: Partial<Record<TNames, string | null>>;
  upgrade?: (tx: Transaction) => void | Promise<void>;
};

// ─── DexieStore ───────────────────────────────────────────────────────────────

/**
 * Dexie (IndexedDB) backed store. Version 1 of the DB schema is derived
 * automatically from each def's `primaryKey` and `indexes`.
 *
 * Pass `migrations` to evolve the schema after initial deployment — each entry
 * becomes Dexie version N+1.
 *
 * Pass `settingsKeys` to register additional settings keys on top of the
 * built-in ones. The extra key names are inferred automatically — no explicit
 * type parameter needed.
 *
 * Access tables via `store.table.<name>` and settings via `store.settings`.
 *
 * @example
 * const store = new DexieStore('mydb', defs);
 * store.table.users  // StoreTable<UserSchema, 'id'>
 * store.settings     // StoreSettings
 *
 * @example
 * // With extra settings keys (ExtraKeys inferred from the array):
 * const store = new DexieStore('mydb', defs, {
 *   settingsKeys: ['userId', 'blindIndexVersion'] as const,
 * });
 * store.settings.get('userId')  // unknown | undefined — narrow in your app
 *
 * @example
 * // With schema migration:
 * const store = new DexieStore('mydb', defs, {
 *   migrations: [
 *     {
 *       stores: { users: 'id, name, email, age' },
 *       upgrade: async (tx) => {
 *         await tx.table('users').toCollection().modify(u => { u.age ??= 0 });
 *       },
 *     },
 *   ],
 * });
 */
export class DexieStore<
  T extends Record<string, AnyTableDef>,
  ExtraKeys extends string = never,
> extends Store<T, DefaultSettingsValues & Record<ExtraKeys, unknown>> {
  readonly db: Dexie;

  constructor(
    name: string,
    defs: T,
    options?: {
      migrations?: DexieMigration[];
      settingsKeys?: readonly ExtraKeys[];
    },
  ) {
    const { migrations, settingsKeys } = options ?? {};

    const settingsDef = resolveSettingsDef(defs as Record<string, unknown>, settingsKeys);

    const allDefs = { ...defs, settings: settingsDef } as T & {
      settings: SettingsTableDef;
    };

    const { settings: _sd, ...userDefEntries } = allDefs;
    const userDefs = userDefEntries as unknown as T;

    // Build the Dexie database with v1 schema derived from defs.
    const db = new Dexie(name);
    db.version(1).stores(
      Object.fromEntries(
        Object.entries(allDefs).map(([_k, d]) => [
          d.tableName,
          defToDexieSchema(d),
        ]),
      ),
    );

    // Apply user-supplied schema migrations as Dexie v2, v3, …
    for (const [i, { stores, upgrade }] of (migrations ?? []).entries()) {
      const spec = db
        .version(i + 2)
        .stores((stores ?? {}) as Record<string, string | null>);
      if (upgrade) spec.upgrade(upgrade);
    }

    // Create table instances and split settings from user tables.
    const settingsTable = new DexieStoreTable(db, settingsDef);
    const userTables = Object.fromEntries(
      Object.entries(userDefs).map(([key, def]) => [
        key,
        new DexieStoreTable(db, def as AnyTableDef),
      ]),
    ) as unknown as StoreType<T>;

    super(userTables, settingsTable);
    this.db = db;
  }
}

// ─── Schema derivation ────────────────────────────────────────────────────────

function defToDexieSchema(def: AnyTableDef): string {
  const raw = def.primaryKey;
  const pkStr =
    Array.isArray(raw) && raw.length > 1
      ? `[${(raw as string[]).join('+')}]`
      : (((Array.isArray(raw) ? raw[0] : raw) ?? 'id') as string);
  const idxStrs = (def.indexes ?? []).map((idx) => {
    const cols = [...idx.columns] as string[];
    const colStr = cols.length > 1 ? `[${cols.join('+')}]` : cols[0]!;
    return idx.unique ? `&${colStr}` : colStr;
  });
  return [pkStr, ...idxStrs].join(', ');
}
