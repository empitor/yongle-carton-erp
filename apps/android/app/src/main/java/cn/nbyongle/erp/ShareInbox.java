package cn.nbyongle.erp;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * 接收系统“分享”“用其他应用打开”交来的文件：先看上一批是不是正在传，再在后台复制进应用缓存（系统给的读权限只这一次有效），
 * 交给 ShareRelay 经通道交给 AI 导入；网页回的分享消息转给它，收尾时删掉这一批的缓存目录。外壳只提示自己这头查出的错
 * （没收下的按原因分开、网页回绝的原因、没传上的），收到、传上由网页自己提示。
 * 每批一个目录 cache/share/编号/，里面是“序号.扩展名”的文件和清单 batch.json（ShareBatches），进程被收回、
 * Activity 重建后 restore 接着交。复制、读、删都排在同一条后台线程上，先后不会乱。这里不碰 WebView、不调 ERP 接口。
 */
final class ShareInbox {
    /** 一次最多收几份（ERP 的 AI 导入一批也是 20 份） */
    static final int MAX_FILES = 20;
    /**
     * 单份上限，以 ERP 为准：ERP 的 shared/import/workspace-inputs.ts 的 ORIGINAL_MAX_MB（10），服务端按
     * ORIGINAL_MAX_MB * MIB 字节比（server/import/file-store.ts）。大于它就拒，等于它照收；ERP 改了这里跟着改。
     */
    static final long MAX_BYTES = 10 * Shell.MIB;
    /** 能分享进来的格式：和 ERP 的 AI 导入能收的一致 */
    static final Set<String> EXTENSIONS =
            new HashSet<>(Arrays.asList("pdf", "xls", "xlsx", "doc", "docx", "jpg", "jpeg", "png"));
    /** 复制、读、删缓存都排在这一条线程上（进程里只有一条，Activity 重建后还是它） */
    private static final ExecutorService WORKER = Shell.worker("yongle-share");

    /** 一份没收下的原因：格式不支持、超过上限、读不到（分开提示） */
    enum Refusal { UNSUPPORTED, TOO_LARGE, UNREADABLE }

    /** 一次复制的结果：收下的，和按原因分开的没收下的名字 */
    private static final class Copied {
        final List<ShareRelay.Received> received = new ArrayList<>();
        final Map<Refusal, List<String>> refused = new EnumMap<>(Refusal.class);

        void refuse(Refusal reason, String name) {
            refused.computeIfAbsent(reason, r -> new ArrayList<>()).add(name);
        }
    }

    private final Activity activity;
    private final ShareBatches batches;
    private final ShareRelay relay = new ShareRelay(this::load, this::finished);

    ShareInbox(Activity activity) {
        this.activity = activity;
        batches = new ShareBatches(new File(activity.getCacheDir(), "share"));
    }

