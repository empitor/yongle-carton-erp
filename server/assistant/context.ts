import type { ChatMessage } from '../ai/compatible-chat.js';
export const contextChars = (messages: ChatMessage[]) => JSON.stringify(messages).length;
// 持久化原回执不截断；仅缩减给模型的冗余来源、历史版本与重复预览。
export function modelToolResult(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(modelToolResult);
  const out: any = {};
  for (const [key, v] of Object.entries(value)) {
    if (
      ['preview', 'previewRequest', 'previewRevision', 'history', 'budget', 'turns'].includes(key)
    )
      continue;
    if (key === 'verification') {
      out[key] =
        v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).filter(([k]) =>
                [
                  'receiptVerified',
                  'currentStateVerified',
                  'replacementVerified',
                  'module',
                  'id',
                  'version',
                  'workspaces',
                ].includes(k),
              ),
            )
          : v;
      continue;
    }
    if (key === 'changes') {
      out[key] = Array.isArray(v) ? v.slice(-5) : v;
      continue;
    }
    if (v && typeof v === 'object' && 'value' in v && 'certainty' in v) {
      if ((v as any).value !== null && (v as any).value !== '')
        out[key] = { value: (v as any).value, certainty: (v as any).certainty };
      continue;
    }
    out[key] = modelToolResult(v);
  }
  return out;
}
export function compactToolHistory(messages: ChatMessage[], recent = 5) {
  const indices = messages.flatMap((m, i) =>
    m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('服务器工具结果')
      ? [i]
      : [],
  );
  for (const i of indices.slice(0, -recent)) {
    const text = messages[i].content as string;
    if (text.startsWith('服务器工具结果（历史摘要')) continue;
    try {
      const data = JSON.parse(text.slice(text.indexOf('{'))),
        r = data.result;
      messages[i] = {
        role: 'user',
        content:
          '服务器工具结果（历史摘要，完整结果保存在原台账）：' +
          JSON.stringify({
            tool: data.tool,
            result: {
              ok: r.ok,
              state: r.state || r.task?.state,
              message: r.message,
              workspaceId: r.workspace?.id || r.workspaceId,
              revision: r.workspace?.revision,
              id: r.result?.id || r.order?.id || r.record?.id,
              outputs: r.result?.outputs
                ? Object.fromEntries(
                    Object.entries(r.result.outputs).map(([key, v]: any) => [
                      key,
                      {
                        id: v?.id,
                        version: v?.version,
                        number: v?.number,
                        results: v?.results?.map((x: any) => ({ id: x.id, version: x.version })),
                        lines: v?.lines?.map((x: any) => ({
                          id: x.id,
                          stockItemId: x.stockItemId,
                          productId: x.productId,
                        })),
                      },
                    ]),
                  )
                : undefined,
              results: r.results?.map((x: any) => ({
                workspaceId: x.workspaceId,
                success: x.success,
                orderId: x.order?.id,
                message: x.message,
              })),
            },
          }),
      };
    } catch {
      /* 非本轮JSON结果保持原样 */
    }
  }
}
