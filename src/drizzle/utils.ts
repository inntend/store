import type { IndexSpec, z } from '../store';

// ─── Unwrap ───────────────────────────────────────────────────────────────────

export type UnwrapResult = {
  type: unknown;
  required: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
};

// Accesses `_def.innerType` which is a Zod internal — stable across Zod v4 minor
// releases but not part of the public API. If Zod changes the internal shape this
// function is the single place to update.
export function unwrapZodType(zodType: unknown): UnwrapResult {
  let type: any = zodType;
  let required = true;
  let hasDefault = false;
  let defaultValue: unknown = undefined;

  for (;;) {
    const ctor: string = type?.constructor?.name ?? '';
    if (ctor === 'ZodOptional' || ctor === 'ZodNullable') {
      required = false;
      type = type._def?.innerType;
    } else if (ctor === 'ZodDefault') {
      defaultValue = type._def?.defaultValue;
      hasDefault = true;
      type = type._def?.innerType;
    } else {
      break;
    }
    if (type == null) break;
  }

  return { type, required, hasDefault, defaultValue };
}

// ─── Column kind ──────────────────────────────────────────────────────────────

export type SqliteColumnKind =
  | { tag: 'text' }
  | { tag: 'integer' }
  | { tag: 'real' }
  | { tag: 'integer_boolean' }
  | { tag: 'integer_timestamp_ms' }
  | { tag: 'json_text' };

export function classifyZodColumn(
  fieldName: string,
  innerType: unknown,
): SqliteColumnKind {
  const typeName: string = (innerType as any)?.constructor?.name ?? '';

  if (
    typeName === 'ZodString' ||
    typeName === 'ZodUUID' ||
    typeName === 'ZodEnum' ||
    typeName === 'ZodNativeEnum'
  ) {
    return { tag: 'text' };
  }
  if (typeName === 'ZodNumberFormat') {
    // z.int() in Zod v4 — always an integer
    return { tag: 'integer' };
  }
  if (typeName === 'ZodNumber') {
    const checks: unknown[] = (innerType as any)._def?.checks ?? [];
    const isInt = checks.some((c: any) => c?.isInt === true);
    return isInt ? { tag: 'integer' } : { tag: 'real' };
  }
  if (typeName === 'ZodBoolean') {
    return { tag: 'integer_boolean' };
  }
  if (typeName === 'ZodDate') {
    return { tag: 'integer_timestamp_ms' };
  }
  if (typeName === 'ZodObject') {
    return { tag: 'json_text' };
  }

  throw new Error(
    `unsupported Zod type for column "${fieldName}": ${typeName}`,
  );
}

// ─── Column adapter + builder ─────────────────────────────────────────────────

export type ColumnAdapter<T> = {
  text(name: string): T;
  integer(name: string): T;
  real(name: string): T;
  integerBoolean(name: string): T;
  integerTimestamp(name: string): T;
  jsonText(name: string): T;
  notNull(col: T): T;
  withDefault(col: T, value: unknown): T;
};

export function buildColumn<T>(
  fieldName: string,
  zodType: unknown,
  adapter: ColumnAdapter<T>,
): T {
  const { type, required, hasDefault, defaultValue } = unwrapZodType(zodType);
  const kind = classifyZodColumn(fieldName, type);

  let col: T;
  switch (kind.tag) {
    case 'text':
      col = adapter.text(fieldName);
      break;
    case 'integer':
      col = adapter.integer(fieldName);
      break;
    case 'real':
      col = adapter.real(fieldName);
      break;
    case 'integer_boolean':
      col = adapter.integerBoolean(fieldName);
      break;
    case 'integer_timestamp_ms':
      col = adapter.integerTimestamp(fieldName);
      break;
    case 'json_text':
      col = adapter.jsonText(fieldName);
      break;
  }

  col = required ? adapter.notNull(col) : col;
  return hasDefault ? adapter.withDefault(col, defaultValue) : col;
}

// ─── Primary key + index helpers ──────────────────────────────────────────────

export function normalizePrimaryKey(
  rawPk: string | readonly string[] | undefined,
): [string, ...string[]] {
  return (Array.isArray(rawPk) ? [...rawPk] : [(rawPk as string) ?? 'id']) as [
    string,
    ...string[],
  ];
}

export function resolveIndexName(
  tableName: string,
  idx: Pick<IndexSpec<z.ZodObject<z.ZodRawShape>>, 'name' | 'columns'>,
): string {
  return idx.name ?? `${tableName}_${[...idx.columns].join('_')}_idx`;
}
