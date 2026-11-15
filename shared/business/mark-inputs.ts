import { z } from 'zod';

/*
 * 产品唛头资料（product_marks）的取值和改、删收的正文：服务端 server/business/product-marks.ts 按它校验，
 * 接口表 mark-api.ts 照它写类型。
 */

/** 唛头是怎么来的（product_marks.source_kind）：人工上传、助手上传。和建表里的 CHECK 一致（tests/schema-constraints.test.ts 比对） */
export const markSourceKinds = ['manual', 'assistant'] as const;

/** 改、删都带读到时的版本号，别人先改过就拒绝 */
const expectedVersion = z.number().int().positive();
/** 改唛头：只改说明 */
export const markUpdateSchema = z.strictObject({ title: z.string(), expectedVersion });
export const markRemoveSchema = z.strictObject({ expectedVersion });
