// 语音输入在真实 Chrome 里录音（AudioWorklet，src/assistant/capture-graph.ts、capture-worklet.js）：
// 用 Chrome 的假麦克风（--use-fake-device-for-media-stream，放一段提示音）、自动同意麦克风权限，
// 点麦克风录 3 秒 → 停止 → 录到的声音交给识别（隔离实例的识别是替身，回“虚构语音内容”）→ 文字填进输入框、麦克风释放；
// 中间录一次点“取消录音”（不发识别、麦克风释放），再录第二次。
// 真麦克风对着说话验证不了，只能人工试。虚构数据。
import { checkConsole, fail, login, ok, openAssistant, openChrome } from './lib.mjs';

/** 录这么久再停（真实时间：浏览器里的音频线程要真的跑起来） */
const RECORD_MS = 3000;
/** 16kHz、16 位单声道每秒多少字节；录 3 秒交上去的声音至少要有 2 秒的量 */
const BYTES_PER_SECOND = 16000 * 2;
const MIN_SECONDS = 2;
const RECOGNIZED = '虚构语音内容';
/** 16 位样本里算“有声音”的最小峰值 */
const AUDIBLE_PEAK = 1000;

const { context, page, consoleErrors } = await openChrome({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  permissions: ['microphone'],
});
// 记下页面拿到的每一路麦克风（停下以后看音轨是不是都结束了，即麦克风释放），和交给识别的声音有多少字节
// （声音是 Blob 正文，抓包看不到大小，在页面里记）
await context.addInitScript(() => {
  const media = navigator.mediaDevices;
  const original = media.getUserMedia.bind(media);
  window.__speechStreams = [];
  window.__speechBytes = [];
  window.__speechPeaks = [];
  media.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    window.__speechStreams.push(stream);
    return stream;
  };
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const body = init?.body;
    if (String(input).endsWith('/api/assistant/transcribe') && body instanceof Blob) {
      // 交上去的是 16 位小端 PCM：记下大小和最响的一个样本（假麦克风放的是提示音，不该是一片静音）
      window.__speechBytes.push(body.size);
      void body.arrayBuffer().then((b) => window.__speechPeaks.push(new Int16Array(b).reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    }
    return send(input, init);
  };
});
const uploads = [];
page.on('request', (r) => {
  if (r.url().endsWith('/api/assistant/transcribe') && r.method() === 'POST') uploads.push(r);
});

await login(page);
const box = await openAssistant(page);
const panel = page.locator('.ga-panel');
// 换会话（含打开时载入最近一段）会取消正在录的音：先开新会话、等会话载入完再录（同组前面的流程留下了会话）
const fresh = panel.getByRole('button', { name: '新会话' });
if (await fresh.isEnabled()) await fresh.click();
await page.waitForLoadState('networkidle');

/** 录一次：开始 → 录着 → 停止并识别 → 文字填进输入框 */
async function recordOnce(round) {
  const before = uploads.length;
  await panel.getByRole('button', { name: '语音输入' }).click();
  await panel.getByRole('button', { name: '停止录音并识别' }).waitFor();
  await page.waitForTimeout(RECORD_MS);
  const live = await page.evaluate(() => window.__speechStreams.at(-1)?.getTracks().map((t) => t.readyState));
  if (!live?.length || live.some((s) => s !== 'live')) fail(`第 ${round} 次录音中麦克风不是开着的：${JSON.stringify(live)}`);
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/assistant/transcribe'));
  await panel.getByRole('button', { name: '停止录音并识别' }).click();
  const response = await answered;
  if (!response.ok()) fail(`第 ${round} 次识别请求失败：${response.status()}`);
  if (uploads.length !== before + 1) fail(`第 ${round} 次应发一次识别请求，发了 ${uploads.length - before} 次`);
  const sent = await page.evaluate(() => window.__speechBytes.at(-1) ?? 0);
  if (sent < BYTES_PER_SECOND * MIN_SECONDS) fail(`第 ${round} 次交上去的声音太少：${sent} 字节`);
  const peak = await page.evaluate(() => window.__speechPeaks.at(-1) ?? 0);
  if (peak < AUDIBLE_PEAK) fail(`第 ${round} 次交上去的是静音（峰值 ${peak}）`);
  await panel.getByRole('button', { name: '语音输入' }).waitFor();
  const ended = await page.evaluate(() => window.__speechStreams.at(-1)?.getTracks().map((t) => t.readyState));
  if (!ended?.length || ended.some((s) => s !== 'ended')) fail(`第 ${round} 次停止后麦克风没有释放：${JSON.stringify(ended)}`);
  ok(`第 ${round} 次录音：交上去 ${sent} 字节、峰值 ${peak}，识别请求 ${response.status()}，麦克风已释放`);
}

/** 录着点“取消录音”：不发识别请求，麦克风释放 */
async function cancelOnce() {
  const before = uploads.length;
  await panel.getByRole('button', { name: '语音输入' }).click();
  await panel.getByRole('button', { name: '停止录音并识别' }).waitFor();
  await panel.getByRole('button', { name: '取消录音' }).click();
  await panel.getByRole('button', { name: '语音输入' }).waitFor();
  const ended = await page.evaluate(() => window.__speechStreams.at(-1)?.getTracks().map((t) => t.readyState));
  if (!ended?.length || ended.some((t) => t !== 'ended')) fail('取消录音后麦克风没有释放：' + JSON.stringify(ended));
  if (uploads.length !== before) fail('取消录音还发了识别请求');
  else ok('取消录音：没发识别请求，麦克风已释放');
}

await recordOnce(1);
await cancelOnce();
await recordOnce(2);
const text = await box.inputValue();
if (text.split(RECOGNIZED).length - 1 !== 2) fail('两次识别的文字没有都填进输入框：' + text);
else ok('两次识别的文字都填进了输入框');
checkConsole(consoleErrors);
await context.close();
