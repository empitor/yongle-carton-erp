import { z } from 'zod';
import { many, type Store } from '../core/index.js';
import { AppError } from '../core/index.js';
import { arrivalHeads } from '../flow/index.js';
import type { ImportMapping } from '../../shared/import/index.js';
import { ARRIVAL_SOURCE_KIND } from './receipt-ai.js';
import { jsonTruthy } from './repository.js';

/**
 * 识别工作区（独立的工作区库）要问业务库的几件事，都在这里：
 * 选的客户和产品还在不在、关联的到货单在不在和锁没锁、到货原件识别到哪一步（导入过哪张订单在 import-records.ts）。
 * 只读，按编号批量查；识别导入管理器建的时候用业务库自己接好（workspace-store.ts）。
 */
export type ArrivalLinks = {
  /** 还在的到货单编号 */
  exists(ids: number[]): Set<number>;
  /** 到货单已确认或取消：不能再换识别类型 */
  locked(id: number): boolean;
  /** 停掉这份到货原件正在进行的识别 */
  abort(sourceId: string): void;
};

/** 保存客户和产品选择前核对档案在不在、版本对不对 */
export function validateMapping(store: Store, m: ImportMapping) {
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
}

const sourceStateRow = z.object({ id: z.string(), errorState: z.string().nullable(), recognized: z.number() });
/** 按编号批量取到货单（含归档）的单号与状态，只取列表要用的列（单据流转的 arrivalHeads）。 */
function arrivalDocuments(store: Store, ids: unknown[]) {
  return arrivalHeads(store, [...new Set(ids.filter((id): id is number => typeof id === 'number'))]);
}

/** 按编号批量取到货原件的识别状态；按 kind 列只取到货原件。 */
function arrivalSources(store: Store, ids: unknown[]) {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  const found = wanted.length
    ? many(
        store.db,
        sourceStateRow,
        `SELECT id,json_extract(document,'$.lastError.state') AS errorState,${jsonTruthy('$.result')} AS recognized
          FROM flow_sources WHERE id IN (SELECT value FROM json_each(?)) AND kind=?`,
        JSON.stringify(wanted),
        ARRIVAL_SOURCE_KIND,
      )
    : [];
  return new Map(
    found.map((r) => [r.id, { id: r.id, errorState: r.errorState ?? undefined, recognized: !!r.recognized }]),
  );
}

export function arrivalLinks(store: Store, abort: (sourceId: string) => void): ArrivalLinks {
  return {
    exists: (ids) => new Set(arrivalDocuments(store, ids).keys()),
    locked: (id) => arrivalHeads(store, [id]).get(id)?.locked ?? false,
    abort,
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
