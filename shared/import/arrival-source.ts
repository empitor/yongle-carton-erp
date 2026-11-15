import { z } from 'zod';

/*
 * 到货原件的识别记录（GET /api/flow/sources/:sourceId，和到货识别 POST /api/ai/imports/:id/arrival/recognize 的结果）。
 * 识别结果的结构服务端写库前按它认（server/import/receipt-ai.ts），到货页按它预填到货单（shared/business 的 recognizedArrivalDraft）。
 */

/** 一份到货识别结果（存进原件记录的 result，到货页按它预填）：空格子是 null */
const cellText = z.string().nullable();
export const receiptResultSchema = z.object({
  supplierName: cellText,
  reference: cellText,
  purchaseNumber: cellText,
  date: cellText,
  notes: cellText,
  warnings: z.array(z.string()),
  lines: z.array(
    z.object({
      name: cellText,
      specification: cellText,
      material: cellText,
      flute: cellText,
      length: cellText,
      width: cellText,
      dimensionUnit: cellText,
      quantity: cellText,
      unit: cellText,
      area: cellText,
      unitPrice: cellText,
      priceBasis: z.enum(['area', 'quantity']).nullable(),
      notes: cellText,
    }),
  ),
});
export type ReceiptResult = z.infer<typeof receiptResultSchema>;

/** 一份到货原件：文件、识别结果（没识别是 null）、用的哪版识别规则、什么时候识别的、上次没识别完的原因 */
export type ArrivalSource = {
  id: string;
  fileName: string;
  hash: string;
  format: string;
  createdAt: string;
  result: ReceiptResult | null;
  promptUsage?: { id: string; name: string; revision: number; hash: string };
  recognizedAt?: string;
  lastError?: { at: string; state: 'cancelled' | 'failed'; message: string };
};
