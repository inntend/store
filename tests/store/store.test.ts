import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineStore } from '../../src/store';
import {
  createSettingsDef,
  createSettingsHelper,
  SETTINGS_KEYS,
} from '../../src/store/settings';
import {
  type AnyTableDef,
  defineTable,
  type StoreTable,
} from '../../src/store/table';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().int(),
});

const PostSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: z.enum(['draft', 'published']),
});

// ─── In-memory store helper ───────────────────────────────────────────────────
//
// Minimal Map-backed StoreTable used to test createSettingsHelper without an
// adapter. Only implements the methods the helper actually calls.

function makeMemoryStore<TDefs extends Record<string, AnyTableDef>>(
  defs: TDefs,
): { [K in keyof TDefs]: StoreTable<any, any> } {
  return Object.fromEntries(
    Object.entries(defs).map(([key, def]) => {
      const pk = (
        Array.isArray(def.primaryKey)
          ? def.primaryKey[0]
          : (def.primaryKey ?? 'id')
      ) as string;
      const db = new Map<unknown, Record<string, unknown>>();
      return [
        key,
        {
          schema: def.schema as any,
          find: (id: unknown) => Promise.resolve(db.get(id) as any),
          findMany: (_q?: unknown) => Promise.resolve([...db.values()] as any),
          count: (_q?: unknown) => Promise.resolve(db.size),
          insert: (data: any) => {
            const stored = { ...data };
            db.set(stored[pk], stored);
            return Promise.resolve({ ...stored });
          },
          insertMany: (data: any[]) => {
            const stored = data.map((d) => ({ ...d }));
            for (const d of stored) db.set(d[pk], d);
            return Promise.resolve(stored.map((d) => ({ ...d })));
          },
          update: (id: unknown, partial: any) => {
            const merged = { ...db.get(id), ...partial };
            db.set(id, merged);
            return Promise.resolve({ ...merged });
          },
          updateMany: () => Promise.resolve(0),
          delete: (id: unknown) => {
            db.delete(id);
            return Promise.resolve();
          },
          deleteMany: () => Promise.resolve(0),
          upsertMany: (data: any[]) => {
            const stored = data.map((d) => ({ ...d }));
            for (const d of stored) db.set(d[pk], d);
            return Promise.resolve(stored.map((d) => ({ ...d })));
          },
        } satisfies StoreTable<any, any>,
      ];
    }),
  ) as unknown as { [K in keyof TDefs]: StoreTable<any, any> };
}

describe('defineTable', () => {
  it('returns the same def object', () => {
    const def = defineTable({
      tableName: 'users',
      schema: UserSchema,
      primaryKey: 'id',
    });
    expect(def.tableName).toBe('users');
    expect(def.primaryKey).toBe('id');
    expect(def.schema).toBe(UserSchema);
  });

  it('supports composite primary key', () => {
    const def = defineTable({
      tableName: 'tags',
      schema: z.object({ userId: z.string(), tag: z.string() }),
      primaryKey: ['userId', 'tag'],
    });
    expect(def.primaryKey).toEqual(['userId', 'tag']);
  });

  it('supports indexes', () => {
    const def = defineTable({
      tableName: 'users',
      schema: UserSchema,
      primaryKey: 'id',
      indexes: [{ columns: ['name'] }, { columns: ['age'], unique: true }],
    });
    expect(def.indexes).toHaveLength(2);
    expect(def.indexes![1]!.unique).toBe(true);
  });

  it('supports named indexes', () => {
    const def = defineTable({
      tableName: 'users',
      schema: UserSchema,
      primaryKey: 'id',
      indexes: [{ columns: ['name', 'age'], name: 'name_age_idx' }],
    });
    expect(def.indexes![0]!.name).toBe('name_age_idx');
    expect(def.indexes![0]!.columns).toEqual(['name', 'age']);
  });

  it('supports encryptedFields', () => {
    const def = defineTable({
      tableName: 'users',
      schema: UserSchema,
      primaryKey: 'id',
      encryptedFields: ['name'],
    });
    expect(def.encryptedFields).toEqual(['name']);
  });
});

