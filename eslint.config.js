// ESLint：函数复杂度、任意类型和强行断言、抓真错、废弃写法、出错后不处理、危险正则、前端组件依赖。全部 error。
// eslint-suppressions.json 是空的，不许往里登记：新写和改到的代码一处都不许报。
// 函数复杂度另由 npm run lint:ratchet 再守一道（scripts/complexity-ratchet.mjs，基线 0 项）。
// 带类型的规则跨文件看类型，不能用 --cache（别的文件改了类型，缓存会给出过期结果）：npm run lint 每次全跑。
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import regexp from 'eslint-plugin-regexp';
import { localRules } from './scripts/eslint-local-rules.mjs';

const lines = { skipBlankLines: true, skipComments: true };
/** 从 src/ui 引这几个名字（按路径认：../ui/index、../src/ui/event-stream.js 这类） */
const uiImport = (importNames) => ({
  regex: '(^|/)ui(/[a-z-]+)?([.]js)?$',
  importNames,
  message: '这个函数把读到的数据当成调用方指定的类型、不校验：只许 src/ui（和 eslint.config.js 登记的几份）用，别处走接口表的 call()。',
});
const bareCustom = {
  selector: "CallExpression[callee.object.name='z'][callee.property.name='custom'][arguments.length=0]",
  message: 'z.custom() 不带校验函数什么都不查，等于强行断言：传校验函数，或写出结构。',
};
const requiredUnknown = {
  selector: "Property > CallExpression.value[callee.object.name='z'][callee.property.name=/^(unknown|any)$/]",
  message: 'zod 4 里值是 z.unknown()、z.any() 的键是必填的：可以没有就写 .optional()。',
};

export default [
  { ignores: ['dist/**', '**/node_modules/**'] },
  {
    files: ['{server,shared,src,scripts,tests}/**/*.{ts,tsx,mts,js,mjs}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin, regexp, 'react-hooks': reactHooks, local: { rules: localRules } },
    // 不认代码里的 eslint-disable 注释：豁免只记在豁免文件一处
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    rules: {
      // 函数复杂度：函数 80 行（空行和注释不算）、嵌套 4 层、参数 5 个、圈复杂度 20
      'max-lines-per-function': ['error', { max: 80, ...lines }],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      complexity: ['error', 20],
      'no-empty': 'error',
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'hack'], location: 'start' }],
      'regexp/no-super-linear-backtracking': 'error',
    },
  },
  // React 组件大半是 JSX 结构（渲染部分），行数另算
  { files: ['src/**/*.tsx'], rules: { 'max-lines-per-function': ['error', { max: 150, ...lines }] } },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    // 带类型信息：tsconfig.json 管到的文件（.mjs 不在类型检查里，只查上面那些）
    files: ['{server,shared,src,scripts,tests}/**/*.{ts,tsx,mts}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // 任意类型和强行断言
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // 抓真错。node:test 的 test()、describe() 返回的 Promise 由测试框架自己等，不算没等待
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }] },
      ],
      // JSX 属性里传异步函数（onClick={async () => …}）是 React 的常规写法
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
  {
    // 写死的数字（AGENTS.md“不把值写死”）：只查服务端和共用代码。0、1、2、100、1000、-1 和数组下标、默认值一眼就懂，放过；
    // HTTP 状态码按位置放过（scripts/eslint-local-rules.mjs）。typescript-eslint 的版本另外放过枚举、字面量类型、只读属性、类型下标
    files: ['{server,shared}/**/*.{ts,mts}'],
    rules: {
      'local/no-magic-numbers': [
        'error',
        {
          ignore: [0, 1, 2, 100, 1000, -1, '0n', '10n'],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          enforceConst: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    // 前端发请求、读回答的函数只许在各模块的 *-api.ts 和 src/ui 里用（上传走 uploadFile，页面可以直接用）
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/ui/**', 'src/**/*-api.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)ui(/(index|http|app-api|call))?$',
              importNames: ['call', 'request', 'throwIfFailed', 'authorizedRequest', 'tokenRequest', 'retryWhenBusy'],
              message: '请求写进本模块的 *-api.ts，页面和组件调那里的函数（上传用 uploadFile）。',
            },
          ],
        },
      ],
    },
  },
  {
    // 把读到的 unknown 当成调用方指定类型的函数：trustedReply 只许 src/ui 自己用；responseData、readEventStream 另外只许下面一块的三份文件用。
    // 别处读回答走接口表的 call()；下面单列的调用点用 AI 页面凭证或读事件流，忽略的三份测试直接验证这些读取函数。
    files: ['{server,shared,src,scripts,tests}/**/*.{ts,tsx,mts,js,mjs}'],
    ignores: [
      'src/ui/**',
      'tests/assistant-page-reads-server.test.ts',
      'tests/stream-reply.test.ts',
      'tests/frontend-request.test.ts',
    ],
    rules: { 'no-restricted-imports': ['error', { patterns: [uiImport(['trustedReply', 'responseData', 'readEventStream'])] }] },
  },
  {
    files: ['src/admin/settings-api.ts', 'src/import/workspace-api.ts', 'src/assistant/useAssistantChat.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [uiImport(['trustedReply'])] }] },
  },
  // 不带校验函数的 z.custom<…>() 什么都不查，等于强行断言：全项目禁用，测试也禁
  { files: ['{server,shared,src,scripts,tests}/**/*.{ts,tsx,mts,js,mjs}'], rules: { 'no-restricted-syntax': ['error', bareCustom] } },
  // zod 4 里值直接是 z.unknown()、z.any() 的键是必填的，按结构读服务端数据时一缺就报错：要写 .optional()
  { files: ['{server,shared,src}/**/*.{ts,tsx,mts,js,mjs}'], rules: { 'no-restricted-syntax': ['error', bareCustom, requiredUnknown] } },
  {
    // 助手发给模型的工具参数结构：加 .optional() 会把字段从 required 里去掉，改变模型看到的参数，这里不查
    files: ['server/assistant/tools/**'],
    rules: { 'no-restricted-syntax': ['error', bareCustom] },
  },
  {
    // 服务端读库只走 server/core 的 one、many、exists、count（在那里按结构校验），不直接 prepare(…).get/all/iterate；写库的 .run() 不管。
    // 按类型认语句对象（scripts/eslint-local-rules.mjs），先存进变量再读的也拦
    files: ['server/**/*.{ts,mts}'],
    ignores: ['server/core/storage/sqlite/sql.ts', 'server/core/schema/**'],
    rules: {
      'local/no-direct-db-read': 'error',
    },
  },
  {
    // SQL 里不写死单据状态、种类和 flow_ 记录种类（scripts/eslint-local-rules.mjs）：单据流转自己、建表不查，
    // 财务不查（财务表的状态和单据状态同名）；单据流转里给财务的只读窗口要查，见下一块
    files: ['server/**/*.{ts,mts}'],
    ignores: ['server/flow/**', 'server/core/schema/**', 'server/finance/**'],
    rules: { 'local/no-flow-literals': 'error' },
  },
  { files: ['server/flow/finance-facts/**/*.ts'], rules: { 'local/no-flow-literals': 'error' } },
  {
    // 财务从业务拿数据的只读窗口：只用 server/core 的 one、many、exists、count 读，能写库的入口一个都不碰（SQL 里的写由 tests/module-table-owners.test.ts 查）
    files: ['server/flow/finance-facts/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...['prepare', 'exec', 'run', 'transaction'].map((property) => ({
          property,
          message: '只读窗口只用 server/core 的 one、many、exists、count 读库，不碰 prepare、exec、run、transaction。',
        })),
      ],
    },
  },
];
