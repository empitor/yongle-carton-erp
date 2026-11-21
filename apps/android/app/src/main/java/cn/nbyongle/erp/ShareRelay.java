package cn.nbyongle.erp;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;

/**
 * 一批分享怎么交给网页（纯 Java，只在主线程上用）。消息约定见 ERP 项目 docs/架构/外壳和网页.md“安卓 App 通道”：
 * 接通后发 share-offer；网页回 share-ready 就从第 0 份起一份一份发 share-file，每份等网页回 share-uploaded 或
 * share-failed 再发下一份（自己读不出的记一条失败、直接往下走）；最后一份有了结果就由外壳自己收尾。网页回
 * share-rejected（这个账号进不了 AI 导入）也收尾。页面重新接通时退回“已发清单、没收到 share-ready”，从第 0 份重来。
 * 还没收到 share-ready 的一批可以被新的分享替换；已经在传才算忙。
 */
final class ShareRelay {
    static final String OFFER = "share-offer";
    static final String FILE = "share-file";
    static final String READY = "share-ready";
    static final String REJECTED = "share-rejected";
    static final String UPLOADED = "share-uploaded";
    static final String FAILED = "share-failed";
    private static final Set<String> FROM_PAGE = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(READY, REJECTED, UPLOADED, FAILED)));

    /** 收下的一份文件：给网页看的名字、类型、字节数，缓存里的位置 */
    static final class Received {
        final String name;
        final String mime;
        final long size;
        final File file;

        Received(String name, String mime, long size, File file) {
            this.name = name;
            this.mime = mime;
            this.size = size;
            this.file = file;
        }
    }

    /** 一批收尾时的结果；rejected 不是 null 表示网页回绝了这一批（值是给人看的原因） */
    static final class Result {
        final String shareId;
        final int uploaded;
        final int duplicate;
        final List<String> failures;
        final String rejected;

        Result(ShareRelay relay, String rejected) {
            this.shareId = relay.shareId;
            this.uploaded = relay.uploaded;
            this.duplicate = relay.duplicate;
            this.failures = Collections.unmodifiableList(new ArrayList<>(relay.failures));
            this.rejected = rejected;
        }
    }

    /** 读第几份的凭据：读好后原样交回；这期间页面重连、换了一批，凭据就作废 */
    static final class Ticket {
        final String shareId;
        final int index;
        private final int generation;

        private Ticket(String shareId, int index, int generation) {
            this.shareId = shareId;
            this.index = index;
            this.generation = generation;
        }
    }

    /** 读一份文件（可以在后台）：读好拼成 fileMessage 后在主线程调 loaded，读不出调 unreadable */
    interface Loader {
        void load(Ticket ticket, Received file);
    }

    private final Loader loader;
    private final Consumer<Result> finished;
    /** 通道接通时给的发送函数；没接通是 null */
    private Consumer<String> send;
    /** 这一批的编号和文件；没有待交的是 null */
    private String shareId;
    private List<Received> files = Collections.emptyList();
    /** 网页回了 share-ready、开始传了 */
    private boolean started;
    /** 正在办第几份；loading 表示还在读，读好发出去之前不认网页对它的回执 */
    private int current = -1;
    private boolean loading;
    /** 每次重连、换批、断开都加一，旧的读取凭据随之作废 */
    private int generation;
    private int uploaded;
    private int duplicate;
    private final List<String> failures = new ArrayList<>();

    ShareRelay(Loader loader, Consumer<Result> finished) {
        this.loader = loader;
        this.finished = finished;
    }

    /** 网页发来的分享消息 */
    static boolean handles(String type) {
        return FROM_PAGE.contains(type);
    }

    /** 通道上的第一条分享消息：这次分享的编号和文件清单（不带内容） */
    static String offerMessage(String shareId, List<Received> files) {
        StringBuilder list = new StringBuilder();
        for (Received f : files) {
            if (list.length() > 0) list.append(',');
            list.append("{\"name\":").append(quote(f.name)).append(",\"mime\":").append(quote(f.mime))
                    .append(",\"size\":").append(f.size).append('}');
        }
        return "{\"type\":\"" + OFFER + "\",\"shareId\":" + quote(shareId) + ",\"files\":[" + list + "]}";
    }

    /** 一份文件的内容（base64） */
    static String fileMessage(String shareId, int index, String base64) {
        return "{\"type\":\"" + FILE + "\",\"shareId\":" + quote(shareId) + ",\"index\":" + index + ",\"data\":\"" + base64 + "\"}";
    }

    /** JSON 字符串：引号、反斜杠和控制字符转义（文件名可能带这些） */
    static String quote(String text) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < ' ') out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    /** 已经在传（网页回过 share-ready）：这时来的新分享不收 */
    boolean busy() {
        return shareId != null && started;
    }

    /** 新的一批（调用前先看 busy）：替换还没开始传的旧批，已接通就发清单；返回被替换的旧编号，没有返回 null */
    String start(String id, List<Received> received) {
        if (busy()) throw new IllegalStateException("上一批还在传");
        String replaced = shareId;
        shareId = id;
        files = received;
        restart();
        return replaced;
    }

    /** 通道接通（或页面重新加载后又接通）：有待交的就从头再来，重发清单 */
    void connected(Consumer<String> sender) {
        send = sender;
        if (shareId != null) restart();
    }

    /** 通道断了（页面换了、连不上）：等下次接通从头再来 */
    void disconnected() {
        send = null;
        started = false;
        generation++;
    }

    void ready(String id) {
        if (!isCurrent(id) || started || send == null) return;
        started = true;
        request(0);
    }

    void rejected(String id, String message) {
        if (isCurrent(id)) finish(message);
    }

    void uploaded(String id, int index, boolean wasDuplicate) {
        if (!isAnswer(id, index)) return;
        uploaded++;
        if (wasDuplicate) duplicate++;
        request(index + 1);
    }

    void failed(String id, int index, String message) {
        if (!isAnswer(id, index)) return;
        failures.add(message);
        request(index + 1);
    }

    /** 读好了：发出去，等网页回这一份的结果 */
    void loaded(Ticket ticket, String message) {
        if (ticket.generation != generation) return;
        loading = false;
        send.accept(message);
    }

    /** 读不出来：记一条失败（reason 是给人看的话），接着发下一份 */
    void unreadable(Ticket ticket, String reason) {
        if (ticket.generation != generation) return;
        loading = false;
        failures.add(reason);
        request(ticket.index + 1);
    }

    private boolean isCurrent(String id) {
        return shareId != null && shareId.equals(id);
    }

    /** 只认这一批、已开始、正在等的那一份的回执 */
    private boolean isAnswer(String id, int index) {
        return isCurrent(id) && started && !loading && index == current;
    }

    /** 回到“已发清单、没收到 share-ready”：计数清零，已接通就发清单 */
    private void restart() {
        started = false;
        current = -1;
        loading = false;
        generation++;
        uploaded = 0;
        duplicate = 0;
        failures.clear();
        if (send != null) send.accept(offerMessage(shareId, files));
    }

    /** 办第 index 份；到头了就收尾 */
    private void request(int index) {
        if (index >= files.size()) {
            finish(null);
            return;
        }
        current = index;
        loading = true;
        loader.load(new Ticket(shareId, index, generation), files.get(index));
    }

    private void finish(String rejected) {
        Result result = new Result(this, rejected);
        shareId = null;
        files = Collections.emptyList();
        started = false;
        current = -1;
        loading = false;
        generation++;
        finished.accept(result);
    }
}