describe('defineStore', () => {
  it('preserves user-defined table defs', () => {
    const userDef = defineTable({
      tableName: 'users',
      schema: UserSchema,
      primaryKey: 'id',
    });
    const postDef = defineTable({
      tableName: 'posts',
      schema: PostSchema,
      primaryKey: 'id',
    });
    const defs = defineStore({ users: userDef, posts: postDef });
    expect(defs.users).toBe(userDef);
    expect(defs.posts).toBe(postDef);
  });

  it('injects settings table under "settings" by default', () => {
    const defs = defineStore({
      users: defineTable({
        tableName: 'users',
        schema: UserSchema,
        primaryKey: 'id',
      }),
    });
    expect('settings' in defs).toBe(true);
    expect(defs.settings.tableName).toBe('__store_settings');
    expect(defs.settings.primaryKey).toBe('key');
  });

  it('preserves all user keys plus settings', () => {
    const defs = defineStore({
      users: defineTable({
        tableName: 'users',
        schema: UserSchema,
        primaryKey: 'id',
      }),
      posts: defineTable({
        tableName: 'posts',
        schema: PostSchema,
        primaryKey: 'id',
      }),
    });
    expect(Object.keys(defs)).toEqual(['users', 'posts', 'settings']);
  });

  it('injects settings under a custom name', () => {
    const defs = defineStore(
      {
        users: defineTable({
          tableName: 'users',
          schema: UserSchema,
          primaryKey: 'id',
        }),
      },
      { settings: 'config' },
    );
    expect('config' in defs).toBe(true);
    expect(defs.config.tableName).toBe('__store_settings');
    expect('settings' in defs).toBe(false);
  });

  it('omits settings when settings: false', () => {
    const defs = defineStore(
      {
        users: defineTable({
          tableName: 'users',
          schema: UserSchema,
          primaryKey: 'id',
        }),
        posts: defineTable({
          tableName: 'posts',
          schema: PostSchema,
          primaryKey: 'id',
        }),
      },
      { settings: false },
    );
    expect(Object.keys(defs)).toEqual(['users', 'posts']);
    expect('settings' in defs).toBe(false);
  });
});

// ─── createSettingsDef ────────────────────────────────────────────────────────

describe('createSettingsDef', () => {
  it('defaults table name to "__store_settings"', () => {
    const def = createSettingsDef();
    expect(def.tableName).toBe('__store_settings');
  });

  it('uses the provided table name', () => {
    const def = createSettingsDef(undefined, 'config');
    expect(def.tableName).toBe('config');
  });

  it('sets key as primary key', () => {
    const def = createSettingsDef();
    expect(def.primaryKey).toBe('key');
  });

  it('schema key field accepts all SETTINGS_KEYS and rejects unknown keys', () => {
    const def = createSettingsDef();
    for (const key of SETTINGS_KEYS) {
      expect(def.schema.shape.key.safeParse(key).success).toBe(true);
    }
    expect(def.schema.shape.key.safeParse('unknown').success).toBe(false);
  });

  it('SETTINGS_KEYS contains the expected built-in keys', () => {
    expect(SETTINGS_KEYS).toEqual([
      'lastSynced',
      'conflictResolution',
      'pull',
      'reencryptVersion',
    ]);
  });
});

// ─── createSettingsHelper ─────────────────────────────────────────────────────

describe('createSettingsHelper', () => {
  let rawStore: ReturnType<
    typeof makeMemoryStore<{ settings: ReturnType<typeof createSettingsDef> }>
  >;
  let settings: ReturnType<typeof createSettingsHelper>;

  beforeEach(() => {
    rawStore = makeMemoryStore({ settings: createSettingsDef() });
    settings = createSettingsHelper(rawStore.settings as StoreTable<any, any>);
  });

  it('getAll returns all set entries as a plain object', async () => {
    await settings.set('conflictResolution', 'lww');
    await settings.set('lastSynced', '2024-06-01T00:00:00.000Z');
    const all = await settings.getAll();
    expect(all).toEqual({
      conflictResolution: 'lww',
      lastSynced: '2024-06-01T00:00:00.000Z',
    });
  });

  it('getAll returns an empty object when nothing is set', async () => {
    expect(await settings.getAll()).toEqual({});
  });

  it('values survive a JSON round-trip for nested objects', async () => {
    // createSettingsHelper accepts a generic V so callers can store any
    // JSON-serializable value. Verify deep equality after round-trip.
    type Extended = {
      lastSynced: string;
      conflictResolution: { strategy: string };
    };
    const ext = createSettingsHelper<Extended>(
      rawStore.settings as StoreTable<any, any>,
    );
    await ext.set('conflictResolution', { strategy: 'lww' });
    expect(await ext.get('conflictResolution')).toEqual({ strategy: 'lww' });
  });
});
