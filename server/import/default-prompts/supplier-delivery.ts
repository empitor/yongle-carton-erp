import { randomUUID } from 'node:crypto';

// 供应商送货单识别的默认规则：只放表上放不下的。栏目怎么填写在表上（server/import/receipt-form.ts）。识别的默认提示词放在这个目录，由装配（server/index.ts）交给 AI 接入的提示词库。
export const supplierDefaultPreset = () => ({
  id: randomUUID(),
  name: '供应商送货单识别 · 默认',
  entries: [
    {
      id: randomUUID(),
      name: '供应商与收货方向',
      enabled: true,
      content: '本公司是宁波甬勒包装制品有限公司，是收货方；供应商是发货方，不能把收货方当作供应商。',
    },
    {
      id: randomUUID(),
      name: '纸板明细与计价',
      enabled: true,
      content: '名称和规格分开填。按面积计价和按张计价不能混，看不出是哪种就列进“拿不准”；一张纸板不等于一个纸箱。',
    },
  ],
});
