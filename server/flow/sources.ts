import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';

/**
 * AI 识别用的原件（供应商送货单）存在单据流转的原件表（flow_sources）里：
 * 到货单要校验原件还在、内容没改过，并按文件指纹防止同一张送货单重复入库。
 * 识别导入上传原件、保存识别结果都调这里，不直接写这张表；读可以直接读。
 * 种类（现在只有到货原件 arrival）只存在 kind 列里，建了就不变；document 里不再带 kind。
 */
/** 原件的种类（flow_sources.kind）能存的全部值，和建表里的 CHECK 一致（tests/schema-constraints.test.ts 比对） */
export const flowSourceKinds = ['arrival'] as const;
type SourceKind = (typeof flowSourceKinds)[number];

/** 识别结果是个对象（键是文字）时才有 kind 要剥 */
const objectDocument = z.record(z.string(), z.unknown());
/** document 里的 kind 由列负责，写入前剥掉，免得两处不一致（表上有 CHECK 拦着）。 */
function withoutKind(document: unknown) {
  const parsed = objectDocument.safeParse(document);
  if (!parsed.success) return document;
  const { kind: _kind, ...rest } = parsed.data;
  return rest;
}

export function insertSource(
  store: Store,
  s: { id: string; kind: SourceKind; fileName: string; hash: string; format: string; bytes: Uint8Array; document: unknown; actor: Actor },
) {
  store.db
    .prepare('INSERT INTO flow_sources(id,kind,file_name,hash,format,bytes,document,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(s.id, s.kind, s.fileName, s.hash, s.format, s.bytes, JSON.stringify(withoutKind(s.document)), s.actor.id, new Date().toISOString());
}

/** 保存识别结果或失败记录（document 是整份替换，不碰 kind 列） */
export function updateSourceDocument(store: Store, id: string, document: unknown) {
  store.db.prepare('UPDATE flow_sources SET document=? WHERE id=?').run(JSON.stringify(withoutKind(document)), id);
}
