// 各模块往基础登记删除、初始化规则和记录种类时写的模块名（类型 ModuleName，写错编译不过）和模块表（tests/module-map.ts）的服务端模块一致
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverModuleNames } from '../server/core/records/kinds/module-names.js';
import { modules } from './module-map.js';

test('基础的模块名清单和模块表里的服务端模块一样：加、改模块要两边一起改', () => {
  const server = modules.filter((m) => m.paths.some((p) => p.startsWith('server/'))).map((m) => m.name);
  assert.deepEqual([...serverModuleNames].sort(), [...server].sort(), 'server/core/records/kinds/module-names.ts 和 tests/module-map.ts 对不上');
});
