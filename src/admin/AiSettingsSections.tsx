import { Bot, LoaderCircle, LockKeyhole } from 'lucide-react';
import { DEEPSEEK_NAME, type AiKeyState, type AiSettingsView } from '../../shared/ai/index';
import { MenuItem, MoreMenu, StatusChip } from '../ui/index';
import { concurrencyLabel, stateNames, stateTone } from './ai-settings-words';
import type { AiKeyActions } from './useAiSettings';

/* AI 设置页的上下两段：顶上的“当前 AI 服务”，底栏的说明和按钮；中间“识别”一行。 */

/** 当前用的 AI 服务、模型和密钥状态（正在测试、查余额时显示“正在检查”） */
export function AiOverview({ view, busy }: { view: AiSettingsView | null; busy: string }) {
  const state: AiKeyState | 'checking' =
    busy === 'test' || busy === 'balance' ? 'checking' : view?.check.state || 'missing';
  return (
    <section className="adm-ai-overview" aria-label="当前 AI 服务">
      <Bot size={20} aria-hidden="true" className="adm-ai-icon" />
      <div>
        <small>AI 服务</small>
        <strong>{DEEPSEEK_NAME}</strong>
      </div>
      <div>
        <small>模型</small>
        <strong>{view?.model || 'deepseek-flash'}</strong>
      </div>
      <StatusChip tone={stateTone(state)}>{stateNames[state]}</StatusChip>
    </section>
  );
}

/** 同时识别文件数：没进超级管理员模式（changing 为假）时只显示 */
export function ConcurrencyRow({
  value,
  changing,
  change,
}: {
  value: number;
  changing: boolean;
  change: (value: number) => void;
}) {
  return (
    <label className="adm-ai-pref-row">
      <span>同时识别文件数</span>
      {!changing ? (
        <strong>{concurrencyLabel(value)}</strong>
      ) : (
        <select aria-label="AI识别并发数量" value={value} onChange={(e) => change(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {concurrencyLabel(n)}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}

/**
 * 底栏：密钥存在哪的说明；“更多”里只保存不测试、删除密钥；主按钮“保存并测试”或“重新测试”。
 * 没进超级管理员模式时只剩“重新测试”（不改配置）。
 */
export function KeyFooter({
  changing,
  hasKey,
  locked,
  busy,
  actions,
}: {
  changing: boolean;
  hasKey: boolean;
  locked: boolean;
  busy: string;
  actions: AiKeyActions;
}) {
  const typed = !!actions.apiKey.trim();
  const label = busy === 'test' ? '正在测试…' : busy === 'save' ? '正在保存…' : typed || !hasKey ? '保存并测试' : '重新测试';
  return (
    <footer className="adm-ai-footer">
      <span className="adm-ai-note">
        <LockKeyhole size={14} aria-hidden="true" />
        密钥加密保存在服务器上，不会传回浏览器。测试只查余额，不产生费用。
      </span>
      {changing && (
        <MoreMenu label="密钥更多操作">
          <MenuItem disabled={locked || !typed} onClick={() => void actions.saveKey(false)}>
            只保存不测试
          </MenuItem>
          {hasKey && <hr className="more-menu-sep" />}
          {hasKey && (
            <MenuItem
              danger
              disabled={locked}
              onClick={() => actions.setDeleting(true)}
            >
              删除密钥
            </MenuItem>
          )}
        </MoreMenu>
      )}
      {(changing || hasKey) && (
        <button
          type="button"
          className="primary"
          disabled={locked || (!typed && !hasKey)}
          onClick={() => void (typed ? actions.saveKey(true) : actions.retest())}
        >
          {(busy === 'test' || busy === 'save') && <LoaderCircle size={14} className="ai-spin" aria-hidden="true" />}
          {label}
        </button>
      )}
    </footer>
  );
}
