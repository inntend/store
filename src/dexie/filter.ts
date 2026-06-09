import type { Table as DexieTable } from 'dexie';
import Dexie from 'dexie';
import type { z } from 'zod';
import { type OrderByClause, type WhereClause } from '../store';

// ─── Filter helpers ───────────────────────────────────────────────────────────

const REGEX_CACHE_MAX_SIZE = 500;
const regexCache = new Map<string, RegExp>();

function likeToRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(
      '^' +
        pattern
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
          .replace(/_/g, '.') +
        '$',
    );
    // Evict the oldest entry when the cache is full (insertion-order eviction).
    if (regexCache.size >= REGEX_CACHE_MAX_SIZE) {
      regexCache.delete(regexCache.keys().next().value!);
    }
    regexCache.set(pattern, re);
  }
  return re;
}

function matchesFieldFilter(
  value: unknown,
  filter: Record<string, unknown>,
): boolean {
  if ('$eq' in filter && value !== filter.$eq) return false;
  if ('$ne' in filter && value === filter.$ne) return false;
  if ('$gt' in filter && (value as number) <= (filter.$gt as number))
    return false;
  if ('$gte' in filter && (value as number) < (filter.$gte as number))
    return false;
  if ('$lt' in filter && (value as number) >= (filter.$lt as number))
    return false;
  if ('$lte' in filter && (value as number) > (filter.$lte as number))
    return false;
  if (
    '$in' in filter &&
    Array.isArray(filter.$in) &&
    !filter.$in.includes(value)
  )
    return false;
  if (
    '$nin' in filter &&
    Array.isArray(filter.$nin) &&
    filter.$nin.includes(value)
  )
    return false;
  if (
    '$like' in filter &&
    !likeToRegex(filter.$like as string).test(value as string)
  )
    return false;
  return true;
}

export function matchesWhere<S extends z.ZodObject<z.ZodRawShape>>(
  obj: Record<string, unknown>,
  where: WhereClause<S>,
): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === '$and' && Array.isArray(value)) {
      if (!(value as WhereClause<S>[]).every((sub) => matchesWhere(obj, sub)))
        return false;
    } else if (key === '$or' && Array.isArray(value)) {
      if (!(value as WhereClause<S>[]).some((sub) => matchesWhere(obj, sub)))
        return false;
    } else {
      if (!matchesFieldFilter(obj[key], value as Record<string, unknown>))
        return false;
    }
  }
  return true;
}

/**
 * Attempts to satisfy the where clause with a single Dexie index operation.
 * Returns the resulting collection and whether it is fully covered (no
 * additional in-memory filtering needed).
 *
 * Important: `table.where(field)` throws a SchemaError in Dexie if `field` is
 * not declared as an index. This function only calls `.where()` when it can
 * map the filter to a native index operation — all other cases fall back to a
 * full-table scan with in-memory filtering. As a result, any field you want to
 * filter efficiently must be listed in `TableDef.indexes`.
 */
export function applyNativeFilter<
  S extends z.ZodObject<z.ZodRawShape>,
  T,
  TKey,
>(
  table: DexieTable<T, TKey>,
  where: WhereClause<S>,
): { collection: Dexie.Collection<T, TKey>; covered: boolean } {
  const fallback = { collection: table.toCollection(), covered: false };

  // Logical operators always require in-memory evaluation
  const entries = Object.entries(where).filter(([, v]) => v !== undefined);
  if (
    entries.length !== 1 ||
    entries[0]![0] === '$and' ||
    entries[0]![0] === '$or'
  )
    return fallback;

  const [key, filter] = entries[0]!;
  const f = filter as unknown as Record<string, unknown>;
  const cast = (x: unknown) => x as any;
  // table.where(key) throws a SchemaError in Dexie when `key` is not declared
  // as an index. Catch it here and fall back to in-memory filtering.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wc: any;
  try {
    wc = table.where(key);
  } catch {
    /* v8 ignore next -- Dexie 4.x defers schema checks; kept for older versions */
    return fallback;
  }

  if ('$ne' in f || '$nin' in f) return fallback;
  if ('$in' in f)
    return { collection: wc.anyOf(f.$in as any[]), covered: true };
  if ('$eq' in f) return { collection: wc.equals(cast(f.$eq)), covered: true };
  if ('$like' in f) {
    const pat = f.$like as string;
    if (pat.endsWith('%') && !pat.slice(0, -1).includes('%')) {
      return { collection: wc.startsWith(pat.slice(0, -1)), covered: true };
    }
    return fallback;
  }

  const lo = '$gte' in f ? f.$gte : '$gt' in f ? f.$gt : undefined;
  const hi = '$lte' in f ? f.$lte : '$lt' in f ? f.$lt : undefined;
  const loIncl = '$gte' in f;
  const hiIncl = '$lte' in f;

  if (lo !== undefined && hi !== undefined)
    return {
      collection: wc.between(cast(lo), cast(hi), loIncl, hiIncl),
      covered: true,
    };
  if (lo !== undefined)
    return {
      collection: loIncl ? wc.aboveOrEqual(cast(lo)) : wc.above(cast(lo)),
      covered: true,
    };
  if (hi !== undefined)
    return {
      collection: hiIncl ? wc.belowOrEqual(cast(hi)) : wc.below(cast(hi)),
      covered: true,
    };

  return fallback;
}

export function buildComparator<S extends z.ZodObject<z.ZodRawShape>>(
  orderBy: OrderByClause<S>,
): (a: unknown, b: unknown) => number {
  const entries = Object.entries(orderBy) as [string, 'asc' | 'desc'][];
  return (a, b) => {
    for (const [field, dir] of entries) {
      const av = (a as Record<string, unknown>)[field];
      const bv = (b as Record<string, unknown>)[field];
      if (av === bv) continue;
      const cmp = av! < bv! ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  };
}
