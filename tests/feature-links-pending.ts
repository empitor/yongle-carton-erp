// 给 tests/feature-links-*.test.ts 共用的小函数（只导出，不是测试文件本身）。

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isWriteMethod = (method: string) => writeMethods.has(method);
/** 一条路由的登记写法：'方法 /地址' */
export const routeKey = (r: { method: string; path: string }) => r.method + ' ' + r.path;
