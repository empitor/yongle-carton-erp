// 订单识别测试共用的夹具：模型替身交回的“填好的表”、临时工作区、把模型卡住等它进来。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImportManager } from '../server/import/manager.js';
import type { WorkspaceOptions } from '../server/import/workspace-store.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { defaultPromptPreset } from '../server/import/default-prompts/sales-order.js';
import { supplierDefaultPreset } from '../server/import/default-prompts/supplier-delivery.js';
import { Store } from '../server/core/index.js';
import type { AiSettingsManager } from '../server/ai/settings-manager.js';
import type { OrderDraft } from '../shared/import/order-draft.js';
import { draftFromForm, orderFormSchema } from '../shared/import/order-form.js';
import { xlsxFixture } from './import-fixtures.js';
import { fakeAiSettings, type FakeChat } from './fake-deepseek.js';

/**
 * 建识别导入管理器（ImportManager 的选项都必填，这里替测试补齐）：没给的业务库、订单提示词、到货识别现建在内存里，
 * 原件归档默认放在工作区目录下的 archive；这些现建的跟着 close() 一起关。
 */
export function testImports(options: Pick<WorkspaceOptions, 'directory' | 'settings'> & Partial<WorkspaceOptions>) {
  const owned: { close(): void }[] = [];
  const own = <T extends { close(): void }>(made: T) => (owned.push(made), made);
  const store = options.store ?? own(new Store(':memory:'));
  const promptPresets = options.promptPresets ?? own(new PromptPresetManager(':memory:', defaultPromptPreset));
  const receiptAi =
    options.receiptAi ?? new ReceiptAi(store, options.settings, own(new PromptPresetManager(':memory:', supplierDefaultPreset)));
  return new (class extends ImportManager {
    override close() {
      super.close();
      for (const made of owned) made.close();
    }
  })({ archiveDirectory: join(options.directory, 'archive'), ...options, store, promptPresets, receiptAi });
}

type Cells = Record<string, string | null>;

/** 模型替身交回的“填好的表”：两行纸箱，每格是原件上的字，没写的不填；header 里给的栏目盖掉默认的。 */
export function filledForm(header: Cells = {}) {
  const head: Cells = {
    buyerName: '虚构客户',
    supplierName: '宁波甬勒包装制品有限公司',
    purchaseOrderNumber: 'TEST-01',
    orderDate: '2026-09-01',
    deliveryDate: '2026-09-04',
    currency: '人民币',
    taxRate: '13',
    taxMode: '含税',
    statedTotalQuantity: '3000',
    statedTotalAmount: '2850.00',
    ...header,
  };
  return {
    header: head,
    lines: [
      ['纸箱A', '1000', '1.39', '1390.00'],
      ['纸箱B', '2000', '0.73', '1460.00'],
    ].map(([name, q, p, total]) => ({
      productName: name,
      specification: '300×200×150毫米',
      quantity: q,
      unit: '只',
      unitPrice: p,
      statedAmount: total,
    })) as Cells[],
    uncertain: [] as { line?: number | null; field: string; reason: string }[],
    warnings: [] as string[],
  };
}

export function asDraft(): OrderDraft {
  const d = draftFromForm(orderFormSchema.parse(filledForm()));
  return { ...d, lines: d.lines.map((fields) => ({ id: randomUUID(), fields })) };
}

/** 临时目录；Windows 下机器忙时文件可能还被占着，删除带重试。 */
export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** 识别工作区：模型替身按 chat 回答（默认交回 filledForm()）；extra 是 ImportManager 别的选项（如导入台账所在的业务库）。 */
export function importWorkspace(chat: FakeChat = () => filledForm(), extra: Partial<WorkspaceOptions> = {}) {
  const temp = tempDir('erp-import-');
  const { settings, fake } = fakeAiSettings({ chat });
  const manager = testImports({ ...extra, directory: temp.dir, settings });
  return {
    directory: temp.dir,
    settings,
    fake,
    manager,
    /** 上传一份原件，返回工作区的当前样子 */
    upload: async (bytes: Buffer = xlsxFixture(), name = '虚构订单.xlsx') =>
      manager.get((await manager.upload(bytes, name)).workspace.id),
    /** 关掉当前的 manager（测试重开时换成新的那个）、设置库，删目录 */
    close() {
      this.manager.close();
      settings.close();
      temp.remove();
    },
  };
}

/** 已上传一份 xlsx 的识别工作区；setReply 换模型的回答，calls() 是发给模型的识别请求。 */
export async function fixture() {
  let reply: unknown = filledForm();
  const f = importWorkspace(() => reply);
  const w = await f.upload();
  return {
    ...f,
    w,
    calls: () => f.fake.chatCalls(),
    setReply: (r: unknown) => void (reply = r),
  };
}

export async function recognized(f: Awaited<ReturnType<typeof fixture>>) {
  return f.manager.analyze(f.w.id, { expectedRevision: f.w.revision });
}

/** 把识别卡在发给模型之前：started 在请求进来时兑现，release() 后照常发；restore() 换回原样。 */
export function holdModel(settings: AiSettingsManager) {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r)),
    original = settings.fillForm.bind(settings);
  settings.fillForm = async (...args: Parameters<AiSettingsManager['fillForm']>) => {
    entered();
    await gate;
    return original(...args);
  };
  return { started, release, restore: () => void (settings.fillForm = original) };
}
