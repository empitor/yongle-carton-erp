// 出错记录：往应用日志目录（%LOCALAPPDATA%\<应用标识>\logs\）的 shell.log 追加一行，同时打到标准错误
// （开发版的启动器有控制台）。文件超过 LOG_LIMIT 就改名成 shell.old.log 再重新写，最多留两份。只用标准库。

use std::fmt::Display;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

const FILE: &str = "shell.log";
const OLD_FILE: &str = "shell.old.log";
const LOG_LIMIT: u64 = 256 * 1024;
const DAY_SECS: u64 = 86_400;

/// 操作失败不致命，但要留下记录
pub fn report<E: Display>(app: &AppHandle, what: &str, result: Result<(), E>) {
    if let Err(error) = result {
        note(app, &format!("{what}失败：{error}"));
    }
}

/// 记一行
pub fn note(app: &AppHandle, text: &str) {
    eprintln!("{text}");
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let written = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())
        .and_then(|dir| {
            append(&dir, &format!("{} {text}", stamp(secs)), LOG_LIMIT).map_err(|e| e.to_string())
        });
    if let Err(error) = written {
        // 日志本身写不进去时，只剩上面的标准错误
        eprintln!("写日志失败：{error}");
    }
}

/// 往 dir 里的日志追加一行；原来的文件超过 limit 字节就先改名成旧日志（覆盖更早的那份）
fn append(dir: &Path, line: &str, limit: u64) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let file = dir.join(FILE);
    if fs::metadata(&file).is_ok_and(|m| m.len() > limit) {
        fs::rename(&file, dir.join(OLD_FILE))?;
    }
    let mut out = OpenOptions::new().create(true).append(true).open(file)?;
    writeln!(out, "{line}")
}

/// 1970 年起的秒数写成 UTC 时间，例如 2026-11-20 08:30:05Z
fn stamp(secs: u64) -> String {
    let (year, month, day) = civil(secs / DAY_SECS);
    let rest = secs % DAY_SECS;
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// 1970-01-01 起的天数换成年月日（Howard Hinnant 的 civil_from_days，只算 1970 年以后）
fn civil(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + u64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_written_as_utc_dates() {
        assert_eq!(stamp(0), "1970-01-01 00:00:00Z");
        assert_eq!(stamp(1_795_163_405), "2026-11-20 08:30:05Z");
        assert_eq!(stamp(951_868_799), "2000-02-29 23:59:59Z");
        assert_eq!(stamp(4_107_542_400), "2100-03-01 00:00:00Z");
    }

    #[test]
    fn lines_are_appended_and_a_full_log_is_moved_aside() {
        let dir = std::env::temp_dir().join(format!("yongle-shell-log-{}", std::process::id()));
        append(&dir, "第一行", 5).unwrap();
        append(&dir, "第二行", 5).unwrap();
        assert_eq!(fs::read_to_string(dir.join(OLD_FILE)).unwrap(), "第一行\n");
        assert_eq!(fs::read_to_string(dir.join(FILE)).unwrap(), "第二行\n");
        fs::remove_dir_all(&dir).unwrap();
    }
}
