type SourceItem = { unit?: string };
export type FinanceSourceLine = {
  quantity: string;
  unit?: string;
  unitPrice?: string | number | null;
  unitPriceExact?: string;
  priceBasis?: string;
  taxMode?: string | null;
  taxRate?: string | null;
  stockId?: number | string | null;
  purchaseLineId?: number | string | null;
  lineId?: number | string | null;
  stockedQuantity?: string | null;
  acceptedQuantity?: string | null;
  item?: SourceItem;
};

export type FinanceSourceDocument = {
  number?: string;
  reference?: string;
  confirmedAt?: string;
  customerId?: number | string;
  customerName?: string;
  supplierId?: number | string;
  supplierName?: string;
  taxMode?: string | null;
  taxRate?: string | null;
  correctionOf?: number | null;
  correctionOfReceiptId?: string | null;
  replacedBy?: number | string | null;
  lines?: FinanceSourceLine[];
  items?: FinanceSourceLine[];
};

/** 旧快照可能以 items 保存行，或缺少后续新增的价格、单位及税率。 */
export type FinanceSourceSnapshot = {
  doc: FinanceSourceDocument;
  money?: { net: number; lines: { net: number }[] } | null;
  theoretical?: { gross: number } | null;
};
