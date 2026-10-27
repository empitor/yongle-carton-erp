import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.js';
import { ImportManager } from '../server/import/manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { ReceiptAi, supplierDefaultPreset } from '../server/flow/receipt-ai.js';
import { OperationsService } from '../server/operations/service.js';
import { makeSettings, actor } from './assistant-fixture.js';
import { imageFixture } from './import-fixtures.js';
import type { AiSettingsManager } from '../server/ai/settings-manager.js';
export const arrivalAnalysis = () => ({
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
export async function arrivalAssistantFixture(
  realSettings?: AiSettingsManager,
  image = imageFixture(),
) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-arrival-assistant-')),
    store = new Store(join(dir, 'erp.sqlite')),
    replies: any[] = [],
    requests: any[] = [];
  const settings =
    realSettings ||
    makeSettings(async (req) => {
      requests.push(req);
      const next = replies.shift() || {
        reply: '已读取当前到货草稿。',
        operations: [],
        questions: [],
        lookups: [],
      };
      const result = typeof next === 'function' ? await next(req) : next;
      if (result instanceof Error) throw result;
      const body = {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(result) }],
          },
        ],
      };
      if ((req.body as any).stream) {
        req.onSseEvent?.({
          event: 'response.output_text.delta',
          data: JSON.stringify({
            type: 'response.output_text.delta',
            delta: JSON.stringify(result),
          }),
        });
        req.onSseEvent?.({
          event: 'response.completed',
          data: JSON.stringify({ type: 'response.completed', response: body }),
        });
        return { status: 200, body: null, streamed: true };
      }
      return { status: 200, body };
    });
  const prompts = new PromptPresetManager(':memory:', supplierDefaultPreset),
    orderPrompts = new PromptPresetManager(':memory:'),
    ai = new ReceiptAi(store, settings, prompts),
    ops = new OperationsService(store);
  const supplier = ops.saveSupplier(
      { name: '虚构到货纸板厂', notes: 'PRIVATE-ARCHIVE-NOTES-MUST-NOT-SEND' },
      actor,
    ),
    raw = ops.saveItem(
      {
        name: '虚构匹配纸板甲',
        kind: 'raw',
        specification: '100x80cm',
        material: 'K=A',
        flute: 'BC',
        length: 100,
        width: 80,
        dimensionUnit: 'cm',
        unit: '张',
      },
      actor,
    );
  const options = { directory: join(dir, 'imports'), settings, promptPresets: orderPrompts };
  let manager = new ImportManager(options);
  async function upload(name = '虚构到货单.png') {
    const w = (await manager.upload(image, name, true)).workspace;
    let mode = manager.setMode(w.id, { expectedRevision: w.revision, mode: 'arrival' });
    const source = ai.upload(image, name, actor)!;
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
  const view = () => ai.draftAssistant.view(manager, workspace.id, actor);
  const chat = (message: string, requestId = crypto.randomUUID(), live = () => actor) =>
    ai.draftAssistant.chat(
      manager,
      workspace.id,
      {
        expectedRevision: view().workspace.revision,
        message,
        requestId,
        stream: true,
        profile: settings.view().active,
      },
      actor,
      live,
    );
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
    view,
    chat,
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
