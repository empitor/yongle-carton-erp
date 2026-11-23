import type { Store } from '../../core/index.js';
import { keepSnapshot, type FlowDocument, type FlowDocView } from '../../../shared/business/index.js';
import { viewContent, writeFlowDocument } from '../documents/document-store.js';
import { storedDocument } from '../documents/read.js';

/**
 * 管理员直接改订单时，已有单据要跟着改（本模块的 order-edit-cascade.ts 调）。
 * 单据表归单据流转，写都落在 document-store.ts（镜像列跟着内容一起写）；改订单后由调用方调
 * FlowService.maintenanceReferences 重建关联、refreshOrderProgress 重算进度。
 * 调用方拿的是单据视图（FlowService.list、get），改好整份交回来：行上的列和派生字段不写，内容按库里的单据结构核对；
 * 抄下来的快照引用没变的照原单留着（shared/business/flow/flow-snapshot.ts 的 keepSnapshot），换了客户、订单明细的按交回来的取。
 */

/** 整份替换单据内容（原单就是库里这张），版本号加一（别处打开的单据会提示已变化） */
export function replaceFlowDocument(store: Store, id: number, view: FlowDocView) {
  writeFlowDocument(store, id, keepSnapshot(storedDocument(store, id), viewContent(view)));
}

/** 拆分送货单：拆出来的新单据沿用原单（from）的状态和快照（不换版本号，它是刚建的） */
export function carryOverFlowDocument(store: Store, id: number, status: string, view: FlowDocView, from: FlowDocument) {
  writeFlowDocument(store, id, keepSnapshot(from, viewContent(view)), { status, bumpVersion: false });
}
