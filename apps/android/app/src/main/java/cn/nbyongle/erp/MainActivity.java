package cn.nbyongle.erp;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;
import java.util.Objects;
import org.json.JSONObject;

/**
 * 安卓外壳的入口：生命周期、装配各件、网页设置、网页加载各时机（ShellClient）、站外交给浏览器、下载、重试，
 * 把通道上网页的话分给各件。各件管什么见 docs/架构说明.md“目录”。
 */
public final class MainActivity extends Activity {
    private WebView web;
    /** 离线页（盖在网页上的“暂时无法连接 ERP”） */
    private View offline;
    /** ERP 页面加载完过（启动画面等它）；窗口看不见（onStop 到 onStart 之间）；渲染进程没了、等窗口看得见再重开 */
    private boolean pageShown, stopped, reopenOnStart;
    /** 最近一次停在的站内网址：网页渲染进程没了、换新 WebView 时重新打开它 */
    private String lastInsideUrl;
    /** 窗口看得见时渲染进程没了、外壳自动重开的那一页；之后去了别的页、或渲染进程又没了（已按它判过）就清掉（null） */
    private String reopenedUrl;
    private FileChooser files;
    private ShareInbox shares;
    private FileSaver saver;
    private AppUpdater updater;
    private LaunchScreen launch;
    private SystemBars bars;
    private BridgeChannel bridge;
    private final BackKey back = new BackKey();

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_main);
        web = findViewById(R.id.web);
        offline = findViewById(R.id.offline);
        findViewById(R.id.retry).setOnClickListener(v -> retry());
        bars = new SystemBars(this);
        bars.start(getColor(R.color.splash_background));
        launch = new LaunchScreen(findViewById(R.id.launch), findViewById(R.id.launch_logo), () -> pageShown || offline.getVisibility() == View.VISIBLE);
        if (saved == null) launch.arm();
        else launch.skip();
        registerBack();
        files = new FileChooser(this);
        shares = new ShareInbox(this);
        saver = new FileSaver(this);
        updater = new AppUpdater(this, BuildConfig.UPDATE_URL, BuildConfig.VERSION_CODE);
        configureWeb();
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(BuildConfig.ERP_URL);
        shares.restore();
        // 进程被系统收回后恢复时 getIntent() 还是当初那次分享：没交完的由 restore 接着交，这里只在全新启动时收、查更新
        if (saved != null) return;
        shares.accept(getIntent());
        updater.check();
    }

    /** 应用已经开着时又被“分享”“用其他应用打开”叫起（launchMode=singleTask） */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        shares.accept(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FileChooser.REQUEST_CODE) files.onResult(resultCode, data);
        else super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onStart() {
        super.onStart();
        stopped = false;
        bars.resume();
        if (!reopenOnStart) return;
        // 在后台被收回后补开：不记“自动重开过”，跟页面无关的回收不算这一页把渲染进程弄崩
        reopenOnStart = false;
        web.loadUrl(pageToReopen());
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        updater.resume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onStop() {
        stopped = true;
        bars.stop();
        super.onStop();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        files.finish(null);
        closeBridge();
        web.destroy();
        super.onDestroy();
    }

    /** 安卓 12 及以下的返回键入口；13 起由 registerBack 登记的回调处理（AndroidX 写法要引第三方库，所以压下 lint） */
    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        handleBack();
    }

    /** 窗口打开动画放完：这时才开始放启动画面的商标动画（LaunchScreen） */
    @Override
    public void onEnterAnimationComplete() {
        super.onEnterAnimationComplete();
        launch.start();
    }

    /** 网页设置和通道。ERP 是单页应用，离不开脚本，所以开 JavaScript（只开给 ERP：站外网址都交给系统浏览器） */
    @SuppressLint("SetJavaScriptEnabled")
    private void configureWeb() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + WebRules.APP_MARK + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        // WebView 滑到头的拉伸是对整个视图做的，固定的顶栏、底栏会跟着变形；关掉它，由 ERP 网页只拉伸中间内容
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new ShellClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return files.open(callback, params);
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> download(url, agent, disposition, mime));
        bridge = new BridgeChannel(web, Uri.parse(WebRules.originOf(BuildConfig.ERP_URL)), this::onBridgeMessage);
    }

    /**
     * 网页渲染进程崩了或被系统收回：旧 WebView 不能再用，换一个新的（还没加载，不占渲染进程）；
     * 接着重开刚才的页面、盖离线页还是等窗口看得见再开，见 WebRules.afterRendererGone。
     */
    private void onRendererGone(boolean crashed) {
        WebRules.AfterGone next = WebRules.afterRendererGone(!stopped, reopenedUrl != null);
        // 只有这次又自动重开时才重新记下；盖离线页、等补开都清掉
        reopenedUrl = null;
        Log.w(Shell.TAG, "网页渲染进程没了（" + (crashed ? "崩溃" : "被系统收回") + "），换新的网页：" + next);
        closeBridge();
        files.finish(null);
        ViewGroup parent = (ViewGroup) web.getParent();
        int position = parent.indexOfChild(web);
        parent.removeView(web);
        web.destroy();
        web = new WebView(this);
        web.setId(R.id.web);
        parent.addView(web, position, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWeb();
        switch (next) {
            case REOPEN -> {
                reopenedUrl = pageToReopen();
                web.loadUrl(reopenedUrl);
            }
            case OFFLINE -> offline.setVisibility(View.VISIBLE);
            case LATER -> reopenOnStart = true;
        }
    }

    /** 换新 WebView 后要重开的页面：刚才的站内页面，没有就 ERP 首页 */
    private String pageToReopen() {
        return lastInsideUrl == null ? BuildConfig.ERP_URL : lastInsideUrl;
    }

    private WebRules.Route routeOf(String url) {
        return WebRules.routeOf(url, BuildConfig.ERP_URL);
    }

    /** 主框架要去的网址：站内返回 false 让网页自己加载；站外交给浏览器、别的协议不打开，都返回 true */
    private boolean keepOutOfApp(String url) {
        WebRules.Route route = routeOf(url);
        if (route == WebRules.Route.BROWSER) openInBrowser(url);
        return route != WebRules.Route.INSIDE;
    }

    private void openInBrowser(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Shell.toastShort(this, getString(R.string.no_browser));
        }
    }

    /**
     * 下载：http(s) 交给系统下载器存进“下载”（只有站内网址带 Cookie，免得登录凭据跟着跳转去了别的主机）；
     * blob:、data: 系统下载器取不到，只提示（网页导出的文件走通道的 save-file，见 FileSaver）。
     */
    private void download(String url, String agent, String disposition, String mime) {
        if (!WebRules.isWeb(url)) {
            Log.w(Shell.TAG, "下载地址系统下载器取不到：" + url.substring(0, Math.max(0, url.indexOf(':'))));
            Shell.toastShort(this, getString(R.string.download_unsupported));
            return;
        }
        String name = URLUtil.guessFileName(url, disposition, mime);
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url)).setMimeType(mime)
                    .addRequestHeader("User-Agent", agent)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && routeOf(url) == WebRules.Route.INSIDE) request.addRequestHeader("Cookie", cookie);
            Objects.requireNonNull(getSystemService(DownloadManager.class)).enqueue(request);
        } catch (RuntimeException e) {
            // “下载”目录建不出来、系统下载管理器被停用时会抛异常：只提示，不能让应用闪退
            Log.w(Shell.TAG, "交给系统下载器没成功：" + e);
            Shell.toastShort(this, getString(R.string.download_failed));
            return;
        }
        Log.i(Shell.TAG, "已交给系统下载器：" + name);
        Shell.toastShort(this, getString(R.string.download_started, name));
    }

    /** 重试：停在站内页面上就重新载入那一页，否则回 ERP 首页 */
    private void retry() {
        offline.setVisibility(View.GONE);
        String current = web.getUrl();
        if (current != null && routeOf(current) == WebRules.Route.INSIDE) web.reload();
        else web.loadUrl(BuildConfig.ERP_URL);
    }

    /** ERP 页面加载完：发起接通（换掉旧端口） */
    private void openBridge() {
        closeBridge();
        bridge.open();
    }

    private void closeBridge() {
        bridge.close();
        shares.disconnected();
    }

    /** 网页从通道发来的话：bridge-ready、back-result、share-*、save-file；别的一律不认 */
    private void onBridgeMessage(String type, JSONObject message) {
        if (BridgeChannel.READY.equals(type)) shares.connected(bridge.sender());
        else if (BackKey.RESULT.equals(type)) act(back.onResult(message.optInt("id"), message.optString("result"), SystemClock.uptimeMillis()));
        else if (ShareInbox.handles(type)) shares.onMessage(type, message);
        else if (FileSaver.SAVE.equals(type)) saver.save(message, bridge.sender());
        else Log.w(Shell.TAG, "通道上不认识的消息：" + type);
    }

    /** 安卓 13 起：返回键和侧边返回手势都交给 handleBack；键盘开着时系统先收键盘，不走到这里 */
    private void registerBack() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
    }

    /** 返回：先走哪一步见 BackKey.stepOf；问了网页就等回执（onBridgeMessage 收到 back-result 再按回执走） */
    private void handleBack() {
        switch (BackKey.stepOf(offline.getVisibility() == View.VISIBLE, bridge.isReady(), web.canGoBack())) {
            case ASK_PAGE -> bridge.send(back.nextRequest());
            case GO_BACK -> web.goBack();
            case HOME -> act(back.onHome(SystemClock.uptimeMillis()));
        }
    }

    private void act(BackKey.Action action) {
        if (action == BackKey.Action.EXIT) finish();
        else if (action == BackKey.Action.HINT) Shell.toastShort(this, getString(R.string.back_to_exit));
    }

    /** 网页加载过程中的几个时机：要去的网址、历史变化、开始和加载完、加载失败、证书错误、渲染进程没了 */
    private final class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request.isForMainFrame() && keepOutOfApp(request.getUrl().toString());
        }

        /** 页面变了：“再按一次退出”的提示作废；记下站内网址，去了自动重开的那一页以外的页就不再算“重开的那一页” */
        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            back.reset();
            if (routeOf(url) != WebRules.Route.INSIDE) return;
            lastInsideUrl = url;
            if (!url.equals(reopenedUrl)) reopenedUrl = null;
        }

        /**
         * 主页面开始加载：关掉旧通道。shouldOverrideUrlLoading 管不到表单 POST 这类跳转，这里再判一次：
         * 不是站内就停下，站外交给浏览器，再回到上一页（没有上一页就回 ERP 首页）。
         */
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            closeBridge();
            WebRules.Route route = routeOf(url);
            if (route == WebRules.Route.INSIDE) return;
            Log.w(Shell.TAG, "主页面要去站外，停下");
            view.stopLoading();
            if (route == WebRules.Route.BROWSER) openInBrowser(url);
            if (view.canGoBack()) view.goBack();
            else view.loadUrl(BuildConfig.ERP_URL);
        }

        /** ERP 页面加载完（没盖离线页）：发起接通。页内换 # 也会走到这里，已接着就不重接 */
        @Override
        public void onPageFinished(WebView view, String url) {
            boolean erp = routeOf(url) == WebRules.Route.INSIDE;
            pageShown |= erp;
            if (!bridge.isOpen() && offline.getVisibility() != View.VISIBLE && erp) openBridge();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            Log.w(Shell.TAG, "页面加载失败：错误码 " + error.getErrorCode() + "，" + error.getDescription());
            if (WebRules.isConnectionFailure(error.getErrorCode())) offline.setVisibility(View.VISIBLE);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && WebRules.isUnavailable(response.getStatusCode())) offline.setVisibility(View.VISIBLE);
        }

        /** 证书不对一律不继续，不给“仍然访问”的路；只有 ERP 自己的证书不对才盖离线页，别处的资源只取消、记日志 */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (routeOf(error.getUrl()) == WebRules.Route.INSIDE) offline.setVisibility(View.VISIBLE);
            else Log.w(Shell.TAG, "站外资源的证书不对，已取消：" + WebRules.originOf(error.getUrl()));
        }

        /** 渲染进程崩了或被系统收回：不处理（返回 false）整个应用会跟着崩；换一个新 WebView 接着用 */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view == web) onRendererGone(detail.didCrash());
            return true;
        }
    }
}
