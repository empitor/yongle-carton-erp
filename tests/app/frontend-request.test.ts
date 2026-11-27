// 前端请求：读响应、出错说中文、401 回登录、页面凭证、上传、断网。不开浏览器、不连真实服务：fetch 和 window 换成替身。
// 另扫 src/：只有 src/ui 的请求入口直接调 fetch，上传只走 uploadFile。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  authorizedRequest,
  isNetworkError,
  networkUnavailable,
  readAuthState,
  request,
  responseData,
  serviceUnavailable,
  tokenRequest,
  uploadFile,
} from '../../src/ui/http.js';
import { readJson } from '../../src/ui/read-body.js';
import { userError } from '../../shared/core/user-errors.js';
import { json, signedIn, stubBrowser } from '../support/browser-fixture.js';

const text = (status: number, body: string, type = 'text/plain') =>
  new Response(body, { status, headers: { 'Content-Type': type } });

const gatewayPage = () => text(502, '<html><body>502 Bad Gateway</body></html>', 'text/html');

/** 替身记下的请求头：请求入口发的都是普通对象（键区分大小写，没发的头读出来是 undefined）；没带请求头是 undefined */
const headersOf = (init?: RequestInit) => z.record(z.string(), z.string()).optional().parse(init?.headers);
/** 请求入口抛出的错误里要看的几项 */
const thrown = z.object({ name: z.string(), message: z.string(), code: z.unknown() });

test('读响应：网关错误页、空响应、纯文字都返回 null，不抛 JSON 语法错误', async () => {
  assert.equal(await readJson(gatewayPage()), null);
  assert.equal(await readJson(new Response('', { status: 502 })), null);
  assert.equal(await readJson(text(403, 'Forbidden')), null);
  assert.deepEqual(await readJson(json(200, { ok: true })), { ok: true });
});

test('读不出 JSON：服务端错误和空的成功响应说服务暂时不可用，其他错误用兜底说明', async () => {
  const browser = stubBrowser();
  try {
    await assert.rejects(responseData(gatewayPage()), { message: serviceUnavailable });
    await assert.rejects(responseData(new Response('', { status: 503 })), {
      message: serviceUnavailable,
    });
    await assert.rejects(responseData(new Response('', { status: 200 })), {
      message: serviceUnavailable,
    });
    await assert.rejects(responseData(text(403, 'Forbidden'), '操作失败，请刷新后重试。'), {
      message: '操作失败，请刷新后重试。',
    });
    assert.deepEqual(browser.events, [], '非 401 不应让页面重新读登录状态');
  } finally {
    browser.restore();
  }
});

test('接口正常返回 null（如还没设置过账期）时照常返回 null，不当成服务异常', async () => {
  assert.equal(await responseData(json(200, null)), null);
  assert.equal(await readJson(json(200, null)), null);
  assert.deepEqual(await responseData(json(200, [])), []);
  assert.equal(await responseData(json(200, 0)), 0);
});

test('只有 401 通知回到登录；400、403、409 只给中文说明，并带回状态和原始返回', async () => {
  const browser = stubBrowser();
  try {
    for (const status of [400, 403, 409])
      await assert.rejects(responseData(json(status, { message: 'quantity 不能为空' })), {
        message: '数量 不能为空',
        status,
      });
    assert.deepEqual(browser.events, []);
    const candidates = [{ key: 'p1-0', candidates: [{ id: 7, name: '虚构纸箱', archived: true }] }];
    const duplicate = z.object({
      status: z.number(),
      code: z.string(),
      data: z.object({ candidates: z.array(z.object({ key: z.string() })) }),
    });
    await assert.rejects(
      responseData(json(409, { message: '已有同名产品', code: 'duplicate-product', candidates })),
      (e: unknown) => {
        const d = duplicate.parse(e);
        return d.status === 409 && d.code === 'duplicate-product' && d.data.candidates[0]?.key === 'p1-0';
      },
    );
    await assert.rejects(
      responseData(json(401, { message: '请先登录账号。', code: 'authentication' })),
      { message: '请先登录账号。', status: 401, code: 'authentication' },
    );
    assert.deepEqual(browser.events, ['auth']);
  } finally {
    browser.restore();
  }
});

