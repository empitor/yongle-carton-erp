import type { z } from 'zod';
import { RECORD_FIRST_VERSION, archiveInputSchema, recordArchiveId, type ArchiveResult } from '../../shared/core/index.js';
import type { Actor } from './actor.js';
import type { Store } from './db.js';
import { audit } from './audit.js';
import { AppError, failureMessage } from './errors.js';
import { isLocalAdministrator } from './local-administrator.js';
import { inSavepoint } from './savepoint.js';
import { canEnterSuperMode, isSuperMode, requirePermission } from './permissions.js';

/*
 * 归档、恢复只有这一份做法：档案（删除归档）、单据（单据流转）、识别文件（识别导入）都走这里，
 * 批量、逐条返回结果，版本校验、重复点、被拦时的说法都一样。
 * 记录存在哪、怎么读、怎么打标记、怎么记审计、什么时候不能归档，由调用方的 ArchiveTarget 给出；
 * 业务库里的记录（record_lifecycle 打标记）用 recordArchiveTarget 现成的一套。
 */

/** 不能归档时后半句：现在就能删的说“可以直接删除”；能进超级管理员模式还没进的说先进模式；删不了的账号不提删除 */
function deleteTail(actor: Actor) {
  if (isLocalAdministrator(actor) || isSuperMode(actor)) return '；要删的话可以直接删除。';
  if (canEnterSuperMode(actor)) return '；要删的话先在账号菜单的“系统维护”里进入超级管理员模式，再删除。';
  return '。';
}

/** Row 是 load 读出来、交给 blocked 和 write 的那条记录（审计里记的原样） */
export type ArchiveTarget<Id extends number | string, Row = unknown> = {
  /** 编号的写法：业务库是正整数，识别文件是 UUID */
  id: z.ZodType<Id>;
  /** 版本号从几开始：业务库从 1，识别文件从 0 */
  firstVersion: 0 | 1;
  /** 读一条（含已归档的）：是哪类记录（出错时的说法、审计里用）、版本、现在是否已归档、审计里记的原样；不存在返回 undefined */
  load(id: Id): { label: string; version: number; archived: boolean; row: Row } | undefined;
  /**
   * 不能归档的原因（“……，不能归档”，后半句由这里按账号补）；以“。”结尾的是完整的话，不补删除的说法。
   * 能归档返回 null
   */
  blocked(id: Id, row: Row): string | null;
  /** 打上或去掉归档标记，连同审计和写完要做的（换版本号、取消正在跑的识别等） */
  write(id: Id, archive: boolean, actor: Actor, found: { label: string; row: Row }): void;
  /** 一条一个事务：中途出错整条撤回 */
  transaction(job: () => void): void;
};

/** 批量归档、恢复：每条单独一个事务，逐条返回 { id, success, message } */
export function changeArchive<Id extends number | string, Row>(
  raw: unknown,
  who: Actor | null | undefined,
  target: ArchiveTarget<Id, Row>,
): ArchiveResult<Id> {
  const actor = requirePermission(who, 'business:edit'),
    input = archiveInputSchema(target.id, target.firstVersion).parse(raw),
    archive = input.action === 'archive';
  if (new Set(input.items.map((i) => i.id)).size !== input.items.length) throw new AppError('记录重复。');
  const tail = deleteTail(actor);
  const results: ArchiveResult<Id>['results'] = [];
  for (const item of input.items) {
    const id = item.id;
    let label = '';
    try {
      let message = '';
      target.transaction(() => {
        const found = target.load(id);
        if (!found) throw new AppError('记录不存在。', 404);
        label = found.label;
        // 已经是要的状态就原样算成功：双击、网络重试不报“已修改”
        if (archive === found.archived) {
          message = found.archived ? '已经归档' : '已经恢复';
          return;
        }
        if (found.version !== item.version) throw new AppError('记录已修改，请刷新。', 409);
        if (archive) {
          const reason = target.blocked(id, found.row);
          if (reason) throw new AppError(reason.endsWith('。') ? reason : reason + tail);
        }
        target.write(id, archive, actor, found);
        message = archive ? '已归档，能在归档里恢复' : '已恢复归档记录';
      });
      results.push({ id, success: true, message });
    } catch (e) {
      results.push({
        id,
        success: false,
        message: failureMessage(e, (archive ? '批量归档 ' : '批量恢复 ') + (label ? label + ' ' : '') + '#' + id, '保存失败'),
      });
    }
  }
  return { results };
}

/** 业务库里的记录：归档标记记在 record_lifecycle，审计记进业务库，每条一个 SAVEPOINT */
export function recordArchiveTarget<Row>(
  store: Store,
  options: {
    /** 读一条（含已归档的）：标记记在哪（record_lifecycle.entity）、版本、审计里记的原样 */
    load(id: number): { entity: string; version: number; row: Row } | undefined;
    blocked(id: number, row: Row): string | null;
    /** 写完以后要做的（单据换版本号，打开着的窗口提示刷新） */
    after?(id: number): void;
  },
): ArchiveTarget<number, Row> {
  return {
    id: recordArchiveId,
    firstVersion: RECORD_FIRST_VERSION,
    load(id) {
      const found = options.load(id);
      if (!found) return undefined;
      return { label: found.entity, version: found.version, archived: store.archived(found.entity, id), row: found.row };
    },
    blocked: options.blocked,
    write(id, archive, actor, { label: entity, row }) {
      if (archive) store.markArchived(entity, id, actor.id);
      else store.unarchive(entity, id);
      options.after?.(id);
      audit(store, actor, {
        action: archive ? 'archive' : 'restore',
        entity,
        id,
        document: { before: row, beforeArchived: !archive, afterArchived: archive },
      });
    },
    transaction(job) {
      inSavepoint(store.db, job);
    },
  };
}
