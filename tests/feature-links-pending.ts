// 给 tests/feature-links-*.test.ts 共用的登记和小函数（只导出，不是测试文件本身）。

/**
 * 写地址整块还没逐条登记成业务动作的地址前缀（不带 /api），各写明原因。这些前缀下的写地址不查登记、不查前端提交处；
 * 前缀下已经没有写地址了测试会提醒删。
 */
export const pendingWritePrefixes: { prefix: string; why: string }[] = [];

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isWriteMethod = (method: string) => writeMethods.has(method);
/** 一条路由的登记写法：'方法 /地址' */
export const routeKey = (r: { method: string; path: string }) => r.method + ' ' + r.path;
