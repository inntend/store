import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import type { z } from 'zod';
import type { AnyTableDef, IndexSpec } from '../store';
import type { ColumnAdapter } from './utils';
import {
  buildColumn,
  classifyZodColumn,
  normalizePrimaryKey,
  resolveIndexName,
  unwrapZodType,
} from './utils';

// ─── Zod → SQLite column ──────────────────────────────────────────────────────

type ColumnBuilder = ReturnType<typeof text | typeof integer | typeof real>;

const drizzleAdapter: ColumnAdapter<ColumnBuilder> = {
  text: (name) => text(name),
  integer: (name) => integer(name),
  real: (name) => real(name),
  integerBoolean: (name) => integer(name, { mode: 'boolean' }),
  integerTimestamp: (name) => integer(name, { mode: 'timestamp_ms' }),
  jsonText: (name) => text(name, { mode: 'json' }),
  notNull: (col) => col.notNull(),
  withDefault: (col, value) => (col as any).default(value),
};

function zodToColumn(fieldName: string, zodType: unknown): ColumnBuilder {
  return buildColumn(fieldName, zodType, drizzleAdapter);
}

// ─── Generator ────────────────────────────────────────────────────────────────

export function zodToSqliteTables<T extends Record<string, AnyTableDef>>(
  defs: T,
): { [K in keyof T]: SQLiteTable } {
  return Object.fromEntries(
    Object.entries(defs).map(([key, def]) => {
      const columns = Object.fromEntries(
        Object.entries(def.schema.shape).map(([field, zodType]) => [
          field,
          zodToColumn(field, zodType),
        ]),
      );

      const pkFields = normalizePrimaryKey(def.primaryKey);
      const idxs: IndexSpec<z.ZodObject<z.ZodRawShape>>[] = def.indexes ?? [];

      for (const idx of idxs) {
        for (const col of idx.columns) {
          const zodType = def.schema.shape[col as string];
          const kind = classifyZodColumn(
            col as string,
            unwrapZodType(zodType).type,
          );
          if (kind.tag === 'json_text') {
            throw new Error(
              `cannot index JSON field "${col as string}" — use a scalar field for indexes`,
            );
          }
        }
      }

      const table = sqliteTable(def.tableName, columns, (t) => {
        const tCols = t as unknown as Record<string, AnySQLiteColumn>;

        const extras: object[] = [
          primaryKey({
            columns: pkFields.map((f) => tCols[f]!) as [
              AnySQLiteColumn,
              ...AnySQLiteColumn[],
            ],
          }),
        ];

        for (const idx of idxs) {
          const idxCols = [...idx.columns].map((f) => tCols[f as string]!) as [
            AnySQLiteColumn,
            ...AnySQLiteColumn[],
          ];
          const name = resolveIndexName(def.tableName, idx);
          const builder = idx.unique
            ? unique(name).on(...idxCols)
            : index(name).on(...idxCols);
          extras.push(builder);
        }

        return extras;
      });

      return [key, table];
    }),
  ) as unknown as { [K in keyof T]: SQLiteTable };
}
