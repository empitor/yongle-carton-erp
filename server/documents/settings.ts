import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { audit, requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import {
  defaultDocumentTemplates,
  templateSettingsSchema,
  normalizeTemplateState,
} from '../../shared/document-templates.js';
export class DocumentTemplateSettings {
  constructor(readonly store: Store) {}
  get(): ReturnType<typeof defaultDocumentTemplates> {
    const row = this.store.db
      .prepare(
        "SELECT result FROM operation_requests WHERE kind='document-template-settings' AND request_id='current'",
      )
      .get();
    return row
      ? normalizeTemplateState(JSON.parse(String(row.result)))
      : defaultDocumentTemplates();
  }
  save(raw: unknown, who: Actor) {
    const actor = requirePermission(who, 'business:edit'),
      v = templateSettingsSchema.parse(raw);
    this.store.db.exec('SAVEPOINT document_template_settings');
    try {
      const before = this.get();
      if (before.revision !== v.expectedRevision)
        throw new ImportError('模板已在其他页面修改，请刷新后再保存。', 409);
      const after = normalizeTemplateState({
        revision: before.revision + 1,
        templates: v.templates,
        defaults:
          v.defaults ||
          Object.fromEntries(
            (['purchase', 'delivery'] as const).map((k) => [
              k,
              v.templates.some((t) => t.kind === k && t.id === before.defaults[k])
                ? before.defaults[k]
                : v.templates.find((t) => t.kind === k)!.id,
            ]),
          ),
      });
      this.store.db
        .prepare(
          "INSERT OR REPLACE INTO operation_requests VALUES('document-template-settings','current',?,?)",
        )
        .run(String(after.revision), JSON.stringify(after));
      audit(
        this.store,
        actor,
        'business-documents',
        'template-settings',
        'document_templates',
        null,
        { before, after },
      );
      this.store.db.exec('RELEASE document_template_settings');
      return after;
    } catch (e) {
      this.store.db.exec(
        'ROLLBACK TO document_template_settings; RELEASE document_template_settings',
      );
      throw e;
    }
  }
}
