import { useState } from 'react';
import { useLoad } from '../ui/index';
import type { TurnFacts } from './assistant-types';
import { executedItems } from './plan-card';
import { forgetMemory, readMemories, type AssistantMemoryView } from './assistant-api';

/** 记录里提到、记忆列表里已经没有的记忆（忘掉过、在面板里删了）；还没读到列表时一条也不算 */
function goneMemories(ids: string, view: AssistantMemoryView | null) {
  const gone: Record<number, true> = {};
  if (!view || !ids) return gone;
  const kept = new Set(view.memories.map((m) => m.id));
  for (const id of ids.split(',').map(Number)) if (!kept.has(id)) gone[id] = true;
  return gone;
}

/**
 * 回复下面“已执行：……”那一行。助手自己记下、改过的长期记忆后面带一个“忘掉”：点了直接删掉这条记忆
 * （和“更多 → 记忆”里的删除同一个地址），这一项原来那句划掉、后面写“已忘掉”，看得出撤的是哪一条。这一行是历史记录，不跟着记忆变：
 * 显示时按记忆列表核一下，已经不在的（忘掉过、在面板里删了）也这样写，不再给按钮。
 */
export default function AssistantExecuted({ executed }: { executed: TurnFacts['executed'] }) {
  /** 这里点过“忘掉”的：记忆编号 → true（已经忘掉了）或没忘成的原因 */
  const [clicked, setClicked] = useState<Record<number, true | string>>({});
  const ids = executed.flatMap((e) => (e.memoryId ? [e.memoryId] : [])).join(',');
  // 核不了（网断等）就照记录显示，点“忘掉”时服务端会说清楚
  const listed = useLoad(ids || null, () => readMemories());
  const settled = { ...clicked, ...goneMemories(ids, listed.loading ? null : listed.data) };
  return (
    <div className="ga-tool-result">
      已执行：
      {executedItems(executed, settled).map(({ forget, ...item }, i) => (
        <span key={i}>
          {i > 0 && '；'}
          {item.forgotten ? (
            <>
              <s>{item.text}</s>（已忘掉）
            </>
          ) : (
            item.text + (item.note ? '（' + item.note + '）' : '')
          )}
          {forget !== undefined && (
            <button
              type="button"
              className="ga-fact-forget"
              onClick={async () => {
                try {
                  await forgetMemory(forget);
                  setClicked((now) => ({ ...now, [forget]: true }));
                } catch (error) {
                  setClicked((now) => ({ ...now, [forget]: error instanceof Error ? error.message : '没有忘掉，请到“更多 → 记忆”里删。' }));
                }
              }}
            >
              忘掉
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