    /** 有能收的扩展名就原样用；没有扩展名时按系统给的类型补上（extensionOfMime）；都不行返回 null */
    static String acceptedName(String name, String extensionOfMime) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        if (EXTENSIONS.contains(ext)) return name;
        if (dot < 0 && extensionOfMime != null && EXTENSIONS.contains(extensionOfMime)) return name + "." + extensionOfMime;
        return null;
    }

    /** 收下的文件在缓存里的名字：序号加（已核对过的）扩展名，和对方给的名字无关 */
    static String storedName(int index, String acceptedName) {
        return index + "." + acceptedName.substring(acceptedName.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
    }

    /** 网页发来的分享消息 */
    static boolean handles(String type) {
        return ShareRelay.handles(type);
    }

    /** onCreate 调（新启动、进程恢复、Activity 重建都调）：接着交上次没交完的一批，清掉没有清单的旧目录 */
    void restore() {
        WORKER.execute(() -> {
            ShareBatches.Batch batch = batches.restore();
            if (batch == null) return;
            onMain(() -> {
                if (relay.busy()) WORKER.execute(() -> batches.delete(batch.id));
                else relay.start(batch.id, batch.files);
            });
        });
    }

    /** 入口在新启动、onNewIntent 里交来；是分享就先判忙，再在后台复制，复制完提示没收下的、把收下的交给 ShareRelay */
    void accept(Intent intent) {
        if (intent == null || (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        List<Uri> uris = urisOf(intent);
        if (uris.isEmpty()) return;
        if (relay.busy()) {
            toast(activity.getString(R.string.share_busy));
            return;
        }
        if (uris.size() > MAX_FILES) toast(activity.getString(R.string.share_too_many, MAX_FILES));
        List<Uri> taken = new ArrayList<>(uris.subList(0, Math.min(uris.size(), MAX_FILES)));
        ContentResolver resolver = activity.getContentResolver();
        WORKER.execute(() -> {
            String id = UUID.randomUUID().toString();
            File dir = batches.dirOf(id);
            Copied copied = new Copied();
            for (Uri uri : taken) copy(resolver, uri, dir, copied);
            if (!copied.received.isEmpty() && !batches.save(id, copied.received)) {
                copied.received.forEach(f -> copied.refuse(Refusal.UNREADABLE, f.name));
                copied.received.clear();
            }
            if (copied.received.isEmpty()) batches.delete(id);
            onMain(() -> received(id, copied));
        });
    }

    void connected(Consumer<String> sender) {
        relay.connected(sender);
    }

    void disconnected() {
        relay.disconnected();
    }

    /** 入口转来的分享消息，解析出各字段交给 ShareRelay */
    void onMessage(String type, JSONObject message) {
        String shareId = message.optString("shareId");
        int index = message.optInt("index", -1);
        switch (type) {
            case ShareRelay.READY -> relay.ready(shareId);
            case ShareRelay.REJECTED -> relay.rejected(shareId, message.optString("message"));
            case ShareRelay.UPLOADED -> relay.uploaded(shareId, index, message.optBoolean("duplicate"));
            case ShareRelay.FAILED -> relay.failed(shareId, index, message.optString("message"));
            default -> Log.w(Shell.TAG, "不认识的分享消息：" + type);
        }
    }

    private void received(String id, Copied copied) {
        reportRejected(copied);
        if (copied.received.isEmpty()) return;
        if (relay.busy()) {
            toast(activity.getString(R.string.share_busy));
            WORKER.execute(() -> batches.delete(id));
            return;
        }
        Log.i(Shell.TAG, "已收到分享：" + copied.received.size() + " 份，编号 " + id);
        String replaced = relay.start(id, copied.received);
        if (replaced != null) WORKER.execute(() -> batches.delete(replaced));
    }

    /** 没收下的按原因各提示一条（格式不支持、超过上限、读不到） */
    private void reportRejected(Copied copied) {
        copied.refused.forEach((reason, names) -> toast(refusalText(reason, String.join("、", names))));
    }

    private String refusalText(Refusal reason, String names) {
        return switch (reason) {
            case UNSUPPORTED -> activity.getString(R.string.share_unsupported, names);
            case TOO_LARGE -> activity.getString(R.string.share_too_large, MAX_BYTES / Shell.MIB, names);
            case UNREADABLE -> activity.getString(R.string.share_unreadable, names);
        };
    }

    /** ShareRelay 要第几份：在后台读出来、编码、拼好消息，再回主线程交给它 */
    private void load(ShareRelay.Ticket ticket, ShareRelay.Received file) {
        WORKER.execute(() -> {
            try {
                String data = Base64.getEncoder().encodeToString(Files.readAllBytes(file.file.toPath()));
                String message = ShareRelay.fileMessage(ticket.shareId, ticket.index, data);
                onMain(() -> relay.loaded(ticket, message));
            } catch (IOException | RuntimeException e) {
                Log.w(Shell.TAG, "读不出收下的文件：" + e.getMessage());
                onMain(() -> relay.unreadable(ticket, activity.getString(R.string.share_unreadable_file, file.name)));
            }
        });
    }

    /** 一批收尾：删掉这一批的缓存目录；只提示外壳自己这头的错（网页回绝的原因、没传上的），传上的由网页自己提示 */
    private void finished(ShareRelay.Result result) {
        WORKER.execute(() -> batches.delete(result.shareId));
        if (result.rejected != null) {
            Log.i(Shell.TAG, "网页回绝了这批分享：" + result.shareId);
            toast(result.rejected.isBlank() ? activity.getString(R.string.share_refused) : result.rejected);
            return;
        }
        Log.i(Shell.TAG, "分享已交完：成功 " + result.uploaded + " 份（其中原有任务 " + result.duplicate + "），没成功 " + result.failures.size());
        if (!result.failures.isEmpty()) toast(activity.getString(R.string.share_failed, result.failures.size(), result.failures.get(0)));
    }

    /** 回主线程；Activity 已销毁就不做（清单还在缓存里，新的 Activity 会 restore） */
    private void onMain(Runnable action) {
        Shell.onMain(activity, action);
    }

    private void toast(String text) {
        Shell.toast(activity, text);
    }

    /**
     * 别的应用交来的一串东西里挑出 content: 地址。对方可能在里面混进别的类型（Intent、Bundle、字符串……），
     * 逐个按类型筛，不做任何转换，混进来的跳过、不抛。
     */
    static List<Uri> contentUris(List<?> items) {
        List<Uri> uris = new ArrayList<>();
        for (Object item : items) {
            if (item instanceof Uri uri && "content".equals(uri.getScheme())) uris.add(uri);
        }
        return uris;
    }

    /** 分享（单份、多份）和“用其他应用打开”交来的 content: 地址；解包、筛选都在 try 里，对方给什么都不让应用闪退 */
    private static List<Uri> urisOf(Intent intent) {
        try {
            return contentUris(sent(intent));
        } catch (RuntimeException e) {
            Log.w(Shell.TAG, "分享的内容解不开：" + e);
            return new ArrayList<>();
        }
    }

    /**
     * 原样取出对方交来的东西（不转成 Uri，交给 contentUris 按类型筛）。
     * 带类型的 getParcelableExtra(String, Class) 安卓 13 起才有，minSdk 是 29，所以用旧写法。
     */
    @SuppressWarnings("deprecation")
    private static List<?> sent(Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) return Collections.singletonList(intent.getData());
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return new ArrayList<>();
        if (intent.getClipData() != null) return Shell.clipUris(intent.getClipData());
        if (Intent.ACTION_SEND.equals(action)) {
            Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            return Collections.singletonList(stream);
        }
        List<?> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        return list == null ? new ArrayList<>() : list;
    }

    /**
     * 认不出能收的格式时算哪一种拒收：对方连名字、类型都没给（多半是没给读这个地址的权限，名字只剩地址最后一段）算读不到；
     * 给了名字或类型、只是格式不在能收的里面，才算格式不支持。
     */
    static Refusal formatRefusal(String providedName, String mime) {
        return providedName == null && mime == null ? Refusal.UNREADABLE : Refusal.UNSUPPORTED;
    }

    /**
     * 复制一份。别的应用给的东西一律当不可信：名字清洗后只给网页看，落盘只用“序号.扩展名”并核对落在这一批的目录里；
     * 对方抛什么异常都只算这一份读不到，不让应用闪退。
     */
    private void copy(ContentResolver resolver, Uri uri, File dir, Copied into) {
        String label = activity.getString(R.string.share_unnamed);
        File target = null;
        try {
            String provided = Shell.textColumn(resolver, uri, OpenableColumns.DISPLAY_NAME);
            String shown = Shell.safeName(provided != null ? provided : uri.getLastPathSegment());
            if (!shown.isEmpty()) label = shown;
            String mime = resolver.getType(uri);
            String name = acceptedName(label, MimeTypeMap.getSingleton().getExtensionFromMimeType(mime));
            if (name == null) {
                into.refuse(formatRefusal(provided, mime), label);
                return;
            }
            target = new File(dir, storedName(into.received.size(), name));
            long size = write(resolver, uri, dir, target);
            into.received.add(new ShareRelay.Received(name, mime == null ? Shell.UNKNOWN_MIME : mime, size, target));
        } catch (Shell.TooLarge e) {
            discard(target);
            into.refuse(Refusal.TOO_LARGE, label);
        } catch (IOException | RuntimeException e) {
            Log.w(Shell.TAG, "收不下分享的文件：" + e);
            discard(target);
            into.refuse(Refusal.UNREADABLE, label);
        }
    }

    private static long write(ContentResolver resolver, Uri uri, File dir, File target) throws IOException {
        if (!Shell.isInside(dir, target)) throw new IOException("缓存位置不对");
        Shell.ensureParent(target);
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = Files.newOutputStream(target.toPath())) {
            return Shell.copy(in, out, MAX_BYTES);
        }
    }

    private static void discard(File target) {
        if (target != null && target.exists() && !target.delete()) Log.w(Shell.TAG, "没收下的缓存文件没删掉");
    }
}
