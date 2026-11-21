import { aiSettingsTab } from '../shared/assistant/index';
import { useEffect, useState } from 'react';
import { AiSettingsPage, ChannelSettings, PromptSettingsPage } from './admin/index';
import { canEditBusiness, useLoad, type AuthState, loadingText } from './ui/index';
import { readAiStatus } from './shell-api';
import { DEEPSEEK_NAME, promptModules } from '../shared/ai/index';
import { AssistantPlugins } from './assistant/index';
import { DocumentTemplateSettings } from './documents/index';

/** 不是管理员：看得到现在用的模型、管理员填没填密钥；密钥只有管理员能改。 */
function AiUserPreferences() {
  const status = useLoad('assistant', readAiStatus);
  // null 正在读，false 读不到（没有助手权限）就不显示这一行
  const ai = status.error ? false : status.data;
  return (
    <div className="adm-ai-user">
      <p className="adm-muted" role="note">
        API 配置只有管理员能改。聊天和识别用管理员填好的 DeepSeek 密钥，你不用设置。
      </p>
      {ai !== false && (
        <p className="adm-ai-user-model">
          <span>正在使用</span>
          <strong>
            {ai === null ? loadingText() : DEEPSEEK_NAME + '（' + ai.model + '）' + (ai.ready ? '' : '，管理员还没填密钥')}
          </strong>
        </p>
      )}
    </div>
  );
}

/**
 * 设置：页签和财务各页用同一套样式（record-view-tabs fin-tabs）。
 * 插件与工具是开发和排查用的，归在最后的“高级”页签；链接参数仍是 tab=tools。
 */
export default function AiSettingsHub({ actor }: { actor: NonNullable<AuthState['actor']> }) {
  const read = () =>
    location.hash.includes('tab=channels') ? 'channels' : aiSettingsTab(location.hash);
  const [hashTab, setTab] = useState(read);
  const [promptKind, setPromptKind] = useState(() =>
    location.hash.includes('assistant=1') ? 'assistant' : 'sales-order',
  );
  useEffect(() => {
    const update = () => {
      setTab(read());
      if (location.hash.includes('assistant=1')) setPromptKind('assistant');
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const admin = actor.role === 'super_admin';
  const prompts = canEditBusiness({ actor });
  // 渠道页只有管理员有、提示词页只有可改业务的账号有，别人从链接点进来退回默认页签，不发越权请求、不留白屏。
  const tab =
    (hashTab === 'channels' && !admin) || (hashTab === 'prompts' && !prompts)
      ? aiSettingsTab('#ai-settings')
      : hashTab;
  const module = promptModules.find((item) => item.id === promptKind) ?? promptModules[0];
  const tabs: [string, string][] = [
    ['api', 'API 配置'],
    ...(prompts ? ([['prompts', '提示词']] satisfies [string, string][]) : []),
    ['templates', '单据模板'],
    ...(admin ? ([['channels', '消息接入']] satisfies [string, string][]) : []),
    ['tools', '高级'],
  ];
  return (
    <div className="adm-settings">
      <nav
        className="record-view-tabs fin-tabs ai-settings-tabs adm-settings-tabs"
        aria-label="设置分类"
        role="tablist"
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            className={tab === key ? 'selected' : ''}
            aria-selected={tab === key}
            onClick={() => (location.hash = 'ai-settings?tab=' + key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'channels' && admin && (
        <section role="tabpanel" aria-label="消息接入">
          <ChannelSettings />
        </section>
      )}
      {tab === 'templates' && (
        <section role="tabpanel" aria-label="单据模板">
          <DocumentTemplateSettings />
        </section>
      )}
      <section role="tabpanel" aria-label="API 配置" hidden={tab !== 'api'}>
        {admin ? <AiSettingsPage /> : <AiUserPreferences />}
      </section>
      {tab === 'tools' && (
        <section role="tabpanel" aria-label="高级：插件与工具">
          <AssistantPlugins />
        </section>
      )}
      {prompts && (
        <section role="tabpanel" aria-label="提示词" hidden={tab !== 'prompts'}>
          <div className="adm-prompt-module">
            <label className="adm-prompt-module-pick">
              <span>用于</span>
              <select
                aria-label="提示词用于"
                value={module.id}
                onChange={(e) => setPromptKind(e.target.value)}
              >
                {promptModules.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="adm-muted" role="note">
              {module.description} {module.usage.replace(/（[^）]*接入[^）]*）$/, '')}
            </p>
          </div>
          {/* 提示词要在超级管理员模式里才能改（本机管理员一直算在模式里），别的时候只读 */}
          <PromptSettingsPage
            key={module.id}
            purpose={module.purpose}
            module={module.id}
            editable={Boolean(actor.superAdminMode)}
          />
        </section>
      )}
    </div>
  );
}
