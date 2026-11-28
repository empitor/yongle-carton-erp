import type { Actor, Store } from '../../core/index.js';
import { audit } from '../../core/index.js';
import type { Customer, CustomerSite } from '../../../shared/core/index.js';
import { deliverySiteSnapshot, flowEntity } from '../../../shared/business/index.js';
import { pendingDeliveriesBySite } from '../documents/document-lookups.js';
import { writeFlowDocument } from '../documents/document-store.js';
import { storedDocument } from '../documents/read.js';
import { FlowService } from './service.js';

/*
 * 改客户厂区的资料时，没出库的送货单跟着更新（用户 2026-11-28 定）。订单服务保存客户时在同一个保存点里调。
 * 厂区名称、地址、联系人、联系方式（送货单抄的那四项，deliverySiteSnapshot）有一项变了，挂着这个厂区的待送货单
 * （含已归档的）换成新的；已出库、已取消、已撤销的单上记的是当时的事实，一字不动（和删厂区同一条线）。
 */

/** 送货单上抄的四项：厂区名称、地址、联系人、联系方式 */
const destinationOf = (site: CustomerSite) => {
  const { siteId: _siteId, ...rest } = deliverySiteSnapshot(site);
  return rest;
};
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

/** 这次保存里四项变了的厂区（改前、改后都在的；只改默认、备注的不算） */
function editedSites(before: readonly CustomerSite[], after: readonly CustomerSite[]) {
  return after.filter((site) => {
    const old = before.find((s) => s.id === site.id);
    return old !== undefined && !same(destinationOf(old), destinationOf(site));
  });
}

/**
 * 客户存好以后调：customer 是存好的客户，before 是改之前的厂区。每张要换的待送货单整份写回（版本号加一，
 * 别人正开着这张单编辑，保存时会撞版本）；单上已经是新值的不写。不走 replaceFlowDocument：它按 keepSnapshot
 * 留引用没变的快照，厂区编号没变时会把四项换回旧值。有 actor 才记修改历史（和订单换客户带走产品同一个口径）。
 */
export function followSiteEdits(store: Store, job: { customer: Customer; before: readonly CustomerSite[] }, actor?: Actor) {
  const sites = new Map(editedSites(job.before, job.customer.sites).map((s) => [s.id, s]));
  if (!sites.size) return;
  const flow = new FlowService(store),
    at = new Date().toISOString();
  for (const { id, siteId } of pendingDeliveriesBySite(store, [...sites.keys()])) {
    const site = sites.get(siteId),
      stored = storedDocument(store, id, 'delivery');
    if (!site) continue;
    const next = destinationOf(site),
      { siteName = '', address, contact, phone } = stored;
    if (same({ siteName, address, contact, phone }, next)) continue;
    const before = flow.get(id, 'delivery');
    writeFlowDocument(store, id, { ...stored, ...next }, { at });
    if (actor)
      audit(store, actor, {
        action: 'sync-delivery-site',
        entity: flowEntity('delivery'),
        id,
        document: {
          before,
          after: flow.get(id, 'delivery'),
          reason: '客户 ' + job.customer.name + ' 的厂区“' + site.name + '”改了资料，收货信息跟着更新',
          trigger: { action: 'update', entity: 'customers', id: job.customer.id, name: job.customer.name },
        },
      });
  }
}
