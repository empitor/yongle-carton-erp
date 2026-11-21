// 安装目录里的 config\app.json：ERP 网址、更新清单地址、更新公钥。核心启动时读一次，交给 Tauri 托管；
// 文件读不到、写错了、多了不认识的键、网址不合规矩，就报出原因、不启动（不猜默认值）。

use std::net::IpAddr;
use std::path::Path;

use tauri::Url;

/// 相对安装目录的位置
pub const FILE: &str = "config/app.json";
const ERP_URL: &str = "erpUrl";
const UPDATE_URL: &str = "updateUrl";
const UPDATE_PUBKEY: &str = "updatePubkey";
const KEYS: [&str; 3] = [ERP_URL, UPDATE_URL, UPDATE_PUBKEY];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfig {
    /// 窗口打开的 ERP 网址
    pub erp_url: Url,
    /// 应用内更新的清单地址和公钥；没配就不检查更新（托盘里也没有“检查更新”）
    pub update: Option<UpdateSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSource {
    /// 版本清单 latest.json 的地址
    pub manifest: Url,
    /// 更新包签名的公钥（tauri signer 生成的 .pub 全文）
    pub pubkey: String,
}

pub fn load(dir: &Path) -> Result<AppConfig, String> {
    let path = dir.join(FILE);
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("读不到 {}：{e}", path.display()))?;
    parse(&text)
}

pub fn parse(text: &str) -> Result<AppConfig, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("{FILE} 不是合法的 JSON：{e}"))?;
    let fields = value
        .as_object()
        .ok_or_else(|| format!("{FILE} 应该是一个对象"))?;
    if let Some(unknown) = fields.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(format!("{FILE} 里有不认识的 {unknown}"));
    }
    let text_of = |key: &str| -> Result<String, String> {
        match fields.get(key) {
            None => Ok(String::new()),
            Some(v) => v
                .as_str()
                .map(|s| s.trim().to_string())
                .ok_or_else(|| format!("{FILE} 的 {key} 应该是文字")),
        }
    };
    let manifest = text_of(UPDATE_URL)?;
    let pubkey = text_of(UPDATE_PUBKEY)?;
    let update = match (manifest.is_empty(), pubkey.is_empty()) {
        (true, true) => None,
        (false, false) => Some(UpdateSource {
            manifest: web_url(UPDATE_URL, &manifest)?,
            pubkey,
        }),
        _ => {
            return Err(format!(
                "{FILE} 的 {UPDATE_URL} 和 {UPDATE_PUBKEY} 要么都填，要么都空着"
            ))
        }
    };
    Ok(AppConfig {
        erp_url: web_url(ERP_URL, &text_of(ERP_URL)?)?,
        update,
    })
}

/// 网址只收 https；本机测试用的回环地址（127.0.0.1、localhost、[::1]）也可以用 http
fn web_url(key: &str, text: &str) -> Result<Url, String> {
    let url = Url::parse(text).map_err(|_| format!("{FILE} 的 {key} 不是网址：{text}"))?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    match url.scheme() {
        "https" if url.host_str().is_some() => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err(format!(
            "{FILE} 的 {key} 必须是 https 网址（本机测试可以用 http://127.0.0.1）：{text}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_config_opens_the_formal_address_and_checks_the_formal_manifest() {
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let config = load(&shipped).unwrap();
        assert_eq!(config.erp_url.as_str(), "https://erp.nbyongle.cn/");
        let update = config.update.unwrap();
        assert_eq!(
            update.manifest.as_str(),
            "https://erp.nbyongle.cn/app-update/windows/latest.json"
        );
        assert!(!update.pubkey.is_empty());
    }

    #[test]
    fn all_three_fields_are_read() {
        let config = parse(r#"{ "erpUrl": "http://127.0.0.1:3198/", "updateUrl": "http://127.0.0.1:8789/latest.json", "updatePubkey": "abc" }"#).unwrap();
        assert_eq!(config.erp_url.as_str(), "http://127.0.0.1:3198/");
        let update = config.update.unwrap();
        assert_eq!(
            update.manifest.as_str(),
            "http://127.0.0.1:8789/latest.json"
        );
        assert_eq!(update.pubkey, "abc");
    }

    #[test]
    fn plain_http_is_only_accepted_on_this_computer() {
        for ok in [
            "https://erp.nbyongle.cn/",
            "http://127.0.0.1:8788/",
            "http://localhost:3198/",
            "http://[::1]:3198/",
        ] {
            assert!(web_url(ERP_URL, ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://erp.nbyongle.cn/",
            "http://127.0.0.1.example.invalid/",
            "file:///C:/erp.html",
            "ftp://127.0.0.1/",
            "不是网址",
        ] {
            assert!(web_url(ERP_URL, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_missing_erp_address_is_refused() {
        assert!(parse("{}").is_err());
    }

    #[test]
    fn a_bad_update_address_or_a_missing_half_is_refused_at_start() {
        let erp = r#""erpUrl": "https://erp.nbyongle.cn/""#;
        assert!(parse(&format!(
            r#"{{ {erp}, "updateUrl": "ftp://x/latest.json", "updatePubkey": "k" }}"#
        ))
        .is_err());
        assert!(parse(&format!(
            r#"{{ {erp}, "updateUrl": "https://x/latest.json" }}"#
        ))
        .is_err());
        assert!(parse(&format!(r#"{{ {erp}, "updatePubkey": "k" }}"#)).is_err());
    }

    #[test]
    fn typos_and_wrong_shapes_are_refused() {
        assert!(parse(r#"{ "erpUrl": "https://erp.nbyongle.cn/", "updateURL": "" }"#).is_err());
        assert!(parse(r#"{ "erpUrl": 1 }"#).is_err());
        assert!(parse("[]").is_err());
        assert!(parse("不是 JSON").is_err());
    }
}
