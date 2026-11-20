// 托盘和菜单：商标图标、提示“甬勒ERP”，左键松开恢复主窗口；右键菜单“显示”“重新载入”“检查更新”、
// 可勾选的“开机自动启动”（默认不勾）、“退出”。没配更新地址的版本不放“检查更新”。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::config::AppConfig;
use crate::notice::{self, Kind, TITLE};
use crate::report::{note, report};
use crate::{autostart, updater, window};

/// 托盘图标的编号（只有一个托盘图标）
const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "show";
const MENU_RELOAD: &str = "reload";
const MENU_UPDATE: &str = "update";
const MENU_AUTOSTART: &str = "autostart";
const MENU_QUIT: &str = "quit";

/// 托盘菜单的几项
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    Show,
    Reload,
    CheckUpdate,
    Autostart,
    Quit,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let startup = CheckMenuItem::with_id(
        app,
        MENU_AUTOSTART,
        "开机自动启动",
        true,
        autostart::checked(app),
        None::<&str>,
    )?;
    let menu = Menu::new(app)?;
    menu.append(&item(MENU_SHOW, "显示")?)?;
    menu.append(&item(MENU_RELOAD, "重新载入")?)?;
    if app.state::<AppConfig>().update.is_some() {
        menu.append(&item(MENU_UPDATE, "检查更新")?)?;
    }
    menu.append(&startup)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&item(MENU_QUIT, "退出")?)?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(TITLE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| on_menu(app, event.id().as_ref(), &startup))
        .on_tray_icon_event(|tray, event| {
            if is_left_click(&event) {
                window::restore(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        MENU_SHOW => Some(MenuAction::Show),
        MENU_RELOAD => Some(MenuAction::Reload),
        MENU_UPDATE => Some(MenuAction::CheckUpdate),
        MENU_AUTOSTART => Some(MenuAction::Autostart),
        MENU_QUIT => Some(MenuAction::Quit),
        _ => None,
    }
}

fn is_left_click(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

fn on_menu(app: &AppHandle, id: &str, startup: &CheckMenuItem<Wry>) {
    match menu_action(id) {
        Some(MenuAction::Show) => window::restore(app),
        Some(MenuAction::Reload) => window::reload(app),
        Some(MenuAction::CheckUpdate) => updater::check(app),
        Some(MenuAction::Autostart) => toggle_autostart(app, startup),
        // 有下载好的新版本时，退出就交给安装器
        Some(MenuAction::Quit) => updater::quit(app),
        None => note(app, &format!("不认识的托盘菜单项：{id}")),
    }
}

/// 点“开机自动启动”：菜单已经自己翻过勾选了，照着去登记或删除；之后按系统里实际的登记重新打勾
fn toggle_autostart(app: &AppHandle, startup: &CheckMenuItem<Wry>) {
    let applied = startup
        .is_checked()
        .map_err(|e| e.to_string())
        .and_then(|checked| autostart::apply(app, checked));
    if let Err(message) = applied {
        note(app, &format!("设置开机自动启动失败：{message}"));
        notice::tell_later(format!("开机自动启动没设置成功：{message}"), Kind::Warning);
    }
    report(
        app,
        "更新开机自启的勾选",
        startup.set_checked(autostart::checked(app)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_menu_ids_map_to_actions() {
        assert_eq!(menu_action(MENU_SHOW), Some(MenuAction::Show));
        assert_eq!(menu_action(MENU_RELOAD), Some(MenuAction::Reload));
        assert_eq!(menu_action(MENU_UPDATE), Some(MenuAction::CheckUpdate));
        assert_eq!(menu_action(MENU_AUTOSTART), Some(MenuAction::Autostart));
        assert_eq!(menu_action(MENU_QUIT), Some(MenuAction::Quit));
        assert_eq!(menu_action("unknown"), None);
    }
}
