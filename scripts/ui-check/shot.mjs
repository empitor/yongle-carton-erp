// 给预览实例截图：先用 preview.mjs 起实例，再用无头 Chrome 登录、打开页面、截图，
// 打印截图路径、页面上的报错和控制台错误。
// 用法：
//   node scripts/ui-check/shot.mjs "#warehouse?kind=finished" "#orders" [--remote] [--user 虚构业务员]
//                                  [--mobile] [--full] [--port 端口] [--out 目录]
// 要点按钮、填表的多步检查，自己写脚本用 lib.mjs 的 openChrome、login、go。
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && !!args.splice(i, 1);
};
const remote = flag('--remote'),
  mobile = flag('--mobile'),
  full = flag('--full');
const user = option('--user') || '虚构管理员';
const port = option('--port') || (remote ? '3198' : '3199');
const out = option('--out') || mkdtempSync(join(tmpdir(), 'erp-shot-'));
const hashes = args.length ? args : ['#'];
process.env.UI_CHECK_PORT = port;
const { openChrome, login, BASE } = await import('./lib.mjs');
if (!(await fetch(BASE + 'api/auth/state').then(() => true, () => false)))
  throw new Error(`端口 ${port} 上没有预览实例，先运行 node scripts/ui-check/preview.mjs${remote ? ' --remote' : ''}`);
mkdirSync(out, { recursive: true });
const { context, page, consoleErrors } = await openChrome(
  mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {},
);
try {
  await login(page, user);
  for (const [n, hash] of hashes.entries()) {
    await page.goto(BASE + (hash.startsWith('#') ? hash : '#' + hash));
    await page.waitForTimeout(1500);
    const file = join(out, `${n + 1}-${hash.replace(/[^\w一-龥]+/g, '_').replace(/^_|_$/g, '') || 'home'}.png`);
    await page.screenshot({ path: file, fullPage: full });
    const errors = await page.locator('.error,[role=alert]').allInnerTexts();
    console.log(file + (errors.length ? '\n  页面报错：' + errors.join(' | ').slice(0, 300) : ''));
  }
} finally {
  await context.close();
}
if (consoleErrors.length) console.log('控制台错误：\n  ' + consoleErrors.join('\n  '));