test('带凭证的请求（authorizedRequest，call() 经它发）先看状态再读数据；业务错误不刷新登录状态，网关错误不报语法错误', async () => {
  let reply: () => Response = () => json(409, { message: '记录已修改，请刷新。' });
  const browser = stubBrowser((url) => (url === '/api/auth/state' ? signedIn() : reply()));
  try {
    await assert.rejects(authorizedRequest('/orders/1', { name: '虚构' }, 'PUT'), {
      message: '记录已修改，请刷新。',
    });
    const sent = browser.calls[1];
    assert.equal(sent.url, '/api/orders/1');
    assert.equal(sent.init?.method, 'PUT');
    assert.equal(headersOf(sent.init)?.['X-ERP-Auth-Token'], 'csrf-test');
    assert.deepEqual(browser.events, []);
    // 退出登录的 403 是纯文字 Forbidden。
    reply = () => text(403, 'Forbidden');
    await assert.rejects(authorizedRequest('/auth/logout', {}, 'POST'), {
      message: '操作失败，请刷新后重试。',
    });
    reply = gatewayPage;
    await assert.rejects(authorizedRequest('/orders', undefined, 'GET'), { message: serviceUnavailable });
    reply = () => json(200, [{ id: 1 }]);
    assert.deepEqual(await authorizedRequest('/orders', undefined, 'GET'), [{ id: 1 }]);
    reply = () => json(401, { message: '请先登录账号。' });
    await assert.rejects(authorizedRequest('/orders', undefined, 'GET'), { status: 401 });
    assert.deepEqual(browser.events, ['auth']);
  } finally {
    browser.restore();
  }
  const down = stubBrowser(() => gatewayPage());
  try {
    await assert.rejects(authorizedRequest('/orders', undefined, 'GET'), { message: serviceUnavailable });
    assert.equal(down.calls.length, 1, '读不到登录状态就不再发业务请求');
  } finally {
    down.restore();
  }
});

test('网络断开、响应丢了：请求入口统一说中文，不露浏览器的英文原文；主动停止、超时原样交给调用方', async () => {
  // 浏览器在网断、响应被掐断时让 fetch 抛 TypeError（Chrome 是“Failed to fetch”）
  const lost = () => {
    throw new TypeError('Failed to fetch');
  };
  let reply: () => Response = lost;
  const browser = stubBrowser((url) => (url === '/api/auth/state' ? signedIn() : reply()));
  try {
    const check = async (job: Promise<unknown>) => {
      const e: unknown = await job.then(
        () => assert.fail('应当失败'),
        (err: unknown) => err,
      );
      const { message, code } = thrown.parse(e);
      assert.equal(message, networkUnavailable);
      assert.equal(code, 'network');
      assert.ok(isNetworkError(e));
      assert.ok(e instanceof TypeError, '仍是 TypeError，按类型判断网络错误的地方不受影响');
      assert.doesNotMatch(message, /[A-Za-z]/);
    };
    await check(authorizedRequest('/assistant/previews/p1/inventory-policy', { inventoryPolicy: 'preserve' }, 'POST'));
    await check(authorizedRequest('/customers', { name: '虚构客户' }, 'POST'));
    await check(authorizedRequest('/products', undefined, 'GET'));
    await check(uploadFile('/api/inbox/upload?name=a.pdf', new Blob(['虚构']), { token: 't' }));
    await check(request('/api/assistant/threads/1/chat', { method: 'POST' }));
    await check(tokenRequest('/api/ai/imports/w1', 'ai-token', { action: 'match' }));
    assert.deepEqual(browser.events, [], '网断不是退出登录');
    // 连登录状态都读不到（整个网断了）也一样
    const down = stubBrowser(lost);
    try {
      await check(authorizedRequest('/orders', undefined, 'GET'));
      await check(readAuthState());
    } finally {
      down.restore();
    }
    // 主动停止、超时：原样抛出，调用方各自说（“已停止回复”“上传已中断”）
    for (const name of ['AbortError', 'TimeoutError']) {
      reply = () => {
        throw new DOMException('aborted', name);
      };
      const e: unknown = await request('/api/x').catch((err: unknown) => err);
      assert.equal(thrown.parse(e).name, name);
      assert.equal(isNetworkError(e), false);
    }
    // 服务器回了错误时照旧用服务器的话
    reply = () => json(409, { message: '方案已按新的库存处理方式重新核算，请看过再确认。' });
    await assert.rejects(authorizedRequest('/assistant/previews/p1/execute', {}, 'POST'), {
      message: '方案已按新的库存处理方式重新核算，请看过再确认。',
    });
  } finally {
    browser.restore();
  }
});

/**
 * src/ui 里可以直接调浏览器 fetch 的文件（请求入口），别处一律经它们发请求，网断才都说中文、401 才都回登录。
 * 名单只列真调 fetch 的；多了少了下面那条测试都会报。
 */
const fetchEntries: Record<string, string> = {
  'src/ui/http.ts': 'request：所有请求（call() 经的 authorizedRequest、tokenRequest、uploadFile）都经它发',
  'src/ui/auth-state.ts':
    'useAuthState 轮询登录状态：http.ts 引用 auth-state.ts，反过来用 request 会循环；轮询失败本来就不报也不提示',
  'src/ui/problem-report.ts':
    '把页面问题报给服务端：http.ts 失败时调它上报，它自己再经 request 发，报失败又会再报',
};

