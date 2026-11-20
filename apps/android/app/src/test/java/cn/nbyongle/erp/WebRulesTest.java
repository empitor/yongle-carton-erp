package cn.nbyongle.erp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.webkit.WebViewClient;
import java.util.regex.Pattern;
import org.junit.Test;

/** 网址放不放行、哪些加载失败算“连不上”、ERP 来源怎么写 */
public class WebRulesTest {
    private static final String HOME = "https://erp.nbyongle.cn/";

    private static WebRules.Route route(String url) {
        return WebRules.routeOf(url, HOME);
    }

    @Test
    public void sameOriginPagesStayInTheApp() {
        assertEquals(WebRules.Route.INSIDE, route("https://erp.nbyongle.cn/#orders?order=12"));
        assertEquals(WebRules.Route.INSIDE, route("https://ERP.nbyongle.cn:443/api/flow/sources/3/file"));
        assertEquals(WebRules.Route.INSIDE, route("https://erp.nbyongle.cn/#orders?q=纸箱 外箱"));
    }

    @Test
    public void otherSitesOpenInTheSystemBrowser() {
        assertEquals(WebRules.Route.BROWSER, route("https://platform.deepseek.com/api_keys"));
        assertEquals(WebRules.Route.BROWSER, route("http://erp.nbyongle.cn/"));
        assertEquals(WebRules.Route.BROWSER, route("https://erp.nbyongle.cn:8443/"));
        assertEquals(WebRules.Route.BROWSER, route("https://www.erp.nbyongle.cn/"));
        assertEquals(WebRules.Route.BROWSER, route("https://erp.nbyongle.cn@example.com/"));
    }

    @Test
    public void nonWebAddressesAreNotOpened() {
        assertEquals(WebRules.Route.BLOCK, route("javascript:alert(1)"));
        assertEquals(WebRules.Route.BLOCK, route("intent://scan/#Intent;scheme=zxing;end"));
        assertEquals(WebRules.Route.BLOCK, route("file:///sdcard/Download/a.txt"));
        assertEquals(WebRules.Route.BLOCK, route("blob:https://erp.nbyongle.cn/0b6c"));
        assertEquals(WebRules.Route.BLOCK, route("mailto:someone@example.com"));
        assertEquals(WebRules.Route.BLOCK, route("不是网址"));
    }

    @Test
    public void testBuildAddressOnLoopbackIsItsOwnOrigin() {
        String test = "http://127.0.0.1:8787/";
        assertEquals(WebRules.Route.INSIDE, WebRules.routeOf("http://127.0.0.1:8787/page2.html", test));
        assertEquals(WebRules.Route.BROWSER, WebRules.routeOf("http://localhost:8787/external.html", test));
    }

    @Test
    public void networkFailuresShowTheOfflineScreen() {
        assertTrue(WebRules.isConnectionFailure(WebViewClient.ERROR_HOST_LOOKUP));
        assertTrue(WebRules.isConnectionFailure(WebViewClient.ERROR_CONNECT));
        assertTrue(WebRules.isConnectionFailure(WebViewClient.ERROR_TIMEOUT));
        assertTrue(WebRules.isConnectionFailure(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE));
    }

    /** 真机上服务停掉时 WebView 报的是 net::ERR_EMPTY_RESPONSE，错误码归到 ERROR_UNKNOWN */
    @Test
    public void emptyOrResetResponsesAlsoShowTheOfflineScreen() {
        assertTrue(WebRules.isConnectionFailure(WebViewClient.ERROR_UNKNOWN));
    }

    @Test
    public void addressProblemsDoNotCoverThePage() {
        assertFalse(WebRules.isConnectionFailure(WebViewClient.ERROR_UNSUPPORTED_SCHEME));
        assertFalse(WebRules.isConnectionFailure(WebViewClient.ERROR_BAD_URL));
    }

    @Test
    public void onlyGatewayErrorsCountAsUnavailable() {
        assertTrue(WebRules.isUnavailable(502));
        assertTrue(WebRules.isUnavailable(503));
        assertTrue(WebRules.isUnavailable(504));
        assertFalse(WebRules.isUnavailable(404));
        assertFalse(WebRules.isUnavailable(500));
        assertFalse(WebRules.isUnavailable(200));
    }

    @Test
    public void rendererGoneOnARegularPageReopensIt() {
        assertEquals(WebRules.AfterGone.REOPEN, WebRules.afterRendererGone(true, false));
    }

    /**
     * 窗口看得见时，自动重开的那一页（之后没去过别的页）又没了（崩溃或低内存回收都一样）：不再自动重开，免得一直白屏重来。
     * 只看是不是同一页，不看隔了多久——加载要十几秒才崩的页面也挡得住。
     */
    @Test
    public void reopenedPageGoneAgainWhileVisibleShowsTheOfflineScreen() {
        assertEquals(WebRules.AfterGone.OFFLINE, WebRules.afterRendererGone(true, true));
    }

    /** 在后台（窗口看不见）时没了：跟页面无关，不算“又弄崩了”，等窗口看得见了再开，不马上把内存占回去 */
    @Test
    public void rendererGoneInTheBackgroundWaitsUntilVisible() {
        assertEquals(WebRules.AfterGone.LATER, WebRules.afterRendererGone(false, false));
        assertEquals(WebRules.AfterGone.LATER, WebRules.afterRendererGone(false, true));
    }

    @Test
    public void downloadsOnlyGoToTheSystemForHttpAddresses() {
        assertTrue(WebRules.isWeb("https://erp.nbyongle.cn/api/export.xlsx"));
        assertFalse(WebRules.isWeb("blob:https://erp.nbyongle.cn/0b6c"));
        assertFalse(WebRules.isWeb("data:text/plain,abc"));
    }

    @Test
    public void originKeepsAnExplicitPort() {
        assertEquals("http://127.0.0.1:3198", WebRules.originOf("http://127.0.0.1:3198/"));
    }

    /** 网页按这条正则认 App 标记（ERP 的 src/app-bridge.ts）：版本名带空格、+ 这类字符时网页认不出、通道接不通 */
    @Test
    public void versionNameMatchesTheMarkThePageLooksFor() {
        String userAgent = "Mozilla/5.0 (Linux; Android 16) Chrome/156.0" + WebRules.APP_MARK + BuildConfig.VERSION_NAME;
        assertTrue(Pattern.compile(" YongleErpAndroid/[\\w.-]+$").matcher(userAgent).find());
    }

    @Test
    public void originWithoutPortHasNone() {
        assertEquals("https://erp.nbyongle.cn", WebRules.originOf("https://erp.nbyongle.cn/#today"));
        assertNull(WebRules.originOf("不是网址"));
    }
}
