import type { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { KIB, MIB, fieldNamer, isRecordKind, userError } from '../shared/core/index.js';
import { AppError, ConflictError, InputError, constraintFailure } from './core/index.js';
import { BusinessAccessError } from './orders/index.js';

const tooLargeMessage = (limit: number) =>
  '提交内容过大，这里一次最多 ' + (limit >= MIB ? Math.floor(limit / MIB) + ' MB' : Math.ceil(limit / KIB) + ' KB');
/** body-parser 报的请求体太大：带着这个接口的上限（字节） */
const tooLargeSchema = z.object({ type: z.literal('entity.too.large'), limit: z.number() });
/** AppError 的子类可能带的两项：给页面的明细、服务器正忙时等几秒再发 */
const appErrorExtras = (error: AppError) => ({
  details: 'details' in error ? error.details : undefined,
  retryAfterSeconds: 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number' ? error.retryAfterSeconds : 0,
});

/**
 * 校验没过的是哪种记录：路由记下的（办一张单据时按它的种类，登记到货是到货单：res.locals.fieldRecord），
 * 再看地址里写着的（/purchases、/flow/delivery）；报错按那种记录的栏目叫法说（采购单的日期叫“采购日期”）。
 * 说不出的按栏目的基本叫法。
 */
function recordOf(req: Request, res: Response) {
  const noted: unknown = res.locals.fieldRecord;
  if (typeof noted === 'string' && isRecordKind(noted)) return noted;
  return req.path.split('/').find(isRecordKind);
}

/**
 * 全站的出错回答（原来写在 server/app.ts）：校验没过、版本冲突、没有权限、不存在、业务上可预期的失败（AppError，
 * 带 details 的一并回给页面，比如撞上已有库存品时的编号、财务报表还缺的信息）、JSON 格式、太大、数据库约束；
 * 别的错误只回一句中文，原文写进服务端日志。
 */
export function apiErrorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  // 留给最近出错的记录（server/core/diagnostics/request-recorder.ts）：5xx 时取堆栈前 5 行和原因摘要
  res.locals.failure = error;
  if (error instanceof ZodError) {
    const namer = fieldNamer(recordOf(req, res));
    return res
      .status(400)
      // 全站一个写法：按界面叫法的中文整句（“明细第1项的产品：请选择产品”），见 shared/core/user-errors.ts；同一句只说一次
      .json({
        // 多了不认识的字段：只说一句，不把请求里的键名（可能是别人塞的话）带回页面、带进出错记录
        message: [
          ...new Set(
            error.issues.map((i) =>
              i.code === 'unrecognized_keys' ? '提交的内容里有不认识的字段' : userError(i.path.join('.') + ': ' + i.message, namer),
            ),
          ),
        ].join('；'),
      });
  }
  if (error instanceof ConflictError) return res.status(409).json({ message: error.message });
  if (error instanceof BusinessAccessError) return res.status(403).json({ message: error.message });
  if (error instanceof InputError) return res.status(400).json({ message: error.message });
  if (error instanceof AppError) {
    const { details, retryAfterSeconds } = appErrorExtras(error);
    // 服务器正忙这类：告诉页面等几秒再发（server/accounts/hash-queue.ts 的 ServerBusyError）
    if (retryAfterSeconds) res.set('Retry-After', String(retryAfterSeconds));
    return res
      .status(error.status)
      .json({ message: error.message, code: error.code, ...(details === undefined ? {} : { details }) });
  }
  if (error instanceof SyntaxError) return res.status(400).json({ message: 'JSON 格式错误' });
  // 上限是各接口自己定的（比如助手附件 10 MB），body-parser 报错时带着，照实告诉人
  const tooLarge = tooLargeSchema.safeParse(error);
  if (tooLarge.success) return res.status(413).json({ message: tooLargeMessage(tooLarge.data.limit) });
  // 数据库约束挡下的写入：给用户一句中文，原始错误（英文）已经写进服务端日志
  const constraint = constraintFailure(error, req.method + ' ' + req.path);
  if (constraint) return res.status(500).json({ message: constraint, code: 'data-rule' });
  console.error(error);
  res.status(500).json({ message: '保存失败，请检查服务日志后重试' });
}
