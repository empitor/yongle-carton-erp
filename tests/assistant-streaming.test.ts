import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSettings, secret } from './assistant-fixture.js';
test('Chat Completions真实SSE增量与结束标记，断流和越权工具内容拒绝，敏感密钥不流入前端', async () => {
  let broken = false,
    leak = false;
  const s = makeSettings(async (r) => {
    const text = leak
      ? '敏感' + secret
      : JSON.stringify({ message: '中文流式回复', toolCalls: [] });
    for (const part of [text.slice(0, 15), text.slice(15)])
      r.onSseEvent?.({
        event: 'message',
        data: JSON.stringify({ choices: [{ delta: { content: part }, finish_reason: null }] }),
      });
    if (!broken)
      r.onSseEvent?.({
        event: 'message',
        data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      });
    r.onSseEvent?.({ event: 'message', data: '[DONE]' });
    return { status: 200, body: null, streamed: true };
  }, 'chat-completions');
  try {
    const chunks: string[] = [],
      result: any = await s.completeOrderJson(
        [{ role: 'user', content: '虚构测试' }],
        s.view().active!,
        undefined,
        { stream: true, onTextDelta: (d) => chunks.push(d) },
      );
    assert.equal(result.message, '中文流式回复');
    assert.match(chunks.join(''), /中文流式回复/);
    broken = true;
    await assert.rejects(
      () => s.completeOrderJson([], s.view().active!, undefined, { stream: true }),
      /中断/,
    );
    broken = false;
    leak = true;
    const leaked: string[] = [];
    await assert.rejects(() =>
      s.completeOrderJson([], s.view().active!, undefined, {
        stream: true,
        onTextDelta: (d) => leaked.push(d),
      }),
    );
    assert(!leaked.join('').includes(secret));
  } finally {
    s.close();
  }
});
