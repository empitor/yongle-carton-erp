// 对外接口：别的模块只能从这里引用这个模块。
// 系统资料：给助手和管理员排查、查阅用的只读资料——运行日志、登录记录、程序代码、使用手册（“使用说明”页和助手的 guide.read）
export { readLoginRecords } from './login-records.js';
export { defaultRunLogPath, programSource } from './paths.js';
export { RunLog, captureProcessOutput, readRunLog, searchRunLog } from './run-log.js';
export type { SourceScope } from './source-paths.js';
export { readProgramSource, searchProgramSource } from './source-reader.js';
export { findManualSection, readUserManual, userManualRouter } from './user-manual.js';
