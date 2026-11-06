import { aiSettingsTab } from '../shared/assistant-navigation';
import './assistant-plugins.css';
import { useEffect, useState } from 'react';
import AiSettingsPage from './AiSettingsPage';
import { useAuthState } from './session';
import { AccountManagement } from './AccountManagement';
import PromptSettingsPage from './PromptSettingsPage';
import { promptModules } from '../shared/prompt-modules';
import AssistantPlugins from './AssistantPlugins';
import DocumentTemplateSettings from './DocumentTemplateSettings';
import ChannelSettings from './ChannelSettings';
export default function AiSettingsHub() {
  const auth = useAuthState();
  const read = () =>
    location.hash.includes('tab=accounts')
      ? 'accounts'
      : location.hash.includes('tab=channels')
        ? 'channels'
        : aiSettingsTab(location.hash);
  const [tab, setTab] = useState(read);
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
  const module = promptModules.find((item) => item.id === promptKind) ?? promptModules[0];
  return (
    <div>
      <nav className="ai-settings-tabs" aria-label="设置分类" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'api'}
          onClick={() => (location.hash = 'ai-settings?tab=api')}
        >
          API 配置
        </button>
        <button
          role="tab"
          aria-selected={tab === 'prompts'}
          onClick={() => (location.hash = 'ai-settings?tab=prompts')}
        >
          提示词
        </button>
        <button
          role="tab"
          aria-selected={tab === 'tools'}
          onClick={() => (location.hash = 'ai-settings?tab=tools')}
        >
          插件与工具
        </button>
        <button
          role="tab"
          aria-selected={tab === 'templates'}
          onClick={() => (location.hash = 'ai-settings?tab=templates')}
        >
          单据模板
        </button>
        {auth?.actor?.role === 'super_admin' && (
          <button
            role="tab"
            aria-selected={tab === 'channels'}
            onClick={() => (location.hash = 'ai-settings?tab=channels')}
          >
            消息接入
          </button>
        )}
        {auth?.actor?.role === 'super_admin' && (
          <button
            role="tab"
            aria-selected={tab === 'accounts'}
            onClick={() => (location.hash = 'ai-settings?tab=accounts')}
          >
            账号
          </button>
        )}
      </nav>
      {tab === 'channels' && auth?.actor?.role === 'super_admin' && (
        <section role="tabpanel" aria-label="消息接入">
          <ChannelSettings />
        </section>
      )}
      {tab === 'accounts' && auth?.actor?.role === 'super_admin' && (
        <section role="tabpanel" aria-label="账号">
          <AccountManagement selfId={auth.actor.id} />
        </section>
      )}
      {tab === 'templates' && (
        <section role="tabpanel" aria-label="单据模板">
          <DocumentTemplateSettings />
        </section>
      )}
      <section role="tabpanel" aria-label="API配置" hidden={tab !== 'api'}>
        <AiSettingsPage />
      </section>
      {tab === 'tools' && (
        <section role="tabpanel" aria-label="AI插件与工具管理">
          <AssistantPlugins />
        </section>
      )}
      <section role="tabpanel" aria-label="AI提示词" hidden={tab !== 'prompts'}>
        <div className="record-view-tabs">
          {promptModules.map((item) => (
            <button
              key={item.id}
              className={module.id === item.id ? 'selected' : ''}
              onClick={() => setPromptKind(item.id)}
              title={item.description}
            >
              {item.name}
            </button>
          ))}
        </div>
        <p className="help-text" role="note">
          {module.description}
          {' · '}
          {module.usage}
          {module.status === 'planned'
            ? '（识别服务尚未接入，当前仅维护提示词）'
            : module.status === 'generation'
              ? '（可辅助拟定单据文字；正式导出由单据模板和真实业务数据生成）'
              : ''}
        </p>
        {module.status === 'generation' && (
          <p className="help-text">
            <a href="#ai-settings?tab=templates">前往单据模板设置</a>
            ，调整我方名称、标题、样式和默认格式。
          </p>
        )}
        <PromptSettingsPage key={module.id} purpose={module.purpose} baseUrl={module.apiPath} />
      </section>
    </div>
  );
}
