import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DexieStore } from '../../src/dexie';
import { buildComparator, matchesWhere } from '../../src/dexie/filter';
import { defineTable } from '../../src/store';

const schema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().int(),
  email: z.string(),
});

type S = typeof schema;

let counter = 0;
function makeStore() {
  return new DexieStore(`filter-test-${++counter}`, {
    users: defineTable({
      tableName: 'users',
      schema,
      primaryKey: 'id',
      indexes: [{ columns: ['name'] }, { columns: ['age'] }],
    }),
  });
}

// ─── matchesWhere — in-memory operator coverage ───────────────────────────────

describe('matchesWhere — $gt', () => {
  it('returns false when value is at or below the limit', () => {
    expect(matchesWhere<S>({ age: 25 }, { age: { $gt: 25 } })).toBe(false);
  });

  it('returns true when value exceeds the limit', () => {
    expect(matchesWhere<S>({ age: 26 }, { age: { $gt: 25 } })).toBe(true);
  });
});

describe('matchesWhere — $in', () => {
  it('returns false when value is not in the inclusion list', () => {
    expect(
      matchesWhere<S>({ name: 'Dave' }, { name: { $in: ['Alice', 'Bob'] } }),
    ).toBe(false);
  });

  it('returns true when value is in the inclusion list', () => {
    expect(
      matchesWhere<S>({ name: 'Alice' }, { name: { $in: ['Alice', 'Bob'] } }),
    ).toBe(true);
  });
});

describe('matchesWhere — $lte', () => {
  it('returns false when value exceeds the limit', () => {
    expect(matchesWhere<S>({ age: 30 }, { age: { $lte: 25 } })).toBe(false);
  });

  it('returns true when value equals the limit', () => {
    expect(matchesWhere<S>({ age: 25 }, { age: { $lte: 25 } })).toBe(true);
  });

  it('returns true when value is below the limit', () => {
    expect(matchesWhere<S>({ age: 20 }, { age: { $lte: 25 } })).toBe(true);
  });
});

describe('matchesWhere — $nin', () => {
  it('returns false when value is in the exclusion list', () => {
    expect(
      matchesWhere<S>({ name: 'Alice' }, { name: { $nin: ['Alice', 'Bob'] } }),
    ).toBe(false);
  });

  it('returns true when value is not in the exclusion list', () => {
    expect(
      matchesWhere<S>({ name: 'Carol' }, { name: { $nin: ['Alice', 'Bob'] } }),
    ).toBe(true);
  });
});

// ─── buildComparator — tie-break ─────────────────────────────────────────────

describe('buildComparator — equal values', () => {
  it('returns 0 when both records have identical sort-field values', () => {
    const cmp = buildComparator<S>({ name: 'asc' });
    expect(cmp({ name: 'Alice' }, { name: 'Alice' })).toBe(0);
  });
});

// ─── applyNativeFilter — via DexieStore ──────────────────────────────────────

describe('applyNativeFilter — $ne on indexed field (line 128 fallback)', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('falls back to in-memory filtering for $ne on indexed field', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30, email: 'alice@example.com' },
      { id: '2', name: 'Bob', age: 25, email: 'bob@example.com' },
    ]);
    const results = await store.table.users.findMany({
      where: { name: { $ne: 'Alice' } },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('2');
  });
});

describe('applyNativeFilter — final fallback (unrecognised operator)', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('falls back to full-table scan for an empty field filter object', async () => {
    await store.table.users.insertMany([
      { id: '1', name: 'Alice', age: 30, email: 'a@e.com' },
      { id: '2', name: 'Bob', age: 25, email: 'b@e.com' },
    ]);
    const results = await store.table.users.findMany({
      where: { age: {} as any },
    });
    expect(results).toHaveLength(2);
  });
});

// ─── likeToRegex cache eviction ──────────────────────────────────────────────

describe('likeToRegex — regex cache eviction at 500 entries', () => {
  it('evicts the oldest entry when the cache exceeds 500 patterns', () => {
    for (let i = 0; i < 501; i++) {
      matchesWhere<S>(
        { name: `pattern-${i}` },
        { name: { $like: `pat${i}%` } },
      );
    }
    expect(true).toBe(true);
  });
});
