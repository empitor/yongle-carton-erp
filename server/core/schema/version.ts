/**
 * 业务库（erp.sqlite）的结构版本。
 * 0.9.0 起业务数据从空库开始：0.9.0 的建表定为第 20 版，接着 0.9.0 以前的第 1～19 版往后排，
 * 新旧编号不会撞；以后每加一段升级步骤（steps.ts）加一版。
 */

/** 写在数据库文件头里的标识（ASCII“ZXER”），用来认出“这是本系统 0.9.0 以后的业务库”。旧库是 0。 */
export const SCHEMA_APPLICATION_ID = 0x5a584552;
/** 0.9.0 的建表是第几版。比它小的都是 0.9.0 以前的旧库，不升级、不恢复。 */
export const SCHEMA_BASELINE = 20;
/** 当前程序的结构版本：等于 SCHEMA_BASELINE 加上 steps.ts 里的步骤数（测试会核对）。 */
export const SCHEMA_LATEST = 21;
/** 第 20 版在版本记录里的名字 */
export const SCHEMA_BASELINE_NAME = '0.9.0 基线';
