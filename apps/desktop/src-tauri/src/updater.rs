// 应用内更新（Tauri 官方 Updater）：托盘“检查更新”→ 读版本清单 → 有新版就问要不要下载
// → 下载并按公钥校验签名 → 问“现在安装吗”：选“是”马上交给安装器（装完带着这次的参数重新打开），
// 选“否”就等从托盘“退出”时再装（装完不重开）。点 × 仍只是收进托盘。清单地址和公钥从托管的设置里读（没配时托盘里没有这一项）。
// 检查失败只提示，不影响打开 ERP。弹框会挡住线程，所以查、问、下载、安装都在后台线程里做。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

use crate::autostart;
use crate::config::AppConfig;
use crate::notice::{self, Kind};
use crate::report::note;

/// 查清单、下载安装包各最多等这么久（服务器挂起时不一直等）
const TIMEOUT: Duration = Duration::from_secs(120);

/// 更新的状态，交给 Tauri 托管
#[derive(Default)]
pub struct Updates {
    /// 下载好、校验过，等安装的新版本
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    /// 正在查或下载：这时再点“检查更新”只提示一句，不重复下载
    busy: AtomicBool,
}

impl Updates {
    /// 锁坏了（拿着锁的线程 panic 过）也照样取里面的数据：里面只是一个可有可无的安装包
    fn ready(&self) -> MutexGuard<'_, Option<(Update, Vec<u8>)>> {
        self.ready.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 下载好的新版本号
    fn ready_version(&self) -> Option<String> {
        self.ready()
            .as_ref()
            .map(|(update, _)| update.version.clone())
    }

    /// 有下载好的新版本就交给安装器：插件拉起安装器后自己结束进程，不会回到这里。
    /// reopen 为真时装完由安装器带着这次的命令行参数重新打开程序。
    /// 没有新版本返回 Ok；没装上返回原因，安装包留着下次再试
    fn install(&self, reopen: bool) -> Result<(), String> {
        match self.ready().as_ref() {
            Some((update, bytes)) => update
                .clone()
                .restart_after_install(reopen)
                .install(bytes)
                .map_err(|e| explain(&e)),
            None => Ok(()),
        }
    }
}

/// 托盘“检查更新”
pub fn check(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let updates = app.state::<Updates>();
        if updates.busy.swap(true, Ordering::SeqCst) {
            notice::tell("正在检查或下载更新，请稍候。", Kind::Info);
            return;
        }
        match tauri::async_runtime::block_on(find_and_download(&app)) {
            Ok(Some(version)) => offer_install(&app, &version),
            Ok(None) => {}
            Err(message) => {
                note(&app, &format!("检查更新没成功：{message}"));
                notice::tell(&format!("检查更新没成功：{message}"), Kind::Warning);
            }
        }
        // 问完、提示完才算结束，免得同时弹出两个“现在安装吗”
        updates.busy.store(false, Ordering::SeqCst);
    });
}

/// 查、问、下载；返回下载好（或早就下载好）的新版本号，没有新版或不下载返回 None
async fn find_and_download(app: &AppHandle) -> Result<Option<String>, String> {
    let updates = app.state::<Updates>();
    if let Some(version) = updates.ready_version() {
        return Ok(Some(version));
    }
    let Some(update) = find_update(app).await? else {
        notice::tell("已经是最新版本。", Kind::Info);
        return Ok(None);
    };
    if !ask_download(&update) {
        return Ok(None);
    }
    // download 会按公钥核对签名，对不上就报错、不留安装包
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| explain(&e))?;
    let version = update.version.clone();
    *updates.ready() = Some((update, bytes));
    Ok(Some(version))
}

/// 按配置的清单地址和公钥查有没有新版本
async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let config = app.state::<AppConfig>();
    let source = config.update.as_ref().ok_or("这个版本没有配置更新地址")?;
    let updater = app
        .updater_builder()
        .endpoints(vec![source.manifest.clone()])
        .and_then(|b| b.pubkey(source.pubkey.clone()).timeout(TIMEOUT).build())
        .map_err(|e| explain(&e))?;
    updater.check().await.map_err(|e| explain(&e))
}

