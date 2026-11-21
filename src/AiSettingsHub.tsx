import { aiSettingsTab, everyoneSettingsTab } from '../shared/assistant/index';
import { useEffect, useState } from 'react';
import { AiSettingsPage, ChannelSettings, PromptSettingsPage } from './admin/index';
import type { AuthState } from './ui/index';
import { promptModules } from '../shared/ai/index';
import { AssistantPlugins } from './assistant/index';
import { DocumentTemplateSettings } from './documents/index';
import { settingsTabsOf } from './app-shell';

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
  const admin = actor.role === 'super_admin',
    tabs = settingsTabsOf(actor);
  // 除了单据模板都只给超级管理员账号：别人从链接点进来也落到单据模板，不发越权请求、不留白屏。
  // 一个页签都没有的账号（只读）侧栏没有设置，从链接进来只说一句。
  if (!tabs.length) return <p className="adm-muted" role="note">当前账号没有可改的设置。</p>;
  const tab = admin ? hashTab : everyoneSettingsTab;
  const module = promptModules.find((item) => item.id === promptKind) ?? promptModules[0];
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
      {tab === 'channels' && (
        <section role="tabpanel" aria-label="消息接入">
          <ChannelSettings />
        </section>
      )}
      {tab === 'templates' && (
        <section role="tabpanel" aria-label="单据模板">
          <DocumentTemplateSettings />
        </section>
      )}
      {admin && (
        <section role="tabpanel" aria-label="API 配置" hidden={tab !== 'api'}>
          <AiSettingsPage />
        </section>
      )}
      {tab === 'tools' && (
        <section role="tabpanel" aria-label="高级：插件与工具">
          <AssistantPlugins />
        </section>
      )}
      {admin && (
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
          {/* 提示词要在超级管理员模式里才能改（本机管理员一直算在模式里），没进时只读 */}
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
