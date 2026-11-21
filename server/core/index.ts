export { reviewedAssistantGrant, validAssistantGrant } from './assistant-approval.js';
export { defaultAccountPath } from './account-db.js';
export type { Actor } from './actor.js';
export { audit, rememberDeletedRecord, viaEntry } from './audit.js';
export { changeArchive, recordArchiveTarget } from './archive.js';
export type { ArchiveTarget } from './archive.js';
export { AuthManager } from './auth.js';
export { FILE_NAME_MAX, validateAttachment } from './attachment-validation.js';
export { validateOffice } from './office-validation.js';
export { createFullBackup, restoreFullBackup } from './backup.js';
export { readBackupManifest } from './backup-manifest.js';
export { autoBackupFailure, scheduleDailyBackup } from './backup-auto.js';
export { validateBusinessDatabase } from './backup-check.js';
export { snapshotBeforeDestructive } from './snapshots.js';
export { assertNewProductAllowed, describeProduct, duplicateCustomers } from './duplicate-records.js';
export type { DuplicateRecord } from './duplicate-records.js';
export { backupDirectory, configDirectory, masterKeyName } from './config-paths.js';
export { Store, defaultDbPath, partyView, registerProductStockSync } from './db.js';
export { forwardedClient, hasProxyHeaders, proxyIngress, readDeployment } from './deployment.js';
export type { Deployment } from './deployment.js';
export { isLocalAdministrator, requireLocalAdministrator } from './local-administrator.js';
export { AppError, ConflictError, InputError, StoredDataError, constraintFailure, failureMessage, isConstraintError } from './errors.js';
export { SchemaError, stamp } from './schema/index.js';
export { acquireLock } from './lock.js';
export { clampPage, pageRows, parsePaging } from './paging.js';
export {
  canEnterSuperMode,
  includeArchivedFor,
  isSuperMode,
  requirePermission,
  requireSuperModeFor,
  superModeDenied,
} from './permissions.js';
export { registerOrderRules } from './order-hooks.js';
export type { MaterialProgress, OrderEditGuard } from './order-hooks.js';
// 基础模块自己的表的删除、初始化规则（加载基础模块时登记）
import './deletion-base.js';
export { beforeRecordDeleted, deletionColumns, deletionLabel, deletionMirror, deletionPlanners, deletionRemove, deletionUpdate, financeDeletionRules, registerFinanceDeletionRules, registerRecordDeletion, registerReset, registerTableDeletion, requireDeletionModules, requireDeletionTables, resetClear, resetCounts, resetParticipants } from './deletion-rules.js';
export type { DeletionContext, DeletionGraph, DeletionRow } from './deletion-rules.js';
export { onceByRequest, operationRequest, purgeOperationRequests, replayRequest, requestDone, saveRequest, updateRequestResult } from './requests.js';
export { inSavepoint, rehearse } from './savepoint.js';
export { assertPreviewCurrent, previewDigest } from './preview-digest.js';
export { peekSequence, takeSequence } from './sequences.js';
export { scheduleDailyCleanup } from './cleanup.js';
export { openEventStream, pipeBytes, watchDisconnect } from './stream.js';
export { openVersionedSqlite } from './versioned-sqlite.js';
export { VersionedSqliteError, registerVersionedSqlite } from './versioned-sqlite-spec.js';
// 补丁回滚、换回旧程序以后把配置库换回升级前的备份（维护命令行 revert-config-upgrades 用）
export { revertConfigUpgrades } from './versioned-sqlite-backup.js';
export { nextAutoId } from './ids.js';
// 排查用的只读诊断（server/core/diagnostics/）：最近出错、页面上报、登录记录、运行日志、读程序代码
export { ProblemLog, readRecentProblems } from './diagnostics/problem-log.js';
export { problemCategories } from './diagnostics/problem-kinds.js';
export { recordFailedRequests } from './diagnostics/request-recorder.js';
export { pageProblemRouter } from './diagnostics/page-problems.js';
export { readLoginRecords } from './diagnostics/login-records.js';
export { RunLog, captureProcessOutput, readRunLog, searchRunLog } from './diagnostics/run-log.js';
export { readProgramSource, searchProgramSource } from './diagnostics/source-reader.js';
export type { SourceScope } from './diagnostics/source-paths.js';
export { defaultProblemLogPath, defaultRunLogPath, programSource } from './diagnostics/paths.js';
// 使用手册：“使用说明”页和助手的 guide.read 共用
export { findManualSection, readUserManual, userManualRouter } from './user-manual.js';
// 读库：按建表生成的行结构（schema/rows.ts）和读库时校验的 one、many、exists、count（sql.ts）
export { rows } from './schema/rows.js';
export { count, exists, many, one } from './sql.js';
// 库里读出来的数据（行、JSON 列）不合结构：抛 StoredDataError（回 500、记日志），单据内容等 JSON 列用 parseStoredJson 读
export { parseStoredJson } from './sql.js';
// 生成行结构用（scripts/schema-rows.ts）：业务库的建表分组、登记过的配置库规格
export { schemaTableGroups } from './schema/index.js';
export { registeredVersionedSqlite } from './versioned-sqlite-spec.js';
export { notFound, route } from './route.js';