fn ask_download(update: &Update) -> bool {
    notice::ask(&format!(
        "发现新版本 {}（现在是 {}）。\n\n要现在下载吗？选“是”在后台下载并核对签名，好了会再问你什么时候安装；选“否”以后再说。",
        update.version, update.current_version
    ))
}

/// 装完重新打开的程序会带着这次的命令行参数：这次是开机自启拉起的（带 --autostart），
/// 重开后也安静地待在托盘里，问话要如实说
fn after_install(at_login: bool) -> &'static str {
    if at_login {
        "装完程序回到托盘，点托盘图标打开"
    } else {
        "装完自动重新打开"
    }
}

/// 下载好了：问要不要现在装，选“否”就等从托盘退出时再装（那时装完不重开）
fn offer_install(app: &AppHandle, version: &str) {
    let reopened = after_install(autostart::at_login(std::env::args()));
    let question = format!(
        "新版本 {version} 已下载并核对过签名。\n\n现在安装吗？选“是”马上关闭甬勒ERP 安装新版本，{reopened}；选“否”下次从托盘“退出”时再装，装完不自动打开。"
    );
    if !notice::ask(&question) {
        return;
    }
    if let Err(message) = app.state::<Updates>().install(true) {
        note(app, &format!("安装新版本没成功：{message}"));
        notice::tell(
            &format!("新版本没装上：{message}\n\n安装包留着，下次从托盘“退出”时再试。"),
            Kind::Warning,
        );
    }
}

/// 托盘“退出”：有下载好的新版本就交给安装器（安装器启动后程序自己退出；退出就是退出，装完不重开），
/// 否则直接退出。没装上就说明原因（只有“确定”），然后照常退出；安装包只在内存里，退出就没了，下次要重新检查更新
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(message) = app.state::<Updates>().install(false) {
            note(&app, &format!("安装新版本没成功：{message}"));
            notice::tell(
                &format!("新版本没装上：{message}\n\n甬勒ERP 照常退出，现在的版本不受影响。下载好的安装包没有保留，下次打开后从托盘“检查更新”重新下载安装。"),
                Kind::Warning,
            );
        }
        app.exit(0);
    });
}

/// 插件常见的报错说成中文，其余附上原文
fn explain(error: &Error) -> String {
    match error {
        Error::Reqwest(_) | Error::Network(_) => "连不上更新服务器，请检查网络".into(),
        Error::ReleaseNotFound | Error::Serialization(_) => "更新服务器上的版本清单读不出来".into(),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "版本清单里没有 Windows（windows-x86_64）的安装包".into()
        }
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => "安装包的签名对不上，已经丢弃".into(),
        Error::InsecureTransportProtocol => "更新地址必须是 HTTPS".into(),
        other => format!("更新出错（{other}）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_updater_errors_are_explained_in_chinese() {
        assert_eq!(
            explain(&Error::Network("timed out".into())),
            "连不上更新服务器，请检查网络"
        );
        assert_eq!(
            explain(&Error::InsecureTransportProtocol),
            "更新地址必须是 HTTPS"
        );
        assert_eq!(
            explain(&Error::MissingSignedVersion),
            "安装包的签名对不上，已经丢弃"
        );
        assert_eq!(
            explain(&Error::TargetNotFound("windows-x86_64".into())),
            "版本清单里没有 Windows（windows-x86_64）的安装包"
        );
    }

    #[test]
    fn other_errors_keep_their_original_text() {
        assert_eq!(
            explain(&Error::EmptyEndpoints),
            "更新出错（Updater does not have any endpoints set.）"
        );
    }

    #[test]
    fn a_run_started_at_login_is_told_it_reopens_in_the_tray() {
        assert_eq!(after_install(true), "装完程序回到托盘，点托盘图标打开");
        assert_eq!(after_install(false), "装完自动重新打开");
    }
}
