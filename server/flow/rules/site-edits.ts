import type { Actor, Store } from '../../core/index.js';
import { audit } from '../../core/index.js';
import type { Customer, CustomerSite } from '../../../shared/core/index.js';
import { deliverySiteSnapshot, flowEntity } from '../../../shared/business/index.js';
import { pendingDeliveriesOfCustomer } from '../documents/document-lookups.js';
import { writeFlowDocument } from '../documents/document-store.js';
import { storedDocument } from '../documents/read.js';
import { FlowService } from './service.js';

/*
 * 改客户名称或厂区资料时，没出库的送货单跟着更新（用户 2026-11-28 定厂区，第六轮加客户名称）。订单服务保存客户时在
 * 同一个保存点里调。客户改了名，这个客户单上存了客户名的待送货单（含已归档的、没挂厂区的）换客户名；没存的照客户
 * 档案的现名显示，已经是新名，不写；厂区名称、地址、联系人、
 * 联系方式（送货单抄的那四项，deliverySiteSnapshot）有一项变了，挂着这个厂区的待送货单换四项。已出库、已取消、
 * 已撤销的单上记的是当时的事实，一字不动（和删厂区同一条线）。订单上的客户名称不在这里动。
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

/** 修改历史的原因：改了名称、厂区资料，或两样都改了 */
function reasonOf(customer: Customer, renamed: boolean, site: CustomerSite | undefined) {
  const changed = site ? '厂区“' + site.name + '”改了资料' : '';
  const what = renamed ? ' 改了名称' + (changed ? '，' + changed : '') : ' 的' + changed;
  return '客户 ' + customer.name + what + '，送货单跟着更新';
}

/**
 * 客户存好以后调：customer 是存好的客户，before 是改之前的客户。每张要换的待送货单整份写回一次（版本号加一，
 * 别人正开着这张单编辑，保存时会撞版本）；单上已经是新值的不写。不走 replaceFlowDocument：它按 keepSnapshot
 * 留引用没变的快照，客户、厂区编号没变时会把客户名和四项换回旧值。有 actor 才记修改历史（和订单换客户带走产品同一个口径）。
 */
export function followCustomerEdits(store: Store, job: { customer: Customer; before: Customer }, actor?: Actor) {
  const { customer, before } = job,
    renamed = before.name !== customer.name,
    sites = new Map(editedSites(before.sites, customer.sites).map((s) => [s.id, s]));
  if (!renamed && !sites.size) return;
  const flow = new FlowService(store),
    at = new Date().toISOString();
  for (const { id, siteId } of pendingDeliveriesOfCustomer(store, customer.id)) {
    const site = siteId === null ? undefined : sites.get(siteId);
    if (!renamed && !site) continue;
    const stored = storedDocument(store, id, 'delivery'),
      { siteName = '', address, contact, phone } = stored,
      // 待送货单平常不存客户名（显示、导出按客户档案的现名），只换单上存了的（订单换客户连带改过的）
      nameChanged = renamed && stored.customerName !== undefined && stored.customerName !== customer.name,
      siteChanged = site !== undefined && !same({ siteName, address, contact, phone }, destinationOf(site));
    if (!nameChanged && !siteChanged) continue;
    const next = { ...stored, ...(nameChanged ? { customerName: customer.name } : {}), ...(siteChanged ? destinationOf(site) : {}) };
    const old = flow.get(id, 'delivery');
    writeFlowDocument(store, id, next, { at });
    if (actor)
      audit(store, actor, {
        action: 'sync-delivery-site',
        entity: flowEntity('delivery'),
        id,
        document: {
          before: old,
          after: flow.get(id, 'delivery'),
          reason: reasonOf(customer, nameChanged, siteChanged ? site : undefined),
          trigger: { action: 'update', entity: 'customers', id: customer.id, name: customer.name },
        },
      });
  }
}
