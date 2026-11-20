// 网址分流的规则（纯函数）：一个网址在外壳里留在窗口、交给系统浏览器、还是不打开。

use tauri::Url;

use crate::pages;

/// 离线页“重试”链接带的查询串：外壳拦下它，重新加载 ERP
pub const RETRY_QUERY: &str = "retry=1";
/// window.open 打开新窗口时先落在空白页，再由网页自己导航
pub const BLANK: &str = "about:blank";

/// 一个网址在外壳里怎么处理
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// ERP 站内（协议、主机、端口相同）
    Inside,
    /// 外壳自带的页面（离线页、启动画面）
    Local,
    /// 离线页上点了“重试”
    Retry,
    /// 别的网站：交给系统浏览器
    Browser,
    /// 别的协议：不打开
    Block,
}

pub fn route(target: &Url, home: &Url) -> Route {
    let web = matches!(target.scheme(), "http" | "https");
    // blob: 网址的来源就是它里面那个网址的来源：ERP 页面自己生成的 blob（预览 PDF、图片）算站内
    let same_origin = target.origin() == home.origin();
    if (web || target.scheme() == "blob") && same_origin {
        Route::Inside
    } else if target.as_str().starts_with(pages::ORIGIN) {
        if target.query() == Some(RETRY_QUERY) {
            Route::Retry
        } else {
            Route::Local
        }
    } else if web {
        Route::Browser
    } else if target.as_str() == BLANK {
        Route::Inside
    } else {
        Route::Block
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn route_of(text: &str) -> Route {
        route(&url(text), &url("https://erp.nbyongle.cn/"))
    }

    #[test]
    fn same_origin_pages_stay_in_the_window() {
        assert_eq!(
            route_of("https://erp.nbyongle.cn/#orders?order=12"),
            Route::Inside
        );
        assert_eq!(
            route_of("https://ERP.nbyongle.cn:443/api/flow/sources/3/file"),
            Route::Inside
        );
        assert_eq!(
            route_of("https://erp.nbyongle.cn/#orders?q=纸箱"),
            Route::Inside
        );
    }

    #[test]
    fn other_sites_open_in_the_system_browser() {
        assert_eq!(
            route_of("https://platform.deepseek.com/api_keys"),
            Route::Browser
        );
        assert_eq!(route_of("http://erp.nbyongle.cn/"), Route::Browser);
        assert_eq!(route_of("https://erp.nbyongle.cn:8443/"), Route::Browser);
        assert_eq!(
            route_of("https://erp.nbyongle.cn@example.com/"),
            Route::Browser
        );
    }

    #[test]
    fn other_schemes_are_not_opened() {
        assert_eq!(route_of("javascript:alert(1)"), Route::Block);
        assert_eq!(route_of("file:///C:/Windows/win.ini"), Route::Block);
        assert_eq!(route_of("mailto:someone@example.com"), Route::Block);
        assert_eq!(route_of("ms-settings:"), Route::Block);
        assert_eq!(route_of("data:text/html,hi"), Route::Block);
    }

    #[test]
    fn blobs_made_by_the_erp_page_stay_in_the_window() {
        assert_eq!(
            route_of("blob:https://erp.nbyongle.cn/0b8e3c1a-1c2d-4e5f-8a9b-0c1d2e3f4a5b"),
            Route::Inside
        );
        assert_eq!(
            route_of("blob:https://example.com/0b8e3c1a-1c2d-4e5f-8a9b-0c1d2e3f4a5b"),
            Route::Block
        );
    }

    #[test]
    fn offline_page_and_its_retry_link_are_recognised() {
        assert_eq!(route_of(pages::offline_url().as_str()), Route::Local);
        assert_eq!(route_of(pages::splash_url().as_str()), Route::Local);
        assert_eq!(
            route_of("http://yl.localhost/index.html?retry=1"),
            Route::Retry
        );
    }

    #[test]
    fn the_offline_page_retry_link_is_the_one_the_shell_intercepts() {
        let page = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(pages::DIR)
            .join(pages::OFFLINE);
        let html = std::fs::read_to_string(page).unwrap();
        let href = html.split("class=\"retry\" href=\"").nth(1).unwrap();
        let link = pages::offline_url()
            .join(&href[..href.find('"').unwrap()])
            .unwrap();
        assert_eq!(route_of(link.as_str()), Route::Retry);
    }
}
