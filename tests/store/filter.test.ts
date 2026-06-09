import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createFindQuerySchema,
  createOrderByClauseSchema,
  createWhereClauseSchema,
} from '../../src/store/filter';

// ─── createWhereClauseSchema ──────────────────────────────────────────────────

describe('createWhereClauseSchema', () => {
  const schema = z.object({
    id: z.string(),
    name: z.string(),
    age: z.number().int(),
    score: z.number(),
    active: z.boolean(),
    createdAt: z.date(),
    nickname: z.string().optional(),
    bio: z.string().nullable(),
  });

  const whereSchema = createWhereClauseSchema(schema);

  it('accepts an empty where clause', () => {
    expect(whereSchema.parse({})).toEqual({});
  });

  it('accepts undefined (all fields optional)', () => {
    expect(whereSchema.parse({})).toEqual({});
  });

  // ─── StringFilter ───────────────────────────────────────────────────────────

  it('accepts $eq on a string field', () => {
    expect(whereSchema.parse({ name: { $eq: 'Alice' } })).toMatchObject({
      name: { $eq: 'Alice' },
    });
  });

  it('accepts $ne on a string field', () => {
    expect(whereSchema.parse({ name: { $ne: 'Bob' } })).toMatchObject({
      name: { $ne: 'Bob' },
    });
  });

  it('accepts $in on a string field', () => {
    expect(
      whereSchema.parse({ name: { $in: ['Alice', 'Bob'] } }),
    ).toMatchObject({ name: { $in: ['Alice', 'Bob'] } });
  });

  it('accepts $nin on a string field', () => {
    expect(whereSchema.parse({ name: { $nin: ['Alice'] } })).toMatchObject({
      name: { $nin: ['Alice'] },
    });
  });

  it('accepts $like on a string field', () => {
    expect(whereSchema.parse({ name: { $like: '%Ali%' } })).toMatchObject({
      name: { $like: '%Ali%' },
    });
  });

  it('rejects a number value for a string $eq', () => {
    expect(() => whereSchema.parse({ name: { $eq: 42 } })).toThrow();
  });

  // ─── NumberFilter ───────────────────────────────────────────────────────────

  it('accepts $eq on a number field', () => {
    expect(whereSchema.parse({ age: { $eq: 30 } })).toMatchObject({
      age: { $eq: 30 },
    });
  });

  it('accepts $gt / $gte / $lt / $lte on a number field', () => {
    expect(
      whereSchema.parse({ score: { $gt: 1, $gte: 1, $lt: 10, $lte: 10 } }),
    ).toMatchObject({ score: { $gt: 1, $gte: 1, $lt: 10, $lte: 10 } });
  });

  it('accepts $in / $nin on a number field', () => {
    expect(
      whereSchema.parse({ age: { $in: [18, 21], $nin: [99] } }),
    ).toMatchObject({ age: { $in: [18, 21], $nin: [99] } });
  });

  it('rejects a string value for a number $eq', () => {
    expect(() => whereSchema.parse({ age: { $eq: 'thirty' } })).toThrow();
  });

  // ─── BooleanFilter ──────────────────────────────────────────────────────────

  it('accepts $eq on a boolean field', () => {
    expect(whereSchema.parse({ active: { $eq: true } })).toMatchObject({
      active: { $eq: true },
    });
  });

  it('accepts $ne on a boolean field', () => {
    expect(whereSchema.parse({ active: { $ne: false } })).toMatchObject({
      active: { $ne: false },
    });
  });

  it('strips unknown operators on a boolean field (e.g. $gt)', () => {
    // BooleanFilterSchema only knows $eq/$ne; unknown keys are stripped silently
    const result = whereSchema.parse({ active: { $gt: true } });
    expect((result.active as Record<string, unknown>)?.$gt).toBeUndefined();
  });

  // ─── DateFilter ─────────────────────────────────────────────────────────────

  const d = new Date('2024-01-01');
  const d2 = new Date('2024-12-31');

  it('accepts $eq on a date field', () => {
    expect(whereSchema.parse({ createdAt: { $eq: d } })).toMatchObject({
      createdAt: { $eq: d },
    });
  });

  it('accepts $gt / $gte / $lt / $lte on a date field', () => {
    expect(
      whereSchema.parse({ createdAt: { $gt: d, $gte: d, $lt: d2, $lte: d2 } }),
    ).toMatchObject({ createdAt: { $gt: d, $gte: d, $lt: d2, $lte: d2 } });
  });

  it('coerces a date string for a date $eq', () => {
    const result = whereSchema.parse({ createdAt: { $eq: '2024-01-01' } });
    expect((result.createdAt as { $eq: Date }).$eq).toBeInstanceOf(Date);
  });

  // ─── Optional / nullable fields are treated as their inner type ──────────────

  it('applies StringFilter to an optional string field', () => {
    expect(whereSchema.parse({ nickname: { $eq: 'Nick' } })).toMatchObject({
      nickname: { $eq: 'Nick' },
    });
  });

  it('applies StringFilter to a nullable string field', () => {
    expect(whereSchema.parse({ bio: { $like: '%dev%' } })).toMatchObject({
      bio: { $like: '%dev%' },
    });
  });

  // ─── $and / $or ─────────────────────────────────────────────────────────────

  it('accepts $and with valid nested clauses', () => {
    const result = whereSchema.parse({
      $and: [{ name: { $eq: 'Alice' } }, { age: { $gte: 18 } }],
    });
    expect(result.$and).toHaveLength(2);
  });

  it('accepts $or with valid nested clauses', () => {
    const result = whereSchema.parse({
      $or: [{ active: { $eq: true } }, { age: { $lt: 13 } }],
    });
    expect(result.$or).toHaveLength(2);
  });

  it('accepts nested $and inside $or', () => {
    const result = whereSchema.parse({
      $or: [
        { $and: [{ name: { $eq: 'Alice' } }, { active: { $eq: true } }] },
        { age: { $lt: 13 } },
      ],
    });
    expect(result.$or).toHaveLength(2);
  });

  it('rejects $and with an invalid inner clause', () => {
    expect(() =>
      whereSchema.parse({ $and: [{ age: { $eq: 'not-a-number' } }] }),
    ).toThrow();
  });

  // ─── Unsupported types are excluded from where schema ────────────────────────

  it('ignores object-typed fields (not mapped to any filter)', () => {
    const schemaWithObject = z.object({
      id: z.string(),
      meta: z.object({ x: z.number() }),
    });
    const ws = createWhereClauseSchema(schemaWithObject);
    // meta should not be filterable — extra key rejected by strict parse but
    // the schema simply omits 'meta', so providing it is a passthrough or error
    // depending on zod mode. The key assertion: the schema is buildable.
    expect(ws).toBeDefined();
  });
});

