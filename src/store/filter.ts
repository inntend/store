import { z } from 'zod';

// ─── Field-level filter operators ─────────────────────────────────────────────

export type StringFilter = {
  $eq?: string;
  $ne?: string;
  $in?: string[];
  $nin?: string[];
  $like?: string;
};

export const StringFilterSchema: z.ZodType<StringFilter> = z.object({
  $eq: z.string().optional(),
  $ne: z.string().optional(),
  $in: z.array(z.string()).optional(),
  $nin: z.array(z.string()).optional(),
  $like: z.string().optional(),
});

export type NumberFilter = {
  $eq?: number;
  $ne?: number;
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $in?: number[];
  $nin?: number[];
};

export const NumberFilterSchema: z.ZodType<NumberFilter> = z.object({
  $eq: z.number().optional(),
  $ne: z.number().optional(),
  $gt: z.number().optional(),
  $gte: z.number().optional(),
  $lt: z.number().optional(),
  $lte: z.number().optional(),
  $in: z.array(z.number()).optional(),
  $nin: z.array(z.number()).optional(),
});

export type BooleanFilter = { $eq?: boolean; $ne?: boolean };

export const BooleanFilterSchema: z.ZodType<BooleanFilter> = z.object({
  $eq: z.boolean().optional(),
  $ne: z.boolean().optional(),
});

export type DateFilter = {
  $eq?: Date;
  $ne?: Date;
  $gt?: Date;
  $gte?: Date;
  $lt?: Date;
  $lte?: Date;
};

export const DateFilterSchema: z.ZodType<DateFilter> = z.object({
  $eq: z.coerce.date().optional(),
  $ne: z.coerce.date().optional(),
  $gt: z.coerce.date().optional(),
  $gte: z.coerce.date().optional(),
  $lt: z.coerce.date().optional(),
  $lte: z.coerce.date().optional(),
});

export type FieldFilter<T> = T extends string
  ? StringFilter
  : T extends number
    ? NumberFilter
    : T extends boolean
      ? BooleanFilter
      : T extends Date
        ? DateFilter
        : never;

// ─── Query types ──────────────────────────────────────────────────────────────

export type WhereClause<S extends z.ZodObject<z.ZodRawShape>> = {
  [K in keyof z.infer<S>]?: FieldFilter<z.infer<S>[K]>;
} & { $and?: WhereClause<S>[]; $or?: WhereClause<S>[] };

export type OrderByClause<S extends z.ZodObject<z.ZodRawShape>> = {
  [K in keyof z.infer<S>]?: 'asc' | 'desc';
};

export interface FindQuery<S extends z.ZodObject<z.ZodRawShape>> {
  where?: WhereClause<S>;
  orderBy?: OrderByClause<S>;
  limit?: number;
  offset?: number;
  /**
   * When `true`, include soft-deleted rows (`deleted = true`) in the results.
   * By default, rows with `deleted = true` are excluded from `find`, `findMany`,
   * and `count` on tables whose schema contains a `deleted` field.
   * Tables without a `deleted` field are unaffected.
   */
  deleted?: true;
}

// ─── Zod schema factories ─────────────────────────────────────────────────────

/** Unwraps ZodOptional/ZodNullable to get the inner type for introspection. */
function unwrap(t: z.core.$ZodType): z.core.$ZodType {
  if (t instanceof z.ZodOptional || t instanceof z.ZodNullable) {
    return unwrap(t.unwrap() as z.core.$ZodType);
  }
  return t;
}

/** Maps a Zod field type to the appropriate filter schema, or `null` if unsupported. */
function getFieldFilterSchema(fieldType: z.core.$ZodType): z.ZodTypeAny | null {
  const inner = unwrap(fieldType);
  if (inner instanceof z.ZodString) return StringFilterSchema;
  if (inner instanceof z.ZodNumber) return NumberFilterSchema;
  if (inner instanceof z.ZodBoolean) return BooleanFilterSchema;
  if (inner instanceof z.ZodDate) return DateFilterSchema;
  return null;
}

/**
 * Builds a Zod schema for {@link WhereClause} derived from a table's Zod schema.
 * Supports per-field filter operators (`$eq`, `$gt`, `$like`, etc.) and the
 * logical combinators `$and` / `$or` (self-referential via `z.lazy`).
 */
export function createWhereClauseSchema<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
): z.ZodType<WhereClause<S>> {
  const fieldEntries: Record<string, z.ZodTypeAny> = {};
  for (const [key, fieldType] of Object.entries(schema.shape)) {
    const filterSchema = getFieldFilterSchema(fieldType as z.ZodTypeAny);
    if (filterSchema) {
      fieldEntries[key] = filterSchema.optional();
    }
  }

  const whereSchema: z.ZodType<WhereClause<S>> = z.object({
    ...fieldEntries,
    $and: z.lazy(() => z.array(whereSchema)).optional(),
    $or: z.lazy(() => z.array(whereSchema)).optional(),
  }) as z.ZodType<WhereClause<S>>;

  return whereSchema;
}

/**
 * Builds a Zod schema for {@link OrderByClause} derived from a table's Zod schema.
 * Each field accepts `'asc'` or `'desc'`.
 */
export function createOrderByClauseSchema<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
): z.ZodType<OrderByClause<S>> {
  const entries: Record<string, z.ZodTypeAny> = {};
  for (const key of Object.keys(schema.shape)) {
    entries[key] = z.enum(['asc', 'desc']).optional();
  }
  return z.object(entries) as z.ZodType<OrderByClause<S>>;
}

/**
 * Builds a Zod schema for {@link FindQuery} derived from a table's Zod schema.
 * Validates `where`, `orderBy`, `limit`, `offset`, and `deleted` at runtime.
 *
 * @example
 * const querySchema = createFindQuerySchema(userSchema);
 * querySchema.parse({ where: { name: { $eq: 'Alice' } }, limit: 10 });
 */
export function createFindQuerySchema<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
): z.ZodType<FindQuery<S>> {
  return z.object({
    where: createWhereClauseSchema(schema).optional(),
    orderBy: createOrderByClauseSchema(schema).optional(),
    limit: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    deleted: z.literal(true).optional(),
  }) as z.ZodType<FindQuery<S>>;
}
