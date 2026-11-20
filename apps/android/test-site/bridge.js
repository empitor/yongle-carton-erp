// 测试页代替 ERP 回答外壳的通道（虚构，只给测试版用）：校验和 ERP 一样（App 标记、顶层窗口、没有来源窗口、一个端口、
// 接通消息一字不差）；返回键在第二页回首页（handled），在首页回 home。分享消息不理。
window.addEventListener('message', (event) => {
  const app = / YongleErpAndroid\/[\w.-]+$/.test(navigator.userAgent);
  const hello = event.data === '{"type":"erp-app-bridge","version":1}';
  if (!app || window.top !== window || event.source !== null || event.ports.length !== 1 || !hello) return;
  const port = event.ports[0];
  port.onmessage = (e) => {
    const message = JSON.parse(e.data);
    if (message.type !== 'back') return;
    const home = !location.pathname.endsWith('page2.html');
    if (!home) location.href = 'index.html';
    port.postMessage(JSON.stringify({ type: 'back-result', id: message.id, result: home ? 'home' : 'handled' }));
  };
  port.postMessage(JSON.stringify({ type: 'bridge-ready' }));
});