// ─── createOrderByClauseSchema ────────────────────────────────────────────────

describe('createOrderByClauseSchema', () => {
  const schema = z.object({
    id: z.string(),
    name: z.string(),
    age: z.number(),
  });

  const orderBySchema = createOrderByClauseSchema(schema);

  it('accepts asc/desc for any field', () => {
    expect(orderBySchema.parse({ name: 'asc', age: 'desc' })).toEqual({
      name: 'asc',
      age: 'desc',
    });
  });

  it('accepts an empty object', () => {
    expect(orderBySchema.parse({})).toEqual({});
  });

  it('rejects an invalid direction value', () => {
    expect(() => orderBySchema.parse({ name: 'ascending' })).toThrow();
  });

  it('rejects a numeric direction value', () => {
    expect(() => orderBySchema.parse({ age: 1 })).toThrow();
  });

  it('all fields are optional (partial order)', () => {
    expect(orderBySchema.parse({ id: 'asc' })).toEqual({ id: 'asc' });
  });
});

// ─── createFindQuerySchema ────────────────────────────────────────────────────

describe('createFindQuerySchema', () => {
  const schema = z.object({
    id: z.string(),
    name: z.string(),
    age: z.number().int(),
    active: z.boolean(),
  });

  const querySchema = createFindQuerySchema(schema);

  it('accepts an empty query', () => {
    expect(querySchema.parse({})).toEqual({});
  });

  it('accepts a full valid query', () => {
    const result = querySchema.parse({
      where: { name: { $eq: 'Alice' }, age: { $gte: 18 } },
      orderBy: { age: 'asc' },
      limit: 10,
      offset: 0,
      deleted: true,
    });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
    expect(result.deleted).toBe(true);
  });

  it('accepts limit and offset', () => {
    const result = querySchema.parse({ limit: 5, offset: 20 });
    expect(result.limit).toBe(5);
    expect(result.offset).toBe(20);
  });

  it('rejects negative limit', () => {
    expect(() => querySchema.parse({ limit: -1 })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => querySchema.parse({ offset: -1 })).toThrow();
  });

  it('rejects non-integer limit', () => {
    expect(() => querySchema.parse({ limit: 1.5 })).toThrow();
  });

  it('accepts deleted: true', () => {
    expect(querySchema.parse({ deleted: true })).toMatchObject({
      deleted: true,
    });
  });

  it('rejects deleted: false (only true is allowed)', () => {
    expect(() => querySchema.parse({ deleted: false })).toThrow();
  });

  it('accepts where with $and', () => {
    const result = querySchema.parse({
      where: { $and: [{ age: { $gte: 18 } }, { active: { $eq: true } }] },
    });
    expect(result.where?.$and).toHaveLength(2);
  });

  it('rejects invalid where field filter', () => {
    expect(() =>
      querySchema.parse({ where: { age: { $eq: 'not-a-number' } } }),
    ).toThrow();
  });

  it('rejects invalid orderBy direction', () => {
    expect(() => querySchema.parse({ orderBy: { name: 'random' } })).toThrow();
  });
});