test('只有 src/ui 的请求入口直接调浏览器的 fetch，别处都经入口发请求', () => {
  const callers = sourceFiles('src').filter((file) =>
    /\bfetch\s*\(|\b(?:globalThis|window|self)\.fetch\b/.test(readFileSync(file, 'utf8')),
  );
  const entries = Object.keys(fetchEntries);
  assert.deepEqual(callers.filter((f) => !entries.includes(f)).map((f) => f + '：直接调了 fetch，改经 src/ui 的 request（或 call()、uploadFile）发'), []);
  assert.deepEqual(entries.filter((f) => !callers.includes(f)).map((f) => f + '：已经不直接调 fetch 了，从 fetchEntries 删掉'), []);
});

const uploadAddress = /['"`][^'"`]*\/upload\b/;
/** 一个文件里上传的写法不对的地方：自己拼文件正文发请求；写了上传地址（含接口表的键 'POST /inbox/upload'）却不调 uploadFile */
function uploadProblems(file: string, text: string): string[] {
  return [
    ...(/application\/octet-stream|\bFormData\b|XMLHttpRequest/.test(text) ? [file + '：自己拼文件正文发请求，改用 src/ui 的 uploadFile 发'] : []),
    ...(uploadAddress.test(text) && !/\buploadFile\b/.test(text) ? [file + '：发往上传地址却没调 uploadFile，改用 src/ui 的 uploadFile 发'] : []),
  ];
}

// 不写死文件名单：请求收进各模块的接口文件以后名单会变，所以扫 src 全部文件。
test('上传只走 src/ui 的 uploadFile：别处不自己拼文件正文发请求，发往上传地址的文件都调 uploadFile', () => {
  const files = sourceFiles('src')
    .filter((file) => file !== 'src/ui/http.ts')
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  const uploaders = files.filter((f) => uploadAddress.test(f.text));
  assert.ok(uploaders.length >= 4, '应当找得到发上传请求的文件：' + uploaders.map((f) => f.file).join('、'));
  assert.deepEqual(files.flatMap((f) => uploadProblems(f.file, f.text)), []);
});

test('上传检查认得接口表的写法：用 call() 发上传地址（正文是 JSON，不是原文件）一样拦下', () => {
  const sample = `import { call } from '../ui/index';
const inbox = call<InboxApi>();
export const upload = (body: { name: string }) => inbox('POST /inbox/upload', { body });`;
  assert.deepEqual(uploadProblems('src/inbox/__upload_probe__.ts', sample), [
    'src/inbox/__upload_probe__.ts：发往上传地址却没调 uploadFile，改用 src/ui 的 uploadFile 发',
  ]);
});

test('上传共用一个入口：带页面凭证，失败说明可读，401 回到登录', async () => {
  let reply: () => Response = () =>
    text(413, '<html>413 Request Entity Too Large</html>', 'text/html');
  const browser = stubBrowser((url) => (url === '/api/auth/state' ? signedIn() : reply()));
  try {
    const file = new Blob(['虚构内容']);
    await assert.rejects(
      uploadFile('/api/inbox/upload?name=a.pdf', file, { failure: 'a.pdf 上传失败' }),
      { message: 'a.pdf 上传失败' },
    );
    const sent = browser.calls[1];
    assert.equal(sent.init?.method, 'POST');
    assert.equal(sent.init?.body, file);
    assert.equal(headersOf(sent.init)?.['X-ERP-Auth-Token'], 'csrf-test');
    assert.equal(headersOf(sent.init)?.['Content-Type'], 'application/octet-stream');
    // AI 导入工作区用自己的凭证头；给了凭证就不再读登录状态。
    reply = () => json(200, { workspace: { id: 'w1' } });
    browser.calls.length = 0;
    const result = await uploadFile('/api/ai/imports/upload', file, {
      token: 'ai-token',
      tokenHeader: 'X-ERP-AI-Token',
      contentType: 'image/png',
      headers: { 'X-File-Name': 'a.png' },
    });
    assert.deepEqual(result, { workspace: { id: 'w1' } });
    assert.equal(browser.calls.length, 1);
    const headers = headersOf(browser.calls[0].init);
    assert.ok(headers, '带了请求头');
    assert.equal(headers['X-ERP-AI-Token'], 'ai-token');
    assert.equal(headers['X-ERP-Auth-Token'], undefined);
    assert.equal(headers['Content-Type'], 'image/png');
    assert.equal(headers['X-File-Name'], 'a.png');
    reply = gatewayPage;
    await assert.rejects(uploadFile('/api/flow/sources/upload', file, { token: 't' }), {
      message: serviceUnavailable,
    });
    assert.deepEqual(browser.events, []);
    reply = () => json(401, { message: '请先登录账号。' });
    await assert.rejects(uploadFile('/api/inbox/upload?name=a.pdf', file, { token: 't' }), {
      message: '请先登录账号。',
    });
    assert.deepEqual(browser.events, ['auth']);
  } finally {
    browser.restore();
  }
});

test('写入沿用记下的页面凭证，不每次先读登录状态；服务重启换了凭证被拒时重读一次再发', async () => {
  let csrf = 'csrf-old';
  const browser = stubBrowser((url, init) => {
    if (url === '/api/auth/state') return json(200, { configured: true, actor: { id: 'u1', name: '虚构用户', permissions: ['business:edit'] }, csrf });
    return headersOf(init)?.['X-ERP-Auth-Token'] === csrf ? json(200, { ok: true }) : json(403, { message: '页面凭证已过期，请刷新。' });
  });
  try {
    assert.deepEqual(await authorizedRequest('/customers', { name: '虚构客户' }, 'POST'), { ok: true });
    assert.deepEqual(await authorizedRequest('/orders/1', { name: '虚构' }, 'PUT'), { ok: true });
    assert.deepEqual(browser.calls.map((c) => c.url), ['/api/auth/state', '/api/customers', '/api/orders/1'], '第二次写入不再先读登录状态');
    // 服务重启：凭证换了，旧凭证被拒，重读一次登录状态后用新凭证重发
    csrf = 'csrf-new';
    browser.calls.length = 0;
    assert.deepEqual(await authorizedRequest('/products', { name: '虚构纸箱' }, 'POST'), { ok: true });
    assert.deepEqual(
      browser.calls.map((c) => [c.url, headersOf(c.init)?.['X-ERP-Auth-Token']]),
      [['/api/products', 'csrf-old'], ['/api/auth/state', undefined], ['/api/products', 'csrf-new']],
    );
    // 凭证没换的 403（真没有权限）不重发，照原样报
    browser.calls.length = 0;
    const denied = stubBrowser((url) =>
      url === '/api/auth/state' ? signedIn() : json(403, { message: '当前账号没有执行此操作的权限。' }),
    );
    try {
      await assert.rejects(authorizedRequest('/orders/1', { name: '虚构' }, 'PUT'), { message: '当前账号没有执行此操作的权限。', status: 403 });
      assert.deepEqual(denied.calls.map((c) => c.url), ['/api/auth/state', '/api/orders/1', '/api/auth/state']);
    } finally {
      denied.restore();
    }
  } finally {
    browser.restore();
  }
});



test('面向员工的错误提示包含明细序号与中文字段，保留业务原始错误', () => {
  assert.equal(userError('lines.1.quantity: 数量使用非负数字'), '明细第2项的数量：数量使用非负数字');
  // 全站一个写法：中文冒号，有自己叫法的不带上一层（预估成本里的加工成本），没有中文名的数组只说第几项；处理两遍结果一样
  assert.equal(userError('costs.processing: 请填写有效金额；items.0.quantity: 请填写数量。'), '加工成本：请填写有效金额；第1项的数量：请填写数量');
  assert.equal(userError(userError('customerId: 请选择客户')), '客户：请选择客户');
  assert.match(
    userError('customerId: Invalid input: expected number, received undefined'),
    /客户：请填写有效数值/,
  );
  assert.equal(
    userError('纸板A库存不足：现有1000张，本次需扣减5000张。'),
    '纸板A库存不足：现有1000张，本次需扣减5000张。',
  );
});

test('报错路径或文字里是 toString、constructor 这类对象自带的名字时照原样写，不换成函数源码', () => {
  for (const word of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    assert.equal(userError(word + ': 请填写'), word + '：请填写', '路径 ' + word);
    assert.equal(userError('costs.' + word + ': 请填写'), '预估成本的' + word + '：请填写', '预估成本下的 ' + word);
    assert.equal(userError('产品“' + word + '”已存在'), '产品“' + word + '”已存在', '文字里的 ' + word);
  }
  assert.equal(userError('__proto__: 请填写'), '__proto__：请填写');
});


test('前端直接读接口的地方不再自己 .json()：网关错误页不报英文语法错误，401 回登录页', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = dir + '/' + e.name;
      if (e.isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx)$/.test(e.name)) files.push(path);
    }
  };
  walk('src');
  assert.ok(files.length > 50);
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /\.json\(\)/, file);
});


/** dir 下所有 .ts、.tsx 文件（相对路径，用 / 分隔） */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(dir + '/' + e.name) : /\.tsx?$/.test(e.name) ? [dir + '/' + e.name] : [],
  );
}
