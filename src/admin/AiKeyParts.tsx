import { Eye, EyeOff, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import type { AiBalance, AiSettingsView } from '../../shared/ai/index';
import { FormMessage } from '../ui/index';
import { currency, errorLabels, money, type AiMessage } from './ai-settings-words';

/* AI 设置页的几小块：结果提示、密钥输入框、余额那一行。 */

/** 一条结果提示：成功用蓝底，失败用红底并带上错误类别。 */
export function Feedback({ message }: { message: AiMessage | null }) {
  if (!message) return null;
  return (
    <FormMessage tone={message.ok ? 'info' : 'danger'}>
      {message.code && <strong>{errorLabels[message.code] || '没成功'}： </strong>}
      {message.message}
    </FormMessage>
  );
}

/** 密钥输入框：只显示本次输入的，存过的密钥不回显。 */
export function KeyInput({
  value,
  change,
  shown,
  toggle,
  hasKey,
}: {
  value: string;
  change: (value: string) => void;
  shown: boolean;
  toggle: () => void;
  hasKey: boolean;
}) {
  return (
    <span className="adm-ai-secret">
      <input
        id="ai-api-key"
        type={shown ? 'text' : 'password'}
        value={value}
        autoComplete="new-password"
        spellCheck={false}
        placeholder={hasKey ? '不改就留空' : '粘贴 DeepSeek 密钥（sk- 开头）'}
        onChange={(e) => change(e.target.value)}
      />
      <button type="button" aria-label={shown ? '隐藏本次输入的密钥' : '显示本次输入的密钥'} onClick={toggle}>
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </span>
  );
}

/** 余额那一行：查到的余额（含赠送）、余额不足的提醒、查不到的原因，右边“刷新”（不产生费用）。 */
export function BalanceLine({
  view,
  balance,
  balanceError,
  checking,
  locked,
  refresh,
}: {
  view: AiSettingsView;
  balance: AiBalance | null;
  balanceError: string;
  checking: boolean;
  locked: boolean;
  refresh: () => void;
}) {
  const low = balance && !balance.available;
  const first = balance?.balances[0];
  return (
    <p className={'adm-ai-conn tone-' + (low || balanceError ? 'danger' : balance ? 'success' : 'neutral')} role="status">
      <Wallet size={14} aria-hidden="true" />
      <span>
        {checking ? (
          '正在查余额…'
        ) : balance ? (
          <>
            <strong>账户余额 {first ? money(first) : '—'}</strong>
            {first && Number(first.granted) > 0 && (
              <small>
                （其中赠送 {currency(first)}
                {first.granted}）
              </small>
            )}
            {low && ' 余额不足，识别、助手、语音都会失败。请到 DeepSeek 开放平台充值。'}
          </>
        ) : balanceError ? (
          '暂时查不到余额：' + balanceError
        ) : (
          view.check.message
        )}
      </span>
      <button type="button" className="secondary adm-ai-refresh" disabled={locked} title="重新查余额，不产生费用" onClick={refresh}>
        {checking ? (
          <LoaderCircle size={14} className="ai-spin" aria-hidden="true" />
        ) : (
          <RefreshCw size={14} aria-hidden="true" />
        )}
        刷新
      </button>
    </p>
  );
}
