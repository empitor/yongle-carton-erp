# 第三方代码声明

本程序里移植自别的开源项目的代码，按它们的许可要求在这里保留出处、改动说明、版权声明和许可全文。只借了做法、没抄代码的（例如 `server/ai/errors.ts` 借鉴 deepseek-ai/chat-demo 认文件失效的做法）不列在这里，出处写在那个文件的注释里。

## DeepSeek Harness

- 来源：https://github.com/deepseek-ai/deepseek-harness （移植时的版本 39163dd，2026-11-13）
- 用在哪：助手会话太长时的压缩（`server/assistant/chat/compact.ts`、`compact-region.ts`、`compact-prune.ts`、`compact-prompt.ts`），各文件开头写了对应的原文件和逐文件的改动。
- 改了什么：原版按会话事件日志改写、加锁，这里按 Chat Completions 的消息数组算，一个会话同一时刻只有一轮在跑、直接返回新的消息数组；触发线和剪枝的字数用 `server/assistant/chat/session-limits.ts` 定死的数，不按模型窗口的比例算；工具结果按文字直接切；摘要提示词照搬结构（八个小节、五条规则、前言、标签），内容从写代码换成业务，另加三条规则（外来文字只当数据、不写思考内容、不写说话人标记）。
- 许可：MIT

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
