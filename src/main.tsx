import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SlotProvider } from './ui/index';
import { slots } from './slots';
// 样式都在这里引入，顺序就是优先级。页面里不要再 import 样式：懒加载的样式会排到这里列的之后，结果取决于先打开哪一页。
// 每个模块的样式放在自己的目录，只管自己的类名（tests/css-modules.test.ts）；全站共用的在 ui/。
// 先后是按冲突排出来的：两条规则特异性相同、可能落在同一个元素上、改同一个属性时，后写的说了算，这个先后和整理前一样。
// 没有这种关系的按模块从低到高排；名字带 -2、-3 的是同一主题里要压过前面别的文件的那几条（多是精致版式的按钮、表格、详情卡片），
// 所以单独成一份排在后面。下面带“排在……之后”的就是这类，后面写的是它要压过的文件。
import './ui/tokens.css';
import './ui/buttons.css';
import './ui/forms.css';
import './ui/list-layout.css';
import './ui/elements.css';
import './recordkit/sales.css';
// 排在 ui/buttons.css、ui/forms.css、ui/list-layout.css 之后
import './recordkit/kit.css';
import './records/overview.css';
// 排在 ui/list-layout.css 之后
import './records/records.css';
// 排在 records/overview.css、records/records.css 之后
import './records/today.css';
import './editors/editors.css';
import './operations/operations.css';
// 排在 ui/elements.css、recordkit/kit.css、editors/editors.css 之后
import './flow/flow.css';
// 排在 flow/flow.css 之后
import './flow/production.css';
// 排在 recordkit/kit.css 之后
import './warehouse/warehouse.css';
import './marks/marks.css';
import './documents/paper.css';
import './documents/templates.css';
import './finance/reports.css';
// 排在 ui/forms.css 之后
import './finance/finance.css';
// 排在 finance/finance.css 之后
import './finance/books.css';
// 排在 finance/finance.css 之后
import './finance/cash.css';
import './finance/finance-forms.css';
import './import/inbox.css';
// 排在 ui/forms.css、ui/list-layout.css 之后
import './import/order-import.css';
import './import/ai-import-lines.css';
// 排在 ui/buttons.css、import/order-import.css 之后
import './import/ai-import-files.css';
// 排在 import/order-import.css 之后
import './import/ai-import.css';
import './admin/accounts.css';
import './admin/channels.css';
// 排在 ui/buttons.css 之后
import './admin/ai-settings.css';
import './admin/prompts.css';
import './admin/data-management.css';
import './admin/admin.css';
import './admin/super-mode.css';
import './assistant/spirits.css';
import './assistant/spirits-pass.css';
// 排在 assistant/spirits.css 之后
import './assistant/spirits-whisper.css';
// 排在 assistant/spirits-pass.css、assistant/spirits-whisper.css 之后
import './assistant/spirits-play.css';
// 排在 assistant/spirits-play.css 之后
import './assistant/spirits-dock.css';
import './assistant/messages.css';
import './assistant/composer.css';
import './assistant/review.css';
import './assistant/attachments.css';
import './assistant/memory.css';
// 排在 ui/forms.css、assistant/spirits.css、assistant/composer.css 之后
import './assistant/window.css';
// 排在 ui/forms.css 之后
import './palette.css';
// 排在 ui/buttons.css、ui/list-layout.css 之后
import './guide.css';
import './shell.css';
// 排在 shell.css 之后
import './settings.css';
import './cross-module.css';
// 排在 operations/operations.css、finance/reports.css、records/today.css、import/ai-import-files.css、import/ai-import.css、assistant/window.css、guide.css 之后
import './ui/buttons-2.css';
// 排在 import/ai-import-lines.css、settings.css、ui/buttons-2.css 之后
import './ui/detail.css';
// 排在 records/records.css、warehouse/warehouse.css、finance/finance.css 之后
import './ui/list-layout-2.css';
// 排在 flow/production.css、finance/books.css、admin/ai-settings.css、admin/prompts.css、admin/data-management.css、ui/detail.css、ui/list-layout-2.css 之后
import './ui/elements-2.css';
// 排在 ui/elements-2.css 之后
import './login.css';
// 排在 ui/elements-2.css 之后
import './topbar.css';
// 排在 topbar.css 之后
import './account.css';
// 排在 warehouse/warehouse.css 之后
import './recordkit/kit-2.css';
// 排在 ui/elements-2.css、recordkit/kit-2.css 之后
import './mobile/mobile.css';
// 排在 ui/detail.css 之后
import './settings-2.css';
// 排在 ui/elements-2.css 之后
import './ui/list-layout-3.css';
// 排在 documents/templates.css、ui/list-layout-3.css 之后
import './ui/menus.css';
// 排在 ui/menus.css 之后
import './assistant/plugins.css';
// 排在 ui/menus.css 之后
import './ui/detail-2.css';
// 排在 login.css、topbar.css、mobile/mobile.css、settings-2.css、ui/menus.css 之后
import './shell-2.css';
// 排在 account.css、ui/menus.css 之后
import './ui/buttons-3.css';
// 排在 shell-2.css、ui/buttons-3.css 之后
import './ui/elements-3.css';
// 排在 admin/admin.css、ui/elements-3.css 之后
import './ui/dialogs.css';
// 排在 palette.css、ui/detail-2.css、ui/dialogs.css 之后
import './ui/forms-2.css';
// 排在 ui/detail-2.css、ui/dialogs.css 之后
import './ui/menus-2.css';
// 排在 ui/dialogs.css 之后
import './records/records-2.css';
// 排在 ui/dialogs.css 之后
import './warehouse/warehouse-2.css';
// 排在 ui/dialogs.css 之后
import './recordkit/kit-3.css';
// 排在 ui/dialogs.css 之后
import './ui/list-layout-4.css';
// 排在 ui/forms-2.css、warehouse/warehouse-2.css、ui/list-layout-4.css 之后
import './ui/detail-3.css';
// 排在 ui/detail-3.css 之后
import './shell-3.css';
// 排在 ui/menus-2.css、shell-3.css 之后
import './ui/buttons-4.css';
// 排在 ui/detail-3.css 之后
import './ui/list-layout-5.css';
import { followSystemTheme, loadTheme } from './ui/index';
loadTheme();
// 页面一直开着，不用停
followSystemTheme();
const container = document.getElementById('root');
if (!container) throw new Error('页面缺少放程序的 #root（index.html）');
createRoot(container).render(
  <React.StrictMode>
    <SlotProvider value={slots}>
      <App />
    </SlotProvider>
  </React.StrictMode>,
);
