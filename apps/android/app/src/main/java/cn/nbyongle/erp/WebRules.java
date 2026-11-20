package cn.nbyongle.erp;

import android.webkit.WebViewClient;
import java.net.MalformedURLException;
import java.net.URL;

/**
 * 网页的纯规则：一个网址留在应用里、交给浏览器还是不打开；主框架加载失败、网关错误算不算连不上；渲染进程没了之后怎么办；
 * ERP 来源怎么写；User-Agent 末尾的 App 标记。只引 JDK 和 WebViewClient 的错误码常量（编译时就写进来了），JVM 里能直接测。
 */
final class WebRules {
    /** 一个网址在外壳里怎么处理 */
    enum Route { INSIDE, BROWSER, BLOCK }

    /** 网页渲染进程没了、换上新 WebView 之后：重开刚才的页面、盖离线页让人点“重试”、等窗口看得见了再开 */
    enum AfterGone { REOPEN, OFFLINE, LATER }

    /** User-Agent 末尾的标记：网页凭它知道自己在安卓 App 里（别的网页改不了 ERP 页面的这个值） */
    static final String APP_MARK = " YongleErpAndroid/";

    private WebRules() {
    }

    /** 站内（协议、主机、端口都和 ERP 网址相同）留在应用里；别的 http(s) 网站交给浏览器；其余协议不打开 */
    static Route routeOf(String url, String home) {
        URL target = parse(url);
        URL base = parse(home);
        if (target == null || base == null || !isWeb(target)) return Route.BLOCK;
        return sameOrigin(target, base) ? Route.INSIDE : Route.BROWSER;
    }

    /** 主框架加载失败时盖不盖离线页：连接重置、空响应等 WebView 多报成 ERROR_UNKNOWN，只排除协议不支持、网址写错 */
    static boolean isConnectionFailure(int errorCode) {
        return errorCode != WebViewClient.ERROR_UNSUPPORTED_SCHEME && errorCode != WebViewClient.ERROR_BAD_URL;
    }

    /** 网关回“服务暂不可用”（ERP 没在运行）也按连不上处理 */
    static boolean isUnavailable(int status) {
        return status == 502 || status == 503 || status == 504;
    }

    /**
     * 渲染进程没了之后怎么办。窗口看不见（应用在后台）时没了，多半是系统收回内存，跟页面无关，也不该马上把内存占回去：
     * 等窗口看得见了再开（LATER，那次补开不算“自动重开”）。窗口看得见时没了：reopenedPageAgain 表示外壳刚自动重开过的
     * 那一页（之后没去过别的页）又没了，多半是这一页自己把它弄崩的（不管它加载要多久），盖离线页让人点“重试”（回 ERP
     * 首页），不再自动重开，免得一直白屏重来；否则重开刚才的页面。
     */
    static AfterGone afterRendererGone(boolean visible, boolean reopenedPageAgain) {
        if (!visible) return AfterGone.LATER;
        return reopenedPageAgain ? AfterGone.OFFLINE : AfterGone.REOPEN;
    }

    /** 是不是系统下载器取得到的 http(s) 网址 */
    static boolean isWeb(String url) {
        URL parsed = parse(url);
        return parsed != null && isWeb(parsed);
    }

    /** 网址的来源（协议://主机[:端口]），接通消息只投给这个来源；认不出返回 null */
    static String originOf(String url) {
        URL parsed = parse(url);
        return parsed == null ? null : parsed.getProtocol() + "://" + parsed.getAuthority();
    }

    /** 用宽松的 java.net.URL 解析：网址里带中文也认得出协议、主机和端口；认不出返回 null */
    @SuppressWarnings("deprecation")
    private static URL parse(String url) {
        try {
            return new URL(url);
        } catch (MalformedURLException e) {
            return null;
        }
    }

    private static boolean isWeb(URL url) {
        return ("http".equalsIgnoreCase(url.getProtocol()) || "https".equalsIgnoreCase(url.getProtocol())) && !url.getHost().isEmpty();
    }

    private static boolean sameOrigin(URL a, URL b) {
        return a.getProtocol().equalsIgnoreCase(b.getProtocol()) && a.getHost().equalsIgnoreCase(b.getHost()) && portOf(a) == portOf(b);
    }

    private static int portOf(URL url) {
        return url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
    }
}
