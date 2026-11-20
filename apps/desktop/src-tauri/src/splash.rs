// 冷启动的启动画面：一个无边框小窗放 pages\splash.html（约 1.3 秒的动画），主窗口同时在后台加载 ERP。
// 主窗口准备好（ERP 页面加载完，或确定连不上）且动画放够时长后，关掉小窗、由入口给的函数显示主窗口。
// 只在启动时开一次；从托盘恢复、再次启动唤起已开的窗口都不经过这里，不重播。状态交给 Tauri 托管。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::report::report;

const LABEL: &str = "splash";
/// 动画放完（含淡出）要多久；主窗口早好了也等到这时
const MIN_SHOWN: Duration = Duration::from_millis(1500);
/// ERP 迟迟加载不完时，最多挡这么久就先露出主窗口（页面接着加载）
const MAX_SHOWN: Duration = Duration::from_secs(8);
const SIZE: (f64, f64) = (360.0, 280.0);

/// 启动画面什么时候开的、主窗口有没有加载结果、收尾了没有
#[derive(Default)]
pub struct Splash {
    opened: OnceLock<Instant>,
    /// 主窗口已经有了加载结果。它可能比小窗建好还早：建小窗时主线程在转消息循环，
    /// 主窗口的“导航完成”照样派发（连不上时很快就来）
    ready: AtomicBool,
    finished: AtomicBool,
}

/// 启动时开启动画面（page 是启动画面页的地址，title 是窗口标题）；最长 MAX_SHOWN 后自动收尾。
/// 小窗建好时主窗口已经有了结果，就照常放够动画后收尾。
/// 小窗建不起来就返回错误、不算开过（不然 showing 会一直为真），由调用方直接露出主窗口
pub fn open<F: Fn() + Clone + Send + 'static>(
    app: &AppHandle,
    page: Url,
    title: &str,
    reveal: F,
) -> tauri::Result<()> {
    // 拖放保留 Tauri 默认的接管：小窗里没有导航规则，文件拖上来变成没人接的 Tauri 事件，不会去打开 file:///
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(page))
        .title(title)
        .inner_size(SIZE.0, SIZE.1)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .center()
        .build()?;
    let splash = app.state::<Splash>();
    splash.opened.get_or_init(Instant::now);
    if splash.ready.load(Ordering::SeqCst) {
        finish(app, reveal.clone());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(MAX_SHOWN);
        finish(&app, reveal);
    });
    Ok(())
}

/// 启动画面还开着没收尾（收尾前主窗口不该自己露面）
pub fn showing(app: &AppHandle) -> bool {
    let splash = app.state::<Splash>();
    splash.opened.get().is_some() && !splash.finished.load(Ordering::SeqCst)
}

/// 主窗口准备好了：动画放够 MIN_SHOWN 后关掉启动画面、调 reveal 显示主窗口。
/// 启动画面还没建好时只记下“已就绪”，由 open 建好后接着收尾；已经收过尾就什么都不做
pub fn finish<F: FnOnce() + Send + 'static>(app: &AppHandle, reveal: F) {
    let splash = app.state::<Splash>();
    splash.ready.store(true, Ordering::SeqCst);
    let Some(opened) = splash.opened.get() else {
        return;
    };
    if splash.finished.swap(true, Ordering::SeqCst) {
        return;
    }
    let wait = remaining(opened.elapsed());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        // 先关启动画面再露出主窗口，两者不叠在一起
        if let Some(window) = app.get_webview_window(LABEL) {
            report(&app, "关启动画面", window.close());
        }
        reveal();
    });
}

/// 已经放了 elapsed，还要等多久才放够
fn remaining(elapsed: Duration) -> Duration {
    MIN_SHOWN.saturating_sub(elapsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_out_the_animation_when_the_page_is_ready_early() {
        assert_eq!(
            remaining(Duration::from_millis(300)),
            Duration::from_millis(1200)
        );
    }

    #[test]
    fn does_not_wait_when_the_page_took_longer_than_the_animation() {
        assert_eq!(remaining(Duration::from_secs(3)), Duration::ZERO);
    }
}
