import { z } from 'zod';

/**
 * Base schema for synced tables.
 * - `mv` — migration version; stamped by `encryptedStore` to track which
 *   `DataMigration`s have been applied to a row.
 * - `syncedAt` — set by the server when a row is accepted during sync;
 *   used as the server-side window filter (`syncedAt ∈ [from, to]`).
 */
export const Base = z.object({
  id: z.uuidv7(),
  mv: z.int().default(0),
  ev: z.int().default(0),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deleted: z.boolean().default(false),
  syncedAt: z.coerce.date().optional(),
});
export type Base = z.infer<typeof Base>;

export const baseIndexes = [
  { columns: ['createdAt'] },
  { columns: ['updatedAt'] },
  { columns: ['deleted'] },
  { columns: ['mv'] },
  { columns: ['ev'] },
] as const;
