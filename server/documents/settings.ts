import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { audit, inSavepoint, one, parseStoredJson, requirePermission, rows } from '../core/index.js';
import { AppError } from '../core/index.js';
import {
  defaultDocumentTemplates,
  templateSchema,
  templateSettingsSchema,
  type DocumentTemplate,
  type DocumentTemplateState,
} from '../../shared/documents/index.js';
/** document 列存的内容：模板和两类单据各自的默认模板。写入和读出用同一份结构。 */
const storedTemplates = z.strictObject({
  templates: z.array(templateSchema),
  defaults: z.strictObject({ purchase: z.string(), delivery: z.string() }),
});
const settingsRow = rows.document_template_settings.pick({ revision: true, document: true });
type Kind = DocumentTemplate['kind'];
/** 没指定默认模板：原来的默认还在就留着，删掉了就用这类单据的第一套。 */
function keptDefault(templates: DocumentTemplate[], before: DocumentTemplateState, kind: Kind) {
  if (templates.some((t) => t.kind === kind && t.id === before.defaults[kind])) return before.defaults[kind];
  const first = templates.find((t) => t.kind === kind);
  // 模板设置的结构已保证两类单据都至少有一套，走到这里说明结构规则被改坏了
  if (!first) throw new Error('模板设置里没有这类单据的模板：' + kind);
  return first.id;
}
/**
 * 单据模板设置：存在 document_template_settings，只有一行；没有这一行就是出厂默认。
 * revision 是列（每保存一次加一，导出时用它判断生成期间模板有没有被改），document 里只存 templates 和 defaults。
 * 初始化（清空业务数据）不清这张表。
 */
export class DocumentTemplateSettings {
  constructor(readonly store: Store) {}
  get(): DocumentTemplateState {
    const row = one(this.store.db, settingsRow, 'SELECT revision,document FROM document_template_settings WHERE id=1');
    if (!row) return defaultDocumentTemplates();
    const stored = parseStoredJson(storedTemplates, row.document, 'document_template_settings.document');
    return { revision: row.revision, templates: stored.templates, defaults: stored.defaults };
  }
  save(raw: unknown, who: Actor) {
    const actor = requirePermission(who, 'business:edit'),
      v = templateSettingsSchema.parse(raw);
    return inSavepoint(this.store.db, () => {
      const before = this.get();
      if (before.revision !== v.expectedRevision)
        throw new AppError('模板已在其他页面修改，请刷新后再保存。', 409);
      const after: DocumentTemplateState = {
        revision: before.revision + 1,
        templates: v.templates,
        defaults: v.defaults ?? {
          purchase: keptDefault(v.templates, before, 'purchase'),
          delivery: keptDefault(v.templates, before, 'delivery'),
        },
      };
      this.store.db
        .prepare(
          'INSERT INTO document_template_settings(id,revision,document,updated_at,actor_id,actor_name) VALUES(1,?,?,?,?,?) ' +
            'ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document,updated_at=excluded.updated_at,actor_id=excluded.actor_id,actor_name=excluded.actor_name',
        )
        .run(
          after.revision,
          JSON.stringify(storedTemplates.parse({ templates: after.templates, defaults: after.defaults })),
          new Date().toISOString(),
          actor.id,
          actor.name,
        );
      audit(this.store, actor, {
        action: 'template-settings',
        entity: 'document_templates',
        id: null,
        document: { before, after },
      });
      return after;
    });
  }
}
