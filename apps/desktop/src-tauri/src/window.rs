// 主窗口和网页弹出的新窗口：建窗口、按网址分流放行导航和新窗口、交给浏览器、按加载结果切到离线页、
// 显示、点 × 收进托盘。导航规则和加载结果放在一起：“重试”要重新加载主窗口，加载结果又要导航主窗口，
// 拆开就成了互相引用。

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::config::AppConfig;
use crate::loading::{self, Next, Outcome};
use crate::notice::{self, Kind, TITLE};
use crate::report::{note, report};
use crate::route::{route, Route, BLANK};
use crate::{pages, popup, splash};

/// 主窗口的标签
pub const MAIN: &str = "main";
const MAIN_SIZE: (f64, f64) = (1280.0, 800.0);
const MIN_SIZE: (f64, f64) = (960.0, 600.0);

fn home(app: &AppHandle) -> Url {
    app.state::<AppConfig>().erp_url.clone()
}

/// 主窗口直接加载 ERP、先不显示；加载的结果（loading.rs）决定切不切离线页、启动画面什么时候收尾
pub fn build_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(home(app)))
        .title(TITLE)
        .inner_size(MAIN_SIZE.0, MAIN_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .center()
        // 屏幕比窗口小（如 1366×768）时缩到屏幕里，标题栏不跑到屏幕外
        .prevent_overflow()
        .visible(false);
    let window = with_policy(app, builder).build()?;
    let handle = app.clone();
    loading::watch(&window, move |url, outcome| {
        after_load(&handle, url.as_ref(), outcome)
    })?;
    Ok(window)
}

fn after_load(app: &AppHandle, url: Option<&Url>, outcome: Outcome) {
    match loading::next(url, &home(app), outcome) {
        Next::Ready => reveal(app),
        Next::Offline => {
            go(app, pages::offline_url());
            reveal(app);
        }
        Next::Home => go(app, home(app)),
        Next::Stay => {}
    }
}

/// 启动画面还在就让它收尾、露出主窗口（不在就什么都不做）
fn reveal(app: &AppHandle) {
    let handle = app.clone();
    splash::finish(app, move || show_main(&handle));
}

/// 让主窗口去某个网址。从新线程发出去，排到当前这个 WebView2 事件处理完之后（在事件里直接导航会重入）
fn go(app: &AppHandle, url: Url) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(window) = app.get_webview_window(MAIN) {
            report(&app, "打开页面", window.navigate(url));
        }
    });
}

/// 主窗口和网页弹出的窗口共用的设置：导航规则；关掉 Tauri 自己的拖放接管，
/// 让 ERP 网页的 HTML5 拖放（拖文件进上传区、排产板拖动）照常工作；和浏览器一样能用 Ctrl+滚轮、Ctrl± 缩放页面。
/// 关掉拖放接管后文件拖到页面上没有接收区的地方，WebView2 会去打开 file:///，导航规则按“别的协议”拦下。
fn with_policy<'a>(
    app: &AppHandle,
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    builder
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .on_navigation(move |url| allow_navigation(&nav_app, url))
        .on_new_window(move |url, features| new_window(&popup_app, url, features))
}

fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    match route(url, &home(app)) {
        Route::Inside | Route::Local => true,
        Route::Retry => {
            go(app, home(app));
            false
        }
        Route::Browser => {
            open_in_browser(app, url);
            false
        }
        Route::Block => false,
    }
}

/// 网页要开新窗口（target=_blank、window.open）：站内的开一个同样规则的外壳窗口，站外的交给浏览器
fn new_window(
    app: &AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    match route(&url, &home(app)) {
        Route::Inside => match build_popup(app, features) {
            Ok(window) => NewWindowResponse::Create { window },
            Err(error) => {
                note(app, &format!("打开新窗口失败：{error}"));
                notice::tell_later(format!("新窗口打不开：{error}"), Kind::Warning);
                NewWindowResponse::Deny
            }
        },
        Route::Browser => {
            open_in_browser(app, &url);
            NewWindowResponse::Deny
        }
        Route::Local | Route::Retry | Route::Block => NewWindowResponse::Deny,
    }
}

#[expect(clippy::expect_used, reason = "about:blank 是常量，一定能解析")]
fn build_popup(app: &AppHandle, features: NewWindowFeatures) -> tauri::Result<WebviewWindow> {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    let label = format!("popup-{}", COUNT.fetch_add(1, Ordering::Relaxed));
    let blank = Url::parse(BLANK).expect("空白页地址写错了");
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .window_features(features)
        .title(TITLE);
    let popup = with_policy(app, builder).build()?;
    // 收尾事件挂不上只是少了自动关窗：记一笔，窗口照常给网页用（返回错误会留下一个没人管的空窗口）
    report(app, "挂上新窗口的收尾事件", popup::watch(&popup));
    Ok(popup)
}

fn open_in_browser(app: &AppHandle, url: &Url) {
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        note(app, &format!("交给浏览器失败：{url}：{error}"));
        notice::tell_later(
            format!("没能用系统浏览器打开这个网址：\n{url}\n\n请检查电脑的默认浏览器设置。"),
            Kind::Warning,
        );
    }
}

/// 托盘“重新载入”：停在站内的就重新载入当前页，否则（离线页）重新加载 ERP 首页；然后显示窗口
pub fn reload(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let home = home(app);
    let on_erp = window
        .url()
        .is_ok_and(|url| route(&url, &home) == Route::Inside);
    let result = if on_erp {
        window.reload()
    } else {
        window.navigate(home)
    };
    report(app, "重新载入", result);
    show(app, &window);
}

/// 从托盘、再次启动唤起主窗口：停在离线页就顺手再加载一次 ERP（网可能已经好了）
pub fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let home = home(app);
    let offline = window
        .url()
        .is_ok_and(|url| route(&url, &home) == Route::Local);
    if offline {
        report(app, "重新加载 ERP", window.navigate(home));
    }
    show(app, &window);
}

/// 显示主窗口、切到前台
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        show(app, &window);
    }
}

fn show(app: &AppHandle, window: &WebviewWindow) {
    report(app, "恢复窗口", window.unminimize());
    report(app, "显示窗口", window.show());
    report(app, "切到前台", window.set_focus());
}

/// 点主窗口的 × 只是收进托盘；网页弹出的窗口照常关闭
pub fn hide_on_close(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN {
            api.prevent_close();
            report(window.app_handle(), "收进托盘", window.hide());
        }
    }
}
