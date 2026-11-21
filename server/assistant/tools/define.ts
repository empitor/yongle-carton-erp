// 只管：工具定义的写法——名字、说明、参数结构和执行函数写在一处。参数只在 check 里按这份结构校验一次（注册表分派时、
// 外壳 tools.ts 直接调时都走它），执行函数拿到的是校验过的参数、类型由结构推出（z.output），函数里不再校验、不再写第二份结构。
import type { z } from 'zod';
import type { Actor } from '../../core/index.js';
import type { ToolPlan } from '../plan-rules.js';
import type { ReadExtra, ToolContext } from './context.js';

type Who = Actor | null | undefined;
/** 校验过的一次调用：args 是校验后的参数；read、build 是这条工具在 tools/ 下的执行函数，已经绑好了参数（定义里写了才有） */
export type CheckedCall = {
  args: unknown;
  read?: (ctx: ToolContext, who: Who, extra?: ReadExtra) => unknown;
  build?: (ctx: ToolContext, actor: Actor, binding: string) => ToolPlan;
};
/** 写工具确认后执行（commit）、方案绑定的数据版本（stamp，没有就走外壳的 card-stamp.ts）：拿的是存下来的方案，不是模型传的参数 */
type Commit = (ctx: ToolContext, plan: ToolPlan, actor: Actor, binding: string) => unknown;
type Stamp = (ctx: ToolContext, plan: ToolPlan, actor: Actor) => unknown;
/** 工具目录里的一条（tool-catalog.ts 按顺序拼起来，注册表、外壳、命令目录都读它） */
export type ToolDefinition = {
  name: string;
  description: string;
  risk: string;
  schema: z.ZodType;
  check(raw: unknown): CheckedCall;
  commit?: Commit;
  stamp?: Stamp;
};
type Info<S extends z.ZodType> = { name: string; description: string; schema: S };

/** 执行不在 tools/ 下的工具（流程类、外加工具、财务、页面、提示词）：只按结构校验，执行方拿 args */
export function toolSpec<S extends z.ZodType>(info: Info<S> & { risk: string }): ToolDefinition {
  return { ...info, check: (raw) => ({ args: info.schema.parse(raw ?? {}) }) };
}

/** 只读工具：read 拿校验过的参数 */
export function readTool<S extends z.ZodType>(
  info: Info<S>,
  read: (ctx: ToolContext, args: z.output<S>, who: Who, extra?: ReadExtra) => unknown,
): ToolDefinition {
  return {
    ...info,
    risk: 'read',
    check: (raw) => {
      const args = info.schema.parse(raw ?? {});
      return { args, read: (ctx, who, extra) => read(ctx, args, who, extra) };
    },
  };
}

/** 写工具：build 拿校验过的参数生成方案（外壳已查过编辑权限），commit、stamp 拿存下来的方案 */
export function planTool<S extends z.ZodType>(
  info: Info<S> & { risk: string },
  writer: {
    build: (ctx: ToolContext, tool: string, args: z.output<S>, actor: Actor, binding: string) => ToolPlan;
    commit: Commit;
    stamp?: Stamp;
  },
): ToolDefinition {
  return {
    ...info,
    check: (raw) => {
      const args = info.schema.parse(raw ?? {});
      return { args, build: (ctx, actor, binding) => writer.build(ctx, info.name, args, actor, binding) };
    },
    commit: writer.commit,
    ...(writer.stamp ? { stamp: writer.stamp } : {}),
  };
}
