// 开机自动启动（Tauri 官方 tauri-plugin-autostart，只在 Rust 里用，网页调不到它的命令）：托盘菜单里的勾选项，
// 默认不勾。勾上时插件在当前用户的 Run 注册表项里登记“程序 --autostart”（值名是 productName）；
// 带这个参数启动就安静地待在托盘里：不放启动画面、不弹主窗口，主窗口在后台加载好，点托盘图标马上出来。
// 卸载时安装包钩子删掉这条登记（installer-hooks.nsh）。

use tauri::{AppHandle, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::report::note;

/// 开机自启时带的参数，区分“开机自启”和“人点开的”
pub const ARG: &str = "--autostart";

/// 插件：登记的启动命令带上 ARG
pub fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_autostart::Builder::new().arg(ARG).build()
}

/// 这次启动（或再次启动交来的命令行）是不是开机自启
pub fn at_login<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == ARG)
}

/// 菜单的勾选框跟着系统里实际的登记走；读不出来就当没开（读不出的原因记一笔）
pub fn checked(app: &AppHandle) -> bool {
    shown(
        app.autolaunch().is_enabled().map_err(|e| e.to_string()),
        |e| note(app, &format!("读开机自启状态失败：{e}")),
    )
}

fn shown(enabled: Result<bool, String>, on_error: impl FnOnce(&str)) -> bool {
    enabled.unwrap_or_else(|error| {
        on_error(&error);
        false
    })
}

/// 点了菜单之后勾选框已经翻过来了：勾着就登记，没勾就删掉
pub fn apply(app: &AppHandle, checked: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if checked {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_launches_with_the_autostart_argument_count_as_login() {
        assert!(at_login([r"C:\甬勒ERP\甬勒ERP.exe", ARG]));
        assert!(!at_login([r"C:\甬勒ERP\甬勒ERP.exe"]));
        assert!(!at_login([
            r"C:\甬勒ERP\甬勒ERP.exe",
            "--autostart=1",
            "autostart"
        ]));
    }

    #[test]
    fn the_menu_shows_the_real_registration_and_unreadable_counts_as_off() {
        let mut errors = Vec::new();
        assert!(shown(Ok(true), |e| errors.push(e.to_string())));
        assert!(!shown(Ok(false), |e| errors.push(e.to_string())));
        assert!(!shown(Err("拒绝访问".into()), |e| errors.push(e.to_string())));
        assert_eq!(errors, ["拒绝访问"]);
    }
}
