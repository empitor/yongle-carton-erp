// 甬勒ERP 的 Windows 客户端核心（yongle_erp_core.dll）的入口和装配：启动器 甬勒ERP.exe 把它加载进自己的进程，
// 调 yongle_erp_run_v1，一直跑到程序退出。各文件管什么、谁能引谁见 docs/架构说明.md（tests/boundary.test.mjs 守着）。

mod autostart;
mod config;
mod loading;
mod notice;
mod pages;
mod popup;
mod report;
mod route;
mod splash;
mod tray;
mod updater;
mod window;

use std::any::Any;
use std::path::PathBuf;

use config::AppConfig;
use tauri::{AppHandle, Wry};

/// Tauri 在 setup 出错时用 panic 报出来，原因前面带这句英文
const SETUP_FAILED: &str = "Failed to setup app: ";

/// 启动器调的入口：跑到程序退出。起不来时把原因（以 0 结尾的 UTF-16）交给 tell 显示，返回非 0。
/// 不让 Rust 的 panic 越过 dll 边界：接住后按起不来处理。名字带接口版本，参数或约定改了就换名字（启动器同步改）。
#[no_mangle]
pub extern "C" fn yongle_erp_run_v1(tell: extern "C" fn(*const u16)) -> i32 {
    let outcome =
        std::panic::catch_unwind(run).unwrap_or_else(|payload| Err(panic_text(&*payload)));
    match outcome {
        Ok(()) => 0,
        Err(message) => {
            let wide: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
            tell(wide.as_ptr());
            1
        }
    }
}

/// panic 带的原因写成给人看的一句话
fn panic_text(payload: &(dyn Any + Send)) -> String {
    let reason = payload
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied());
    match reason {
        Some(text) => match text.strip_prefix(SETUP_FAILED) {
            Some(cause) => format!("甬勒ERP 起不来：{cause}"),
            None => format!("客户端核心意外出错：{text}"),
        },
        None => "客户端核心意外出错".into(),
    }
}

/// 安装目录：启动器所在的目录（核心 dll、config\、pages\ 都在这里）
fn install_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("找不到程序自己的位置：{e}"))?;
    exe.parent()
        .map(PathBuf::from)
        .ok_or_else(|| "程序不在任何目录里".into())
}

fn run() -> Result<(), String> {
    let dir = install_dir()?;
    let pages_dir = dir.join(pages::DIR);
    builder(config::load(&dir)?)
        .register_uri_scheme_protocol(pages::SCHEME, move |_, request| {
            pages::respond(&pages_dir, &request)
        })
        .run(tauri::generate_context!())
        .map_err(|e| format!("甬勒ERP 起不来：{e}"))
}

/// 用到的插件都只在 Rust 里用、不往网页注入脚本（tests/boundary.test.mjs 按插件源码查）
fn builder(config: AppConfig) -> tauri::Builder<Wry> {
    tauri::Builder::default()
        // 再次启动只唤起已开的窗口；启动画面还没放完时什么都不做，等它自己收尾；
        // 已经开着时又被开机自启拉起一次，也不弹窗口
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !autostart::at_login(&args) && !splash::showing(app) {
                window::restore(app)
            }
        }))
        // 插件默认往每个网页注入脚本、把 target=_blank 链接改走外壳接口；ERP 网页没有接口权限，链接会点不开。
        // 关掉它，新窗口统一由导航规则分流。外壳只在 Rust 里用它打开浏览器。
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(autostart::plugin())
        .manage(config)
        .manage(updater::Updates::default())
        .manage(splash::Splash::default())
        .setup(|app| {
            tray::build(app.handle())?;
            window::build_main(app.handle())?;
            // 开机自启：安静地待在托盘里，主窗口在后台加载好，点托盘图标才出来
            if !autostart::at_login(std::env::args()) {
                open_splash(app.handle());
            }
            Ok(())
        })
        .on_window_event(window::hide_on_close)
}

/// 启动画面只是装饰：建不起来就记一笔、直接露出主窗口
fn open_splash(app: &AppHandle) {
    let handle = app.clone();
    let opened = splash::open(app, pages::splash_url(), notice::TITLE, move || {
        window::show_main(&handle)
    });
    if let Err(error) = opened {
        report::note(app, &format!("开启动画面失败：{error}"));
        window::show_main(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_failures_are_reported_with_their_cause() {
        let payload: Box<dyn Any + Send> = Box::new(format!("{SETUP_FAILED}没有 WebView2"));
        assert_eq!(panic_text(&*payload), "甬勒ERP 起不来：没有 WebView2");
        let payload: Box<dyn Any + Send> = Box::new("index out of bounds");
        assert_eq!(
            panic_text(&*payload),
            "客户端核心意外出错：index out of bounds"
        );
        let payload: Box<dyn Any + Send> = Box::new(42);
        assert_eq!(panic_text(&*payload), "客户端核心意外出错");
    }
}
