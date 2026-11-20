// 外壳自带的页面（安装目录 pages\：离线页、启动画面）。用自定义协议 yl 从磁盘读，在 Windows 上的地址是
// http://yl.localhost/<文件名>。只认 pages 目录里直接放着的、类型认识的普通文件（不许 ..、子目录、盘符、
// 符号链接、Windows 设备名），带上 CSP。

use std::path::{Path, PathBuf};

use tauri::http::{header, HeaderValue, Request, Response, StatusCode};
use tauri::Url;

/// 协议名和它在 Windows 上的来源
pub const SCHEME: &str = "yl";
pub const ORIGIN: &str = "http://yl.localhost/";
/// 相对安装目录的位置
pub const DIR: &str = "pages";
/// 离线页、启动画面的文件名
pub const OFFLINE: &str = "index.html";
const SPLASH: &str = "splash.html";
/// 自带页面不放脚本
const CSP: &str = "default-src 'self'; style-src 'self'";

/// 离线页的地址
pub fn offline_url() -> Url {
    url(OFFLINE)
}

/// 启动画面的地址
pub fn splash_url() -> Url {
    url(SPLASH)
}

/// 只由上面两个函数用，name 只会是 OFFLINE、SPLASH 两个常量
#[expect(
    clippy::expect_used,
    reason = "来源和文件名都是这个文件里的常量，拼出来一定是合法网址"
)]
fn url(name: &str) -> Url {
    Url::parse(ORIGIN)
        .and_then(|base| base.join(name))
        .expect("自带页面的地址写错了")
}

/// 请求路径对应 pages 目录里的哪个文件和类型；不是目录里直接放着的、类型不认识的、
/// Windows 设备名（CON、COM1 这类，读它会卡住）返回 None
pub fn file_of(dir: &Path, path: &str) -> Option<(PathBuf, &'static str)> {
    let name = path.strip_prefix('/').unwrap_or(path);
    let plain = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if name.is_empty() || name.starts_with('.') || !plain || is_device(name) {
        return None;
    }
    let kind = match name.rsplit('.').next()? {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => return None,
    };
    Some((dir.join(name), kind))
}

/// Windows 保留的设备名：第一个点之前是 CON、PRN、AUX、NUL、COM0–9、LPT0–9（不分大小写，带不带扩展名都算）
fn is_device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 1 && rest.chars().all(|c| c.is_ascii_digit()))
    };
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT")
}

/// 读 pages 目录里的普通文件；符号链接、目录联接一律不跟（不读到目录外面去）
fn read_plain(file: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(file).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    std::fs::read(file).ok()
}

/// 协议的处理函数：读得到就回文件，否则 404。头部都是常量，拼响应不会出错
pub fn respond(dir: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let found = file_of(dir, request.uri().path())
        .and_then(|(file, kind)| read_plain(&file).map(|body| (body, kind)));
    let Some((body, kind)) = found else {
        let mut missing = Response::new(Vec::new());
        *missing.status_mut() = StatusCode::NOT_FOUND;
        return missing;
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        PathBuf::from(r"C:\Apps\甬勒ERP\pages")
    }

    #[test]
    fn pages_in_the_folder_are_served_with_their_type() {
        assert_eq!(
            file_of(&dir(), "/index.html"),
            Some((dir().join("index.html"), "text/html; charset=utf-8"))
        );
        assert_eq!(
            file_of(&dir(), "/splash.css").map(|f| f.1),
            Some("text/css; charset=utf-8")
        );
    }

    #[test]
    fn nothing_outside_the_folder_or_of_unknown_type_is_served() {
        for path in [
            "/../config/app.json",
            "/..",
            "/sub/index.html",
            "/C:/Windows/win.ini",
            "/",
            "/.hidden.html",
            "/a.exe",
            "/app.json",
        ] {
            assert_eq!(file_of(&dir(), path), None, "{path}");
        }
    }

    #[test]
    fn windows_device_names_are_not_served() {
        for path in [
            "/CON.html",
            "/con.css",
            "/nul.tar.html",
            "/COM1.css",
            "/lpt9.png",
            "/aux",
        ] {
            assert_eq!(file_of(&dir(), path), None, "{path}");
        }
        assert!(file_of(&dir(), "/console.html").is_some());
        assert!(file_of(&dir(), "/com10.css").is_some());
    }

    /// 要能建符号链接：Windows 的开发者模式或管理员身份（GitHub 的 Windows 机器是管理员）
    #[test]
    fn links_inside_the_folder_are_not_followed() {
        let dir = std::env::temp_dir().join(format!("yongle-pages-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real.html"), "<p>x</p>").unwrap();
        std::os::windows::fs::symlink_file(dir.join("real.html"), dir.join("link.html"))
            .expect("建不了符号链接：要开发者模式或管理员身份");
        let get = |path: &str| {
            let request = Request::builder().uri(path).body(Vec::new()).unwrap();
            respond(&dir, &request).status()
        };
        assert_eq!(get("http://yl.localhost/real.html"), StatusCode::OK);
        assert_eq!(get("http://yl.localhost/link.html"), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_real_offline_page_is_found_on_disk() {
        let pages = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(DIR);
        let request = Request::builder()
            .uri("http://yl.localhost/index.html?retry=1")
            .body(Vec::new())
            .unwrap();
        let response = respond(&pages, &request);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_SECURITY_POLICY], CSP);
    }
}
