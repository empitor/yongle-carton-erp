/** 旧到货页面仅兼容跳转到仓库，保留真实采购/单据引用，不再渲染第二套入口。 */
export function warehouseArrivalHash(hash: string) {
  const [page, query = ''] = hash.split('?');
  if (page === '#warehouse') {
    const params = new URLSearchParams(query);
    if (params.has('arrivalPlans')) { params.delete('arrivalPlans'); params.set('arrivals', '1'); }
    if (params.has('deliveryPlans')) { params.delete('deliveryPlans'); params.set('deliveries', '1'); }
    return '#warehouse' + (params.size ? '?' + params.toString() : '');
  }
  if (page !== '#arrivals') return hash;
  const params = new URLSearchParams(query);
  params.set('arrivals', '1');
  if (params.has('purchase') && !params.has('doc')) params.set('createArrival', '1');
  return '#warehouse?' + params.toString();
}
