/**
 * 字节和时长的换算单位：上限、保留时长写成“几 MB 乘 MIB”“几天乘 DAY_MS”，不在各处写 1024、3600_000 这类数。
 */
export const KIB = 1024;
export const MIB = KIB * KIB;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
