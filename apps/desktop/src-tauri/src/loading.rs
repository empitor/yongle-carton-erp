// 主页面加载的结果：给主窗口的 WebView2 挂“导航完成”事件，按结果决定接下来去哪（纯函数 outcome、next）。
// 连不上（连接失败、被拒、域名解析失败、超时、证书错误、网关报错 502–504）就切到离线页，
// ERP 页面好了就让启动画面收尾。
// 走系统代理上网的电脑也照常：加载完全交给 WebView2，外壳不自己去连。
// 这个事件只报主页面（子框架另有事件，不挂）。被取消的导航（外壳拦下交给浏览器的站外链接、被新导航顶掉的）
// 和变成下载的导航，WebView2 也报“没成功”，它们不算连不上；外壳自带页面（离线页）的结果一律不管，免得来回跳。
// 本机 WebView2 157 实测：连接被拒报 UNKNOWN（0）且没有 HTTP 回应，变成下载报 CONNECTION_ABORTED（9），
// 外壳拦下的站外链接报 OPERATION_CANCELED（14）。网页弹出的新窗口也挂这个事件（popup.rs）。

use tauri::{AppHandle, Manager, Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{take_pwstr, NavigationCompletedEventHandler};
use windows_core::{Interface, BOOL, PWSTR};

use crate::report::{note, report};
use crate::route::{route, Route};

/// 一定算“连不上”的错误
const UNREACHABLE: [COREWEBVIEW2_WEB_ERROR_STATUS; 11] = [
    COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT,
    COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE,
    COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET,
    COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED,
    COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED,
    COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED,
    COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID,
];
/// 没有 HTTP 回应（网络错误，或者运行库太旧拿不到状态码）
const NO_RESPONSE: i32 = 0;
/// 网关报错（服务器在升级重启、后面的程序还没起来）：整页打开拿到 502、503、504 也算连不上。
/// 页面里的接口请求不走这个事件，拿到 502 不会切页
const GATEWAY: [i32; 3] = [502, 503, 504];
/// 太常见、不记日志的“没成功”：被取消（外壳拦下的站外链接这类）、变成下载
const QUIET: [COREWEBVIEW2_WEB_ERROR_STATUS; 2] = [
    COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
    COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED,
];

/// 一次主页面导航的结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Loaded,
    Unreachable,
    /// 别的失败（被取消、变成下载、要登录凭据、服务器回了错误页）：不切离线页
    Other,
}

/// 导航完了之后接下来做什么
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    /// ERP 页面好了：启动画面可以收尾
    Ready,
    /// 连不上：切到离线页，启动画面也收尾
    Offline,
    /// 停在了不该停的地方（导航规则没拦住的网址）：回 ERP 首页
    Home,
    /// 什么都不做
    Stay,
}

/// 导航完成事件给的三样（成没成、错误码、HTTP 状态码）归成一种结果
pub fn outcome(success: bool, status: COREWEBVIEW2_WEB_ERROR_STATUS, http: i32) -> Outcome {
    let refused = status == COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN && http == NO_RESPONSE;
    if GATEWAY.contains(&http) {
        Outcome::Unreachable
    } else if success {
        Outcome::Loaded
    } else if UNREACHABLE.contains(&status) || refused {
        Outcome::Unreachable
    } else {
        Outcome::Other
    }
}

/// 主页面停在 url（解析不了是 None）、结果是 outcome 时，接下来做什么
pub fn next(url: Option<&Url>, home: &Url, outcome: Outcome) -> Next {
    let place = url.map(|url| route(url, home));
    match (place, outcome) {
        (_, Outcome::Other) => Next::Stay,
        (Some(Route::Local | Route::Retry), _) => Next::Stay,
        (Some(Route::Inside), Outcome::Loaded) => Next::Ready,
        (_, Outcome::Unreachable) => Next::Offline,
        (Some(Route::Browser | Route::Block) | None, Outcome::Loaded) => Next::Home,
    }
}

/// 给窗口的 WebView2 挂“导航完成”事件，每次主页面导航完了调 done（网址、结果）。
/// 在主线程上调时立刻挂上（建好主窗口后马上调，赶在第一次导航完成之前）
pub fn watch<F>(window: &WebviewWindow, done: F) -> tauri::Result<()>
where
    F: Fn(Option<Url>, Outcome) + Send + 'static,
{
    let app = window.app_handle().clone();
    window.with_webview(move |webview| {
        let result = attach(&webview.controller(), app.clone(), done);
        report(&app, "挂上加载结果事件", result);
    })
}

fn attach<F>(
    controller: &ICoreWebView2Controller,
    app: AppHandle,
    done: F,
) -> windows_core::Result<()>
where
    F: Fn(Option<Url>, Outcome) + 'static,
{
    let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else {
            return Ok(());
        };
        let (uri, success, status, http) = read(&sender, &args)?;
        let result = outcome(success, status, http);
        let url = Url::parse(&uri).ok();
        if !success && !QUIET.contains(&status) {
            let code = status.0;
            let place = url
                .as_ref()
                .map_or_else(|| "（网址解析不了）".into(), brief);
            note(
                &app,
                &format!(
                    "页面没加载成功（错误码 {code}，HTTP {http}，按 {result:?} 处理）：{place}"
                ),
            );
        }
        done(url, result);
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: controller 是 Tauri 交来的、活着的 WebView2；事件处理器由 COM 引用计数管着
    unsafe {
        controller
            .CoreWebView2()?
            .add_NavigationCompleted(&handler, &mut token)
    }
}

