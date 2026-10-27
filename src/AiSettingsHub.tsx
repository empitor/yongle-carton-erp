import { useEffect, useState } from 'react';
import AiSettingsPage from './AiSettingsPage';
import PromptSettingsPage from './PromptSettingsPage';
import { promptModules } from '../shared/prompt-modules';
import AssistantCapabilities from './AssistantCapabilities';
export default function AiSettingsHub() {
  const read = () =>
    location.hash.includes('tab=tools')
      ? 'tools'
      : location.hash.includes('tab=prompts') || location.hash === '#ai-prompts'
        ? 'prompts'
        : 'api';
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
      <nav className="ai-settings-tabs" aria-label="AI设置分类" role="tablist">
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
          AI 提示词
        </button>
        <button
          role="tab"
          aria-selected={tab === 'tools'}
          onClick={() => (location.hash = 'ai-settings?tab=tools')}
        >
          AI 工具管理
        </button>
      </nav>
      <section role="tabpanel" aria-label="API配置" hidden={tab !== 'api'}>
        <AiSettingsPage />
      </section>
      {tab === 'tools' && (
        <section role="tabpanel" aria-label="AI工具管理">
          <AssistantCapabilities />
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
        <p style={{ margin: '8px 0 10px', fontSize: 12, color: 'var(--muted)' }} role="note">
          {module.description}
          {' · '}
          {module.usage}
          {module.status === 'planned'
            ? '（识别服务尚未接入，当前仅维护提示词）'
            : module.status === 'generation'
              ? '（供全局助手生成我方单据，不用于识别外部单据）'
              : ''}
        </p>
        <PromptSettingsPage key={module.id} purpose={module.purpose} baseUrl={module.apiPath} />
      </section>
    </div>
  );
}
