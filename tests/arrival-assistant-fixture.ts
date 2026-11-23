import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/core/index.js';
import { ImportManager } from '../server/import/manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { defaultPromptPreset } from '../server/import/default-prompts/sales-order.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';
import { supplierDefaultPreset } from '../server/import/default-prompts/supplier-delivery.js';
import { makeSettings } from './assistant-fixture.js';
import { businessBase } from './business-base-fixture.js';
import { imageFixture } from './import-fixtures.js';
import type { AiSettingsManager } from '../server/ai/settings-manager.js';
import type { ChatCall } from './fake-deepseek-wire.js';
import { actor } from './actor-fixture.js';
const arrivalAnalysis = () => ({
  supplierName: '虚构到货纸板厂',
  reference: 'FICTIONAL-DH-TEST',
  purchaseNumber: null,
  date: '2026-10-27',
  notes: '虚构验收，不是真实经营记录',
  warnings: [],
  lines: ['甲', '乙'].map((name, i) => ({
    name: '虚构纸板' + name,
    specification: '100x80cm',
    material: i ? 'K=B' : 'K=A',
    flute: 'BC',
    length: '100',
    width: '80',
    dimensionUnit: 'cm',
    quantity: '100',
    unit: '张',
    area: '80',
    unitPrice: '2.1234',
    priceBasis: 'area',
    notes: null,
  })),
});
/** 排队的回答可以是现算回答的函数（拿到这次请求） */
const isThunk = (v: unknown): v is (call: ChatCall) => unknown => typeof v === 'function';
/** 模型替身：按 replies 依次回答（排完了说一句默认的话），回答是 Error 就当上游出错抛出；请求记进 requests */
function standInSettings(replies: unknown[], requests: ChatCall[]) {
  return makeSettings(async (_body, call) => {
    requests.push(call);
    const next = replies.shift() || { message: '已读取当前到货单。' };
    const result = isThunk(next) ? await next(call) : next;
    if (result instanceof Error) throw result;
    return result;
  });
}
/** 虚构供应商（备注是不许发给模型的内容）和一种能对上识别结果第一行的原材料 */
function seedRecords(base: ReturnType<typeof businessBase>) {
  const supplier = base.supplier({ name: '虚构到货纸板厂', notes: 'PRIVATE-ARCHIVE-NOTES-MUST-NOT-SEND' }),
    raw = base.raw({
      name: '虚构匹配纸板甲',
      specification: '100x80cm',
      material: 'K=A',
      flute: 'BC',
      length: 100,
      width: 80,
      dimensionUnit: 'cm',
    });
  return { supplier, raw };
}
export async function arrivalAssistantFixture(realSettings?: AiSettingsManager, image = imageFixture()) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-arrival-assistant-')),
    store = new Store(join(dir, 'erp.sqlite')),
    replies: unknown[] = [],
    requests: ChatCall[] = [];
  const settings = realSettings || standInSettings(replies, requests);
  const prompts = new PromptPresetManager(':memory:', supplierDefaultPreset),
    orderPrompts = new PromptPresetManager(':memory:', defaultPromptPreset),
    ai = new ReceiptAi(store, settings, prompts),
    base = businessBase(actor, store),
    { ops } = base;
  const { supplier, raw } = seedRecords(base);
  const options = {
    directory: join(dir, 'imports'),
    archiveDirectory: join(dir, 'archive'),
    settings,
    promptPresets: orderPrompts,
    store,
    receiptAi: ai,
  };
  let manager = new ImportManager(options);
  async function upload(name = '虚构到货单.png') {
    const w = (await manager.upload(image, name, true)).workspace;
    let mode = manager.setMode(w.id, { expectedRevision: w.revision, mode: 'arrival' });
    const source = ai.upload(image, name, actor);
    if (!source) throw new Error('送货单原件没有存下');
    store.db
      .prepare('UPDATE flow_sources SET document=? WHERE id=?')
      .run(
        JSON.stringify({ result: arrivalAnalysis(), recognizedAt: new Date().toISOString() }),
        source.id,
      );
    mode = manager.linkArrival(mode.id, {
      expectedRevision: mode.revision,
      docId: null,
      sourceId: source.id,
    });
    return mode;
  }
  const workspace = await upload();
  return {
    dir,
    store,
    settings,
    prompts,
    orderPrompts,
    ai,
    ops,
    supplier,
    raw,
    workspace,
    replies,
    requests,
    actor,
    get manager() {
      return manager;
    },
    upload,
    reopen() {
      manager.close();
      manager = new ImportManager(options);
    },
    close() {
      manager.close();
      store.close();
      prompts.close();
      orderPrompts.close();
      if (!realSettings) settings.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
