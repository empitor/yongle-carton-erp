import { z } from 'zod';
import { many, one, rows, type Store } from '../core/index.js';
import { AppError } from '../core/index.js';
import type { ImportMapping } from '../../shared/import/index.js';
import { jsonTruthy } from './repository.js';
import { findImport } from './import-records.js';

/**
 * 识别工作区（独立的工作区库）要问业务库的几件事，都在这里接：
 * 这份文件导入过哪张订单、选的客户和产品还在不在、关联的到货单在不在和锁没锁、到货原件识别到哪一步。
 * 只读，按编号批量查；装配时一次接好（工作区选项用 workspaceHooks，到货用 arrivalLinks）。
 */
export type ArrivalLinks = {
  /** 还在的到货单编号 */
  exists(ids: number[]): Set<number>;
  /** 到货单已确认或取消：不能再换识别类型 */
  locked(id: number): boolean;
  /** 停掉这份到货原件正在进行的识别 */
  abort?(sourceId: string): void;
};

/** 工作区选项里问业务库的两件：导入记录、保存客户和产品选择前核对档案和版本 */
export function workspaceHooks(store: Store) {
  return {
    findImport: (id: string, hash?: string) => findImport(store, id, hash),
    validateMapping(m: ImportMapping) {
      if (m.customer.mode === 'existing') {
        const c = store.customer(m.customer.id);
        if (!c || c.version !== m.customer.version) throw new AppError('客户不存在或版本已变化，请重新选择', 409);
      }
      for (const p of Object.values(m.products))
        if (p.mode === 'existing') {
          const product = store.product(p.id);
          if (!product || product.version !== p.version)
            throw new AppError('产品不存在或版本已变化，请重新选择', 409);
        }
    },
  };
}

const documentRow = rows.flow_documents.pick({ id: true, number: true, status: true });
const sourceStateRow = z.object({ id: z.string(), errorState: z.string().nullable(), recognized: z.number() });
/** 按编号批量取到货单（含归档）的单号与状态，只取列表要用的列。 */
export function arrivalDocuments(store: Store, ids: unknown[]) {
  const wanted = [...new Set(ids.filter((id): id is number => typeof id === 'number'))];
  const found = wanted.length
    ? many(
        store.db,
        documentRow,
        "SELECT id,number,status FROM flow_documents WHERE kind='arrival' AND id IN (SELECT value FROM json_each(?))",
        JSON.stringify(wanted),
      )
    : [];
  return new Map(found.map((r) => [r.id, { number: r.number, status: r.status }]));
}

/** 按编号批量取到货原件的识别状态；唛头原件也存在 flow_sources，按 kind 列只取到货原件。 */
export function arrivalSources(store: Store, ids: unknown[]) {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  const found = wanted.length
    ? many(
        store.db,
        sourceStateRow,
        `SELECT id,json_extract(document,'$.lastError.state') AS errorState,${jsonTruthy('$.result')} AS recognized
          FROM flow_sources WHERE id IN (SELECT value FROM json_each(?)) AND kind='arrival'`,
        JSON.stringify(wanted),
      )
    : [];
  return new Map(
    found.map((r) => [r.id, { id: r.id, errorState: r.errorState ?? undefined, recognized: !!r.recognized }]),
  );
}

export function arrivalLinks(store: Store, abort?: (sourceId: string) => void): ArrivalLinks {
  return {
    exists: (ids) => new Set(arrivalDocuments(store, ids).keys()),
    locked(id) {
      const row = one(store.db, documentRow.pick({ status: true }), "SELECT status FROM flow_documents WHERE id=? AND kind='arrival'", id);
      return !!row && row.status !== 'draft';
    },
    ...(abort ? { abort } : {}),
  };
}

/**
 * 文件列表里到货文件的进度：已入库 / 识别中 / 上次失败或取消 / 到货单状态 / 识别过 / 只上传了，
 * 外加到货单号。一次批量查，不逐份查单据。
 */
export function withArrivalStatus<T extends { arrivalDocId?: number | null; arrivalSourceId?: string | null }>(
  store: Store,
  files: T[],
  isBusy: (sourceId: string) => boolean,
) {
  const documents = arrivalDocuments(store, files.map((f) => f.arrivalDocId)),
    sources = arrivalSources(store, files.map((f) => f.arrivalSourceId));
  return files.map((file) => {
    const source = file.arrivalSourceId ? sources.get(file.arrivalSourceId) : undefined,
      document = file.arrivalDocId ? documents.get(file.arrivalDocId) : undefined;
    return Object.assign(file, {
      arrivalStatus:
        document?.status === 'confirmed'
          ? 'confirmed'
          : source && isBusy(source.id)
            ? 'running'
            : source?.errorState || document?.status || (source?.recognized ? 'recognized' : 'uploaded'),
      arrivalNumber: document?.number || null,
    });
  });
}
