import { DEEPSEEK_KEY_PAGE } from '../../shared/ai/index';
import { ConfirmDialog, FormField, FormMessage, FormSection } from '../ui/index';
import { SuperModeNotice, useAuthState } from '../ui/index';
import { BalanceLine, Feedback, KeyInput } from './AiKeyParts';
import { AiOverview, ConcurrencyRow, KeyFooter } from './AiSettingsSections';
import { useAiKeyActions, useAiSettingsData } from './useAiSettings';

/**
 * API 配置：只接 DeepSeek 官方接口，这里只填一个密钥。
 * 主按钮“保存并测试”：先查一次余额（免费）确认密钥对，再加密保存；只保存不测试、删除密钥在“更多”里。
 * 数据和动作在 useAiSettings。
 */
export default function AiSettingsPage() {
  const data = useAiSettingsData();
  const actions = useAiKeyActions(data);
  const { view, busy } = data;
  // 改密钥和识别设置要在超级管理员模式里（没开登录的测试实例不查）；重新测试、查余额不改配置，不用进
  const actor = useAuthState()?.actor,
    changing = !actor || !!actor.superAdminMode;
  const locked = !!busy || !view || !!view.storageError;
  const hasKey = !!view?.hasKey;
  return (
    <div className="adm-ai">
      <AiOverview view={view} busy={busy} />
      {view?.storageError && <FormMessage>{view.storageError}</FormMessage>}
      <SuperModeNotice what="改密钥和识别设置" />
      <Feedback message={data.notice} />
      <section className="adm-ai-editor" aria-label="DeepSeek 密钥">
        <fieldset disabled={locked} className="adm-ai-fieldset">
          <FormSection title="密钥" columns={1}>
            <FormField
              label={
                <>
                  DeepSeek 密钥{' '}
                  <span className={'adm-ai-key' + (hasKey ? ' saved' : '')}>{hasKey ? '已加密保存' : '还没保存'}</span>
                </>
              }
              hint={
                <>
                  到{' '}
                  <a href={DEEPSEEK_KEY_PAGE} target="_blank" rel="noreferrer noopener">
                    DeepSeek 开放平台
                  </a>{' '}
                  创建密钥。
                </>
              }
            >
              {changing && (
                <KeyInput
                  value={actions.apiKey}
                  change={(value) => {
                    actions.setApiKey(value);
                    data.setNotice(null);
                  }}
                  shown={actions.showKey}
                  toggle={() => actions.setShowKey(!actions.showKey)}
                  hasKey={hasKey}
                />
              )}
            </FormField>
            {view?.hasKey && (
              <BalanceLine
                view={view}
                balance={data.balance}
                balanceError={data.balanceError}
                checking={busy === 'balance'}
                locked={locked}
                refresh={() => void data.refreshBalance()}
              />
            )}
          </FormSection>
          <FormSection title="识别" columns={1}>
            <ConcurrencyRow
              value={view?.recognitionConcurrency || 3}
              changing={changing}
              change={(value) => void actions.setConcurrency(value)}
            />
          </FormSection>
        </fieldset>
        <KeyFooter changing={changing} hasKey={hasKey} locked={locked} busy={busy} actions={actions} />
      </section>
      {actions.deleting && (
        <ConfirmDialog
          title="删除 DeepSeek 密钥"
          confirmLabel="删除密钥"
          busyLabel="正在删除…"
          danger
          busy={busy === 'delete'}
          close={() => actions.setDeleting(false)}
          onConfirm={() => void actions.removeKey()}
        >
          <p>删除已保存的 DeepSeek 密钥？删除后识别、助手、语音都不能用，业务数据不受影响。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
