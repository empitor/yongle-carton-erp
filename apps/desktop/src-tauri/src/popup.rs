// 网页弹出的新窗口收尾：WebView2 只关掉网页那一层、留下 Tauri 的空窗口，所以外壳自己关整个窗口——
// 网页自己 window.close() 时；一页都没显示过、只是用来下载（原件是 Excel、Word 这类）的窗口，下载有了结果时。
// 下载进行中、被人暂停时不关（关了会把下载断掉），这时窗口里是 WebView2 的下载提示；
// 没下下来就先告诉人原因再关（窗口一关，窗口里的下载提示也跟着没了）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    DownloadStartingEventHandler, StateChangedEventHandler, WindowCloseRequestedEventHandler,
};
use windows_core::Interface;

use crate::loading::{self, Outcome};
use crate::notice::{self, Kind};
use crate::report::{note, report};
use crate::route::BLANK;

/// 一次下载的状态变了之后，只用来下载的新窗口怎么办
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    /// 还在下，或者被人暂停了：窗口留着
    Keep,
    /// 下完了、被人取消了、程序在关：关窗口
    Close,
    /// 没下下来：告诉人原因，再关窗口
    Failed(&'static str),
}

/// 这次导航显示出了一页（不算打开时先落的空白页）
fn shows_page(url: Option<&Url>, outcome: Outcome) -> bool {
    outcome == Outcome::Loaded && url.is_some_and(|url| url.as_str() != BLANK)
}

/// 下载的状态和中断原因 → 关不关窗口、要不要告诉人
fn ending(
    state: COREWEBVIEW2_DOWNLOAD_STATE,
    reason: COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON,
) -> Ending {
    if state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
        return Ending::Keep;
    }
    if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
        return Ending::Close;
    }
    match reason {
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_PAUSED => Ending::Keep,
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED
        | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN => Ending::Close,
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_FAILED
        | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT
        | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED
        | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_SERVER_DOWN => {
            Ending::Failed("网络断了或连不上服务器")
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE => Ending::Failed("磁盘空间不够"),
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED_BY_POLICY
        | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_MALICIOUS
        | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_SECURITY_CHECK_FAILED => {
            Ending::Failed("被系统的安全检查拦下了")
        }
        _ => Ending::Failed("下载中断了"),
    }
}

/// 给刚建好的新窗口挂上收尾的事件
pub fn watch(popup: &WebviewWindow) -> tauri::Result<()> {
    let shown = Arc::new(AtomicBool::new(false));
    let seen = shown.clone();
    loading::watch(popup, move |url, outcome| {
        if shows_page(url.as_ref(), outcome) {
            seen.store(true, Ordering::Relaxed);
        }
    })?;
    let closing = popup.clone();
    let app = popup.app_handle().clone();
    popup.with_webview(move |webview| {
        // SAFETY: controller 是 Tauri 交来的、活着的 WebView2
        let core = unsafe { webview.controller().CoreWebView2() };
        let result = core.and_then(|core| {
            on_close_request(&core, closing.clone())?;
            on_download(&core, closing, shown)
        });
        report(&app, "挂上新窗口的收尾事件", result);
    })
}

fn on_close_request(core: &ICoreWebView2, popup: WebviewWindow) -> windows_core::Result<()> {
    let handler = WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
        close_later(&popup);
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: core 是活着的 WebView2；事件处理器由 COM 引用计数管着
    unsafe { core.add_WindowCloseRequested(&handler, &mut token) }
}

fn on_download(
    core: &ICoreWebView2,
    popup: WebviewWindow,
    shown: Arc<AtomicBool>,
) -> windows_core::Result<()> {
    let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let popup = popup.clone();
        let shown = shown.clone();
        // SAFETY: args 是这次事件给的、活着的参数
        let download = unsafe { args.DownloadOperation()? };
        when_changed(&download, move |ending| {
            settle(&popup, shown.load(Ordering::Relaxed), ending)
        })
    }));
    let mut token = 0;
    // SAFETY: core 是活着的 WebView2；下载事件在第四版接口 ICoreWebView2_4 上
    unsafe {
        core.cast::<ICoreWebView2_4>()?
            .add_DownloadStarting(&handler, &mut token)
    }
}

/// 下载有了结果：没下下来的都记日志；只用来下载的窗口（shown 为假）按结果关掉，没下下来先告诉人
fn settle(popup: &WebviewWindow, shown: bool, ending: Ending) {
    let app: &AppHandle = popup.app_handle();
    match ending {
        Ending::Keep => {}
        Ending::Close if !shown => close_later(popup),
        Ending::Close => {}
        Ending::Failed(why) => {
            note(app, &format!("新窗口里的下载没完成：{why}"));
            if !shown {
                notice::tell_later(format!("文件没下载下来：{why}。请重试。"), Kind::Warning);
                close_later(popup);
            }
        }
    }
}

/// 一次下载的状态每变一次，按状态和中断原因调一次 done
fn when_changed<F: Fn(Ending) + 'static>(
    download: &ICoreWebView2DownloadOperation,
    done: F,
) -> windows_core::Result<()> {
    let handler = StateChangedEventHandler::create(Box::new(move |operation, _| {
        let Some(operation) = operation else {
            return Ok(());
        };
        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
        let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
        // SAFETY: 出参是局部变量
        unsafe {
            operation.State(&mut state)?;
            operation.InterruptReason(&mut reason)?;
        }
        done(ending(state, reason));
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: download 是活着的下载；事件处理器由 COM 引用计数管着
    unsafe { download.add_StateChanged(&handler, &mut token) }
}

/// 关窗口。从新线程发出去，排到当前这个 WebView2 事件处理完之后
fn close_later(window: &WebviewWindow) {
    let window = window.clone();
    std::thread::spawn(move || report(window.app_handle(), "关新窗口", window.close()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_page_counts_as_shown() {
        let blank = Url::parse(BLANK).ok();
        let page = Url::parse("https://erp.nbyongle.cn/api/flow/sources/3/file").ok();
        assert!(!shows_page(blank.as_ref(), Outcome::Loaded));
        assert!(!shows_page(page.as_ref(), Outcome::Other));
        assert!(shows_page(page.as_ref(), Outcome::Loaded));
    }

    #[test]
    fn running_and_paused_downloads_keep_the_window() {
        let none = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
        let paused = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_PAUSED;
        let interrupted = COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED;
        assert_eq!(
            ending(COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS, none),
            Ending::Keep
        );
        assert_eq!(ending(interrupted, paused), Ending::Keep);
    }

    #[test]
    fn finished_or_cancelled_downloads_close_it_quietly() {
        let interrupted = COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED;
        assert_eq!(
            ending(
                COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
                COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE
            ),
            Ending::Close
        );
        for reason in [
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN,
        ] {
            assert_eq!(ending(interrupted, reason), Ending::Close, "{reason:?}");
        }
    }

    #[test]
    fn failed_downloads_tell_why_before_closing() {
        let interrupted = COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED;
        assert_eq!(
            ending(
                interrupted,
                COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED
            ),
            Ending::Failed("网络断了或连不上服务器")
        );
        assert_eq!(
            ending(
                interrupted,
                COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE
            ),
            Ending::Failed("磁盘空间不够")
        );
        assert_eq!(
            ending(
                interrupted,
                COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FAILED
            ),
            Ending::Failed("下载中断了")
        );
    }
}