/// 记日志用的网址：只留来源和路径，不带查询串和 # 后面（可能有客户名这类搜索词）
fn brief(url: &Url) -> String {
    let mut short = url.clone();
    short.set_query(None);
    short.set_fragment(None);
    short.to_string()
}

/// 读出这次导航的网址、成没成、错误码、HTTP 状态码
fn read(
    sender: &ICoreWebView2,
    args: &ICoreWebView2NavigationCompletedEventArgs,
) -> windows_core::Result<(String, bool, COREWEBVIEW2_WEB_ERROR_STATUS, i32)> {
    let mut uri = PWSTR::null();
    let mut success = BOOL::default();
    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
    let mut http = NO_RESPONSE;
    // SAFETY: 出参都是这里的局部变量，调用期间有效；网址的内存交给 take_pwstr 释放
    unsafe {
        sender.Source(&mut uri)?;
        args.IsSuccess(&mut success)?;
        args.WebErrorStatus(&mut status)?;
        // 状态码在第二版的参数接口里（太旧的运行库没有）；拿不到就按没收到回应算
        if let Ok(args2) = args.cast::<ICoreWebView2NavigationCompletedEventArgs2>() {
            args2.HttpStatusCode(&mut http)?;
        }
    }
    Ok((take_pwstr(uri), success.as_bool(), status, http))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages;

    fn home() -> Url {
        Url::parse("https://erp.nbyongle.cn/").unwrap()
    }

    fn next_at(text: &str, outcome: Outcome) -> Next {
        next(Url::parse(text).ok().as_ref(), &home(), outcome)
    }

    #[test]
    fn connection_failures_refusals_and_certificate_errors_count_as_unreachable() {
        for status in UNREACHABLE {
            assert_eq!(
                outcome(false, status, 0),
                Outcome::Unreachable,
                "{status:?}"
            );
        }
        assert_eq!(
            outcome(false, COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN, 0),
            Outcome::Unreachable
        );
    }

    #[test]
    fn cancels_downloads_and_server_error_pages_do_not() {
        assert_eq!(
            outcome(true, COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN, 200),
            Outcome::Loaded
        );
        for (status, http) in [
            (COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED, 0),
            (COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED, 0),
            (
                COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED,
                401,
            ),
            (COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN, 404),
            (COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN, 500),
        ] {
            assert_eq!(
                outcome(false, status, http),
                Outcome::Other,
                "{status:?} {http}"
            );
        }
    }

    #[test]
    fn gateway_errors_on_the_whole_page_count_as_unreachable() {
        for http in [502, 503, 504] {
            for success in [false, true] {
                assert_eq!(
                    outcome(success, COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN, http),
                    Outcome::Unreachable,
                    "{http} {success}"
                );
            }
            assert_eq!(
                next_at(
                    "https://erp.nbyongle.cn/",
                    outcome(false, COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN, http)
                ),
                Next::Offline
            );
        }
    }

    #[test]
    fn a_loaded_erp_page_lets_the_splash_finish() {
        assert_eq!(
            next_at("https://erp.nbyongle.cn/#orders", Outcome::Loaded),
            Next::Ready
        );
    }

    #[test]
    fn an_unreachable_erp_page_switches_to_the_offline_page() {
        assert_eq!(
            next_at("https://erp.nbyongle.cn/", Outcome::Unreachable),
            Next::Offline
        );
    }

    #[test]
    fn cancelled_links_and_downloads_keep_the_erp_page() {
        assert_eq!(
            next_at("https://erp.nbyongle.cn/#orders", Outcome::Other),
            Next::Stay
        );
        assert_eq!(next_at("https://example.com/", Outcome::Other), Next::Stay);
    }

    #[test]
    fn the_shells_own_pages_never_trigger_another_switch() {
        let offline = pages::offline_url();
        for outcome in [Outcome::Loaded, Outcome::Unreachable, Outcome::Other] {
            assert_eq!(next(Some(&offline), &home(), outcome), Next::Stay);
        }
        assert_eq!(
            next_at(
                "http://yl.localhost/index.html?retry=1",
                Outcome::Unreachable
            ),
            Next::Stay
        );
    }

    #[test]
    fn a_page_the_rules_should_have_stopped_goes_back_home() {
        assert_eq!(next_at("https://example.com/", Outcome::Loaded), Next::Home);
        assert_eq!(next_at("file:///C:/a.html", Outcome::Loaded), Next::Home);
        assert_eq!(next(None, &home(), Outcome::Loaded), Next::Home);
        assert_eq!(next(None, &home(), Outcome::Unreachable), Next::Offline);
    }

    #[test]
    fn the_log_keeps_only_origin_and_path() {
        let url = Url::parse("https://erp.nbyongle.cn/orders?q=某客户#detail=12").unwrap();
        assert_eq!(brief(&url), "https://erp.nbyongle.cn/orders");
    }
}
