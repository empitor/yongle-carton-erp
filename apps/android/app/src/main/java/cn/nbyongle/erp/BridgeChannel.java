package cn.nbyongle.erp;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 和 ERP 网页的接通通道（消息约定见 ERP 项目 docs/架构说明.md“安卓 App 通道”）：ERP 页面加载完由入口调 open，
 * 建一对端口，把接通消息和其中一个端口发给 ERP 来源的主页面（系统只投给这个来源）；网页回 bridge-ready 才算接通。
 * 之后网页的每句话解析出 type 交给入口；页面重新加载时入口调 close。只做传输，不管消息的意思。
 */
final class BridgeChannel {
    /** 发起接通的消息：附一个专用端口，之后各种消息都走这个端口 */
    static final String HELLO = "{\"type\":\"erp-app-bridge\",\"version\":1}";
    /** 网页接通后回的话 */
    static final String READY = "bridge-ready";

    private final WebView web;
    private final Uri origin;
    private final BiConsumer<String, JSONObject> onMessage;
    /** 外壳这头的端口；没开是 null */
    private WebMessagePort port;
    /** 网页回了 bridge-ready */
    private boolean ready;

    BridgeChannel(WebView web, Uri origin, BiConsumer<String, JSONObject> onMessage) {
        this.web = web;
        this.origin = origin;
        this.onMessage = onMessage;
    }

    /** 建端口、发接通消息；只认这个端口上来的话 */
    void open() {
        WebMessagePort[] channel = web.createWebMessageChannel();
        port = channel[0];
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort from, WebMessage message) {
                if (from == port) receive(message.getData());
            }
        });
        web.postWebMessage(new WebMessage(HELLO, new WebMessagePort[] {channel[1]}), origin);
    }

    void close() {
        if (port != null) port.close();
        port = null;
        ready = false;
    }

    boolean isOpen() {
        return port != null;
    }

    boolean isReady() {
        return ready;
    }

    void send(String json) {
        if (port != null) port.postMessage(new WebMessage(json));
    }

    /** 绑在现在这个端口上的发送函数：端口换了（页面重新加载、重新接通）就不再发，旧页面的事不会落到新页面上 */
    Consumer<String> sender() {
        WebMessagePort bound = port;
        return json -> {
            if (bound != null && bound == port) bound.postMessage(new WebMessage(json));
        };
    }

    /** 网页的话：不是 JSON 的按约定不理；bridge-ready 记下已接通；都交给入口按 type 分派 */
    private void receive(String data) {
        JSONObject message;
        try {
            message = new JSONObject(data == null ? "" : data);
        } catch (JSONException e) {
            Log.w(Shell.TAG, "通道上收到的不是 JSON：" + e.getMessage());
            return;
        }
        String type = message.optString("type");
        if (READY.equals(type)) ready = true;
        onMessage.accept(type, message);
    }
}
