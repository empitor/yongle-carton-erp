export { reviewedAssistantGrant, validAssistantGrant } from './http/assistant-approval.js';
export type { Actor } from './http/actor.js';
export type { RequestAuth } from './http/request-auth.js';
export { audit, rememberDeletedRecord, viaEntry } from './records/audit.js';
export { changeArchive, recordArchiveTarget } from './records/archive.js';
export type { ArchiveTarget } from './records/archive.js';
export { FILE_NAME_MAX, validateAttachment } from './files/attachment-validation.js';
export { validateOffice } from './files/office-validation.js';
export { createFullBackup, restoreFullBackup } from './backup/backup.js';
export { readBackupManifest } from './backup/backup-manifest.js';
export { autoBackupFailure, scheduleDailyBackup } from './backup/backup-auto.js';
export { validateBusinessDatabase } from './backup/backup-check.js';
export { snapshotBeforeDestructive } from './backup/snapshots.js';
export { backupDirectory, configDirectory, masterKeyName } from './backup/config-paths.js';
export { Store, archivedAmongIn, archivedIdsIn, defaultDbPath } from './storage/db.js';
export { clientNetwork, forwardedClient, hasProxyHeaders, proxyIngress, readDeployment } from './http/deployment.js';
export type { Deployment } from './http/deployment.js';
export { isLocalAdministrator, localAdministratorActor, requireLocalAdministrator } from './http/local-administrator.js';
export { AppError, ConflictError, InputError, StoredDataError, constraintFailure, failureMessage, isConstraintError } from './http/errors.js';
export { SchemaError, currentSchemaVersion, stamp } from './schema/index.js';
export { acquireLock } from './storage/lock.js';
export { clampPage, pageRows, parsePaging } from './http/paging.js';
export {
  canEnterSuperMode,
  includeArchivedFor,
  isSuperMode,
  requirePermission,
  requireSuperAdminAccount,
  requireSuperModeFor,
  superModeDenied,
} from './http/permissions.js';
// 基础模块自己的表的删除、初始化规则（加载基础模块时登记）
import './records/deletion-base.js';
export { beforeRecordDeleted, deletionColumns, deletionLabel, deletionMirror, deletionPlanners, deletionRemove, deletionUpdate, registerRecordDeletion, registerReset, registerTableDeletion, requireDeletionTables, requireRecordDeletionHook, resetClear, resetCounts, resetParticipants, textOf } from './records/deletion-rules.js';
// 归档标记、墓碑能记的记录种类：各模块登记自己的（server/core/records/kinds/record-kinds.ts）
export { registerRecordKinds } from './records/kinds/record-kinds.js';
export type { DeletionContext, DeletionGraph, DeletionRow } from './records/deletion-rules.js';
export { onceByRequest, operationRequest, purgeOperationRequests, replayRequest, requestDone, saveRequest, updateRequestResult } from './storage/requests.js';
export { inSavepoint, isRehearsing, rehearse } from './storage/savepoint.js';
export { assertPreviewCurrent, previewDigest } from './storage/preview-digest.js';
export { peekSequence, takeSequence } from './storage/sequences.js';
export { scheduleDailyCleanup } from './backup/cleanup.js';
export { openEventStream, pipeBytes, watchDisconnect } from './http/stream.js';
export { openVersionedSqlite } from './backup/versioned-sqlite.js';
export { VersionedSqliteError, registerVersionedSqlite } from './backup/versioned-sqlite-spec.js';
export type { VersionedSqliteSpec } from './backup/versioned-sqlite-spec.js';
// 补丁回滚、换回旧程序以后把配置库换回升级前的备份（维护命令行 revert-config-upgrades 用）
export { revertConfigUpgrades } from './backup/versioned-sqlite-backup.js';
export { nextAutoId } from './storage/ids.js';
// 出错记录（server/core/diagnostics/）：请求关卡记失败的请求、页面上报，最近出错的读取。
// 系统资料和账号也用这里的读取权限、分页、遮密钥等公共规则。
export { ProblemLog, readRecentProblems } from './diagnostics/problem-log.js';
export { errorReason, problemCategories } from './diagnostics/problem-kinds.js';
export { recordFailedRequests } from './diagnostics/request-recorder.js';
export { pageProblemRouter } from './diagnostics/page-problems.js';
export { defaultProblemLogPath, programRoot } from './diagnostics/paths.js';
export { RECORD_PAGE, isoTime, pageWindow, requireSuperAdmin } from './diagnostics/reading.js';
export type { PageSize } from './diagnostics/reading.js';
export { clip, redactCodeSecrets, redactSecrets } from './diagnostics/redact.js';
// 读库：按建表生成的行结构（schema/rows.ts）和读库时校验的 one、many、exists、count（sql.ts）
export { rows } from './schema/rows.js';
export type { Rows } from './schema/rows.js';
export { count, exists, many, one } from './storage/sqlite/sql.js';
// 库里读出来的数据（行、JSON 列）不合结构：抛 StoredDataError（回 500、记日志），单据内容等 JSON 列用 parseStoredJson 读
export { parseStoredJson } from './storage/sqlite/sql.js';
// 生成行结构用（scripts/schema-rows.ts）：业务库的建表分组、登记过的配置库规格
export { schemaTableGroups } from './schema/index.js';
export { registeredVersionedSqlite } from './backup/versioned-sqlite-spec.js';
export { done, notFound, refuse, route } from './http/route.js';
export type { RouteReply } from './http/route.js';
export { LOG_ONCE_MS, retryMinutes, Throttle } from './http/throttle.js';
