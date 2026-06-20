import type { Table as DexieTable } from 'dexie';
import Dexie from 'dexie';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import {
  type FindQuery,
  type ManagedKeys,
  type MutableInput,
  normalizePrimaryKey,
  stripManaged,
  type StoreTable,
  type TableDef,
} from '../store';
import { applyNativeFilter, buildComparator, matchesWhere } from './filter';

// ─── DexieStoreTable
// ──────────────────────────────────────────────────────────

export class DexieStoreTable<
  S extends z.ZodObject<z.ZodRawShape>,
  PK extends keyof z.infer<S> & string,
> implements StoreTable<S, PK>
{
  readonly schema: S;
  private readonly tbl: DexieTable<z.infer<S>, z.infer<S>[PK]>;
  private readonly hasModified: boolean;
  private readonly hasCreated: boolean;
  private readonly hasDeleted: boolean;
  private readonly pkName: string;

  constructor(
    db: Dexie,
    private readonly def: TableDef<S, PK>,
  ) {
    type Doc = z.infer<S>;
    this.schema = def.schema;
    this.tbl = db.table<Doc, Doc[PK]>(def.tableName);
    // Detect which "managed" fields exist in the schema once at creation time.
    // All write methods share these flags to decide what to stamp.
    this.hasModified = 'updatedAt' in def.schema.shape;
    this.hasCreated = 'createdAt' in def.schema.shape;
    this.hasDeleted = 'deleted' in def.schema.shape;
    this.pkName = normalizePrimaryKey(def.primaryKey)[0];
  }

  async find(
    id: z.infer<S>[PK],
    options?: Pick<FindQuery<S>, 'deleted'> & { validate?: boolean },
  ) {
    type Doc = z.infer<S>;
    const row = await this.tbl.get(id);
    if (
      row &&
      this.hasDeleted &&
      !options?.deleted &&
      (row as Record<string, unknown>).deleted === true
    )
      return undefined;
    if (options?.validate && row !== undefined)
      return this.def.schema.parse(row) as Doc;
    return row;
  }

  async findMany(query?: FindQuery<S>, options?: { validate?: boolean }) {
    type Doc = z.infer<S>;
    let collection: Dexie.Collection<Doc, Doc[PK]>;

    if (query?.where) {
      const { collection: native, covered } = applyNativeFilter(
        this.tbl,
        query.where,
      );
      collection = covered
        ? native
        : native.filter((obj) =>
            matchesWhere(obj as Record<string, unknown>, query.where!),
          );
    } else {
      collection = this.tbl.toCollection();
    }

    // Exclude soft-deleted rows by default. Applied after the where filter
    // so offset/limit count only live records.
    if (this.hasDeleted && !query?.deleted) {
      collection = collection.filter(
        (obj) => (obj as Record<string, unknown>).deleted !== true,
      );
    }

    let results: Doc[];
    if (!query?.orderBy) {
      if (query?.offset) collection = collection.offset(query.offset);
      if (query?.limit !== undefined)
        collection = collection.limit(query.limit);
      results = (await collection.toArray()) as Doc[];
    } else {
      results = await collection.toArray();
      results = results.sort(buildComparator(query.orderBy));
      if (query?.offset) results = results.slice(query.offset);
      if (query?.limit !== undefined) results = results.slice(0, query.limit);
    }

    if (options?.validate)
      return results.map((r) => this.def.schema.parse(r) as Doc);
    return results;
  }

  async count(query?: Pick<FindQuery<S>, 'where' | 'deleted'>) {
    if (!query?.where && !this.hasDeleted) return this.tbl.count();
    return (
      await this.findMany({ where: query?.where, deleted: query?.deleted })
    ).length;
  }

  private withPk(data: Record<string, unknown>): Record<string, unknown> {
    if (data[this.pkName] !== undefined) return data;
    return { ...data, [this.pkName]: uuidv7() };
  }

  private stampInsert(data: Record<string, unknown>, now: Date) {
    return {
      ...data,
      ...(this.hasModified && { updatedAt: now }),
      ...(this.hasCreated && { createdAt: now }),
      ...(this.hasDeleted && { deleted: false }),
    };
  }

  async insert(data: MutableInput<S, PK>, options?: { validate?: boolean }) {
    type Doc = z.infer<S>;
    const stamped = this.stampInsert(
      this.withPk(data as Record<string, unknown>),
      new Date(),
    ) as Doc;
    await this.tbl.add(stamped);
    if (options?.validate) return this.def.schema.parse(stamped) as Doc;
    return stamped;
  }

  async insertMany(
    data: MutableInput<S, PK>[],
    options?: { validate?: boolean },
  ) {
    type Doc = z.infer<S>;
    const now = new Date();
    const stamped = data.map((d) =>
      this.stampInsert(this.withPk(d as Record<string, unknown>), now),
    ) as Doc[];
    await this.tbl.bulkAdd(stamped);
    if (options?.validate)
      return stamped.map((r) => this.def.schema.parse(r) as Doc);
    return stamped;
  }

  async update(
    id: z.infer<S>[PK],
    partial: Partial<Omit<z.infer<S>, ManagedKeys<S>>>,
    options?: { validate?: boolean },
  ) {
    type Doc = z.infer<S>;
    const now = new Date();
    // `createdAt` is set-once by insert; `deleted` is managed by delete.
    // Strip both so callers can't accidentally mutate them through update.
    const rest = stripManaged(
      partial as Record<string, unknown>,
    );
    const stamped = { ...rest, ...(this.hasModified && { updatedAt: now }) };
    const count = await this.tbl.update(
      id,
      stamped as Parameters<DexieTable<Doc, Doc[PK]>['update']>[1],
    );
    if (count === 0) throw new Error(`Record "${String(id)}" not found`);
    const updated = (await this.tbl.get(id))!;
    if (options?.validate) return this.def.schema.parse(updated) as Doc;
    return updated;
  }

  async updateMany(
    query: Pick<FindQuery<S>, 'where'>,
    partial: Partial<Omit<z.infer<S>, ManagedKeys<S>>>,
  ) {
    type Doc = z.infer<S>;
    const rows = await this.findMany({ where: query.where });
    if (rows.length === 0) return 0;
    const now = new Date();
    const rest = stripManaged(
      partial as Record<string, unknown>,
    );
    const stamp = { ...rest, ...(this.hasModified && { updatedAt: now }) };
    await this.tbl.bulkPut(
      rows.map((r) => ({ ...r, ...(stamp as Partial<Doc>) })) as Doc[],
    );
    return rows.length;
  }

  async delete(id: z.infer<S>[PK], options?: { hard?: boolean }) {
    // Soft-delete by default when the schema tracks `deleted`.
    // Pass { hard: true } to actually remove the row.
    if (this.hasDeleted && !options?.hard) {
      type Doc = z.infer<S>;
      const now = new Date();
      await this.tbl.update(id, {
        deleted: true,
        ...(this.hasModified && { updatedAt: now }),
      } as Parameters<DexieTable<Doc, Doc[PK]>['update']>[1]);
    } else {
      await this.tbl.delete(id);
    }
  }

  async deleteMany(
    query?: Pick<FindQuery<S>, 'where'>,
    options?: { hard?: boolean },
  ) {
    type Doc = z.infer<S>;
    // Same soft/hard logic as `delete`, applied to all matching rows.
    if (this.hasDeleted && !options?.hard) {
      const rows = await this.findMany({ where: query?.where });
      if (rows.length === 0) return 0;
      const now = new Date();
      await this.tbl.bulkPut(
        rows.map((r) => ({
          ...r,
          deleted: true,
          ...(this.hasModified && { updatedAt: now }),
        })) as Doc[],
      );
      return rows.length;
    }
    // Hard delete path — include soft-deleted rows so they are fully removed.
    if (!query?.where) {
      const count = await this.tbl.count();
      await this.tbl.clear();
      return count;
    }
    const rows = await this.findMany({ where: query.where, deleted: true });
    if (rows.length === 0) return 0;
    await this.tbl.bulkDelete(
      rows.map((r) => r[this.pkName as keyof Doc] as Doc[PK]),
    );
    return rows.length;
  }

  async upsertMany(
    data: MutableInput<S, PK>[] | z.infer<S>[],
    options?: { sync?: boolean },
  ) {
    type Doc = z.infer<S>;
    if (data.length === 0) return [];
    if (options?.sync) {
      const coerced = (data as z.infer<S>[]).map(
        (r) => this.def.schema.parse(r) as Doc,
      );
      await this.tbl.bulkPut(coerced);
      return coerced;
    }
    const now = new Date();
    // IndexedDB has no SQL-level "ON CONFLICT DO UPDATE" mechanism, so we
    // do a read-before-write (bulkGet) to find existing `createdAt` and `deleted`
    // values. New records get `createdAt=now` / `deleted=false`; existing records
    // keep their stored values. (Contrast with the Drizzle adapter which
    // achieves the same thing by excluding those columns from the conflict-update
    // set clause — no round-trip needed there.)
    const withIds = data.map((d) => this.withPk(d as Record<string, unknown>));
    const ids = withIds.map((d) => d[this.pkName]);
    const existing = await this.tbl.bulkGet(ids as Doc[PK][]);
    const existingById = new Map(
      existing
        .filter((r): r is Doc => r !== undefined)
        .map((r) => [(r as Record<string, unknown>)[this.pkName], r]),
    );
    const toStore = withIds.map((d) => {
      const id = d[this.pkName];
      const prev = existingById.get(id) as Record<string, unknown> | undefined;
      return {
        ...d,
        ...(this.hasModified && { updatedAt: now }),
        ...(this.hasCreated && { createdAt: prev?.createdAt ?? now }),
        ...(this.hasDeleted && { deleted: prev?.deleted ?? false }),
      };
    });
    await this.tbl.bulkPut(toStore as Doc[]);
    return toStore.map((r) => this.def.schema.parse(r) as Doc);
  }
}
