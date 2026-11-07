import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// 样式都在这里引入，顺序就是优先级，design.css 必须最后。页面里不要再 import 样式：
// 懒加载的页面样式会排到 design.css 之后，结果取决于用户先打开哪个页面。
import './developer.css';
import './overview.css';
import './styles.css';
import './ui/list-layout.css';
import './fulfillment.css';
import './business-export.css';
import './yl-spirits.css';
import './physical-flow.css';
import './date-schedule.css';
import './operations.css';
import './arrival-warehouse.css';
import './finance/finance.css';
import './global-assistant.css';
import './assistant-attachments.css';
import './assistant-plugins.css';
import './ai-settings.css';
import './prompt-settings.css';
import './order-import.css';
import './design.css';
import { loadTheme } from './theme';
loadTheme();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
