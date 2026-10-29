import type { TaskDecision, TaskMemory } from '../../shared/assistant-task.js';
import { receiptEditMode } from '../../shared/receipt-edit-mode.js';

// 这里只采集真实用户原话中的明确参数；不读取附件、模型回复或业务备注作为授权。
export function userDecisions(text: string, messageId: string): TaskDecision[] {
  const out: TaskDecision[] = [];
  const add = (key: string, value: unknown, quote: string, scope = 'task') =>
    out.push({
      key,
      scope,
      value,
      status: 'confirmed',
      source: { messageId, quote, kind: 'user' },
    });
  const mode = receiptEditMode(text);
  if (mode) add('receiptCorrectionMode', mode, text);
  for (const sentence of text
    .split(/[。；;\n，,]/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const scope =
      /第[二2]张|第二份/.test(sentence) && !/第[一1]张|第一份/.test(sentence)
        ? 'order:2'
        : /第[一1]张|第一份/.test(sentence) && !/第[二2]张|第二份/.test(sentence)
          ? 'order:1'
          : /两张|两份|全部|都/.test(sentence)
            ? 'all'
            : 'task';
    const date = /(?:交期|交货日期|交付日期)[^\d]{0,12}(\d{4}-\d{2}-\d{2})/.exec(sentence);
    if (
      date &&
      !/不确定|未确认|可能|大概|不要|不是|是否|[？?]/.test(sentence) &&
      !Number.isNaN(Date.parse(date[1])) &&
      new Date(date[1]).toISOString().slice(0, 10) === date[1]
    )
      add('deliveryDate', date[1], sentence, scope);
    const orderDate = /(?:下单日期|订单日期)[^\d]{0,12}(\d{4}-\d{2}-\d{2})/.exec(sentence);
    if (
      orderDate &&
      !/不确定|可能|不是|是否|[？?]/.test(sentence) &&
      !Number.isNaN(Date.parse(orderDate[1])) &&
      new Date(orderDate[1]).toISOString().slice(0, 10) === orderDate[1]
    )
      add('orderDate', orderDate[1], sentence, scope);
    const tax = /税率[^\d]{0,8}(\d+(?:\.\d+)?)\s*[%％]/.exec(sentence);
    if (tax && Number(tax[1]) <= 100 && !/不确定|未确认|可能|不是|是否|[？?]/.test(sentence))
      add('taxRate', tax[1], sentence, scope);
    // 税率绝不证明含税口径；“不能推断是否含税”也不是含税确认。
    if (!/是否|不能.*推断|不确定|未明确|[？?]/.test(sentence)) {
      if (/(?:单价|价格|两张|两份|都是|均为).*(?:不含税|未税)/.test(sentence))
        add('taxMode', '未税', sentence, scope);
      else if (/(?:单价|价格|两张|两份|都是|均为).*含税/.test(sentence))
        add('taxMode', '含税', sentence, scope);
    }
    const total = /数量.*(?:明细合计|明细总计|合计)[^\d]{0,8}(\d+(?:\.\d+)?)/.exec(sentence);
    if (total) add('quantityTotal', total[1], sentence, scope);
    const ruleText = sentence.split(/改为|更正为/).at(-1)!;
    const certainRule = !/不确定|未确认|可能|大概|是否|不要|不能|并非|不是|如果|假设|[？?]/.test(
      ruleText,
    );
    const issued =
      /(?:领用|领料|消耗)(?:原料|纸板)?(?:总计|合计|共|为|是|：|:)?\s*(\d+(?:\.\d+)?)\s*张/.exec(
        ruleText,
      );
    const prefix = sentence.split(/改为|更正为/)[0];
    const correctedMaterial = /^\s*(\d+(?:\.\d+)?)\s*张(?:原料|纸板)?\s*$/.exec(ruleText);
    const issuedValue =
      issued?.[1] ||
      (correctedMaterial && /领用|领料|消耗/.test(prefix) && !/退回|退料/.test(prefix)
        ? correctedMaterial[1]
        : undefined);
    if (issuedValue && certainRule) add('materialIssuedTotal', issuedValue, sentence, scope);
    const returned = /(?:退回|退料)(?:原料|纸板)?(?:共|为|是|：|:)?\s*(\d+(?:\.\d+)?)\s*张/.exec(
      ruleText,
    );
    if (returned && certainRule) add('materialReturnedTotal', returned[1], sentence, scope);
    const quality =
      /(?:(\d+(?:\.\d+)?)\s*[%％]\s*良品|良品率(?:为|是|：|:)?\s*(\d+(?:\.\d+)?)\s*[%％])/.exec(
        ruleText,
      );
    if (quality && certainRule)
      add('goodRatePct', Number(quality[1] || quality[2]), sentence, scope);
    const yieldRule = /每张(?:原料|纸板)?(?:可|能)?(?:生产|出|做)?\s*(\d+)\s*只/.exec(ruleText);
    if (yieldRule && Number(yieldRule[1]) > 0 && certainRule)
      add('unitsPerSheet', Number(yieldRule[1]), sentence, scope);
    if (certainRule && /按型号独立取整|各型号独立|逐型号.*取整/.test(ruleText))
      add('allocationMode', 'per-product', sentence, scope);
    if (certainRule && /允许跨型号共享|按跨型号共享|采用共享原料|共享领料/.test(ruleText))
      add('allocationMode', 'shared', sentence, scope);
    if (/保留.*(?:单位|个|张)|不(?:进行|做)?.*换算/.test(sentence))
      add('unitPolicy', 'preserve-original', sentence, scope);
    if (/(?:两张|两份|全部).*同一[个家]?客户/.test(sentence))
      add('sameCustomer', true, sentence, 'all');
    if (
      /(?:新产品|新型号).*(?:建档|创建档案|新增档案)/.test(sentence) &&
      !/不要|不允许|暂不|先不/.test(sentence)
    )
      add('createProducts', true, sentence, scope);
    if (
      /导入/.test(sentence) &&
      !/不要|暂不|先不|只.*预览|尚未授权|如何|怎么|能否|是否|[？?]/.test(sentence)
    )
      add('operation', 'import', sentence, scope);
    if (/只.*预览|暂不导入|不要导入|先不导入/.test(sentence))
      add('operation', 'preview', sentence, scope);
    const customer = /客户(?:名称)?(?:为|是|用|：|:)\s*[“「"]?([^，,。；;\n”」"]{2,80})/.exec(
      sentence,
    );
    if (customer && !/同一个|不确定|可能/.test(customer[1]))
      add('customerName', customer[1].trim(), sentence, scope);
    const po =
      /(?:采购单号|订单号)(?:为|是|：|:)?\s*[“「"]?([A-Za-z0-9][A-Za-z0-9._/-]{2,80})/.exec(
        sentence,
      );
    if (po) add('externalPurchaseOrder', po[1], sentence, scope);
    const customerId = /客户(?:档案)?\s*(?:ID|id|编号|#)\s*[:：]?\s*(\d+)/.exec(sentence);
    if (customerId && !/是否|可能|不是|[？?]/.test(sentence))
      add('customerId', Number(customerId[1]), sentence, scope);
    const unit = /(?:数量单位|单位)(?:为|是|用|：|:)\s*[“「"]?([^，,。；;\n”」"]{1,20})/.exec(
      sentence,
    );
    if (unit && !/是否|换算|不确定|保留/.test(sentence))
      add('unit', unit[1].trim(), sentence, scope);
    const specification =
      /(?:产品规格|规格)(?:为|是|：|:)\s*[“「"]?([^，,。；;\n”」"]{1,120})/.exec(sentence);
    if (specification && !/是否|不确定|可能/.test(sentence))
      add('specification', specification[1].trim(), sentence, scope);
  }
  return out;
}
export function mergeDecisions(memory: TaskMemory, incoming: TaskDecision[], correction = false) {
  for (const item of incoming) {
    const i = memory.decisions.findIndex((d) => d.key === item.key && d.scope === item.scope);
    if (i < 0) {
      const overlapping = memory.decisions.find(
        (d) =>
          d.key === item.key &&
          d.status === 'confirmed' &&
          (['all', 'task'].includes(d.scope) || ['all', 'task'].includes(item.scope)) &&
          JSON.stringify(d.value) !== JSON.stringify(item.value),
      );
      memory.decisions.push(
        overlapping && item.status === 'confirmed' && !correction && item.key !== 'operation'
          ? { ...item, status: 'conflict', previous: overlapping.value }
          : item,
      );
    } else {
      const old = memory.decisions[i];
      if (['confirmed', 'conflict'].includes(old.status) && item.status !== 'confirmed') continue;
      if (
        old.status === 'confirmed' &&
        item.status === 'confirmed' &&
        JSON.stringify(old.value) !== JSON.stringify(item.value) &&
        !correction &&
        !['operation', 'receiptCorrectionMode'].includes(item.key)
      )
        memory.decisions[i] = { ...item, status: 'conflict', previous: old.value };
      else memory.decisions[i] = item;
    }
  }
}
export function decision(memory: TaskMemory | undefined, key: string, ordinal?: number) {
  const candidates =
    memory?.decisions.filter(
      (d) =>
        d.key === key &&
        ['task', 'all', ...(ordinal ? ['order:' + ordinal] : [])].includes(d.scope),
    ) || [];
  return candidates.find((d) => d.scope === 'order:' + ordinal) || candidates.at(-1);
}
export function confirmedValue(memory: TaskMemory | undefined, key: string, ordinal?: number) {
  const d = decision(memory, key, ordinal);
  return d?.status === 'confirmed' ? d.value : undefined;
}
