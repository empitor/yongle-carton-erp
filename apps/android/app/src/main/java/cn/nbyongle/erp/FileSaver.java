package cn.nbyongle.erp;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 网页要保存的文件（导出的订货单、送货单这类内存里的文件，WebView 的 blob: 下载外壳存不了）：网页发 save-file，
 * 外壳核对、解码后在后台存进系统“下载”（MediaStore.Downloads，安卓 10 起不要存储权限），对每条都回且只回一条
 * save-result（带同一个 id）：存好回 ok:true 并提示“已保存到‘下载’：文件名”，不成回 ok:false 和给人看的原因。
 * 消息约定见 ERP 项目 docs/架构说明.md“安卓 App 通道”。
 */
final class FileSaver {
    static final String SAVE = "save-file";
    static final String RESULT = "save-result";
    /** 一份最多多大（解码后）：导出的单据、表格远小于它，挡住异常大的内容把内存占满 */
    static final long MAX_BYTES = 20 * Shell.MIB;
    private static final Pattern MIME = Pattern.compile("[\\w.+-]+/[\\w.+-]+");
    /** 写文件排在这一条线程上 */
    private static final ExecutorService WORKER = Shell.worker("yongle-save");

    /** 核对不过的原因 */
    enum Problem { BAD_ID, BAD_NAME, BAD_DATA, TOO_LARGE }

    /** 核对的结果：problem 是 null 时 name、bytes 可用 */
    static final class Checked {
        final Problem problem;
        final String name;
        final byte[] bytes;

        private Checked(Problem problem, String name, byte[] bytes) {
            this.problem = problem;
            this.name = name;
            this.bytes = bytes;
        }
    }

    private final Activity activity;

    FileSaver(Activity activity) {
        this.activity = activity;
    }

    /** 核对网页给的 id、名字和 base64 内容：id 要正整数，名字清洗后不能空，内容要合法 base64、解码后不超过 MAX_BYTES */
    static Checked check(Object id, String rawName, String data) {
        boolean validId = (id instanceof Integer || id instanceof Long) && ((Number) id).longValue() > 0;
        if (!validId) return new Checked(Problem.BAD_ID, null, null);
        String name = Shell.safeName(rawName);
        if (name.isEmpty()) return new Checked(Problem.BAD_NAME, null, null);
        if (data == null) return new Checked(Problem.BAD_DATA, null, null);
        // 先按长度估：解码后至少有 长度/4*3-2 字节，明显超了就不解码，免得占内存
        if ((long) data.length() / 4 * 3 - 2 > MAX_BYTES) return new Checked(Problem.TOO_LARGE, null, null);
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(data);
        } catch (IllegalArgumentException e) {
            return new Checked(Problem.BAD_DATA, null, null);
        }
        if (bytes.length > MAX_BYTES) return new Checked(Problem.TOO_LARGE, null, null);
        return new Checked(null, name, bytes);
    }

    /** 网页给的类型只认“类/子类”的写法（去掉 ;charset 这类参数），别的按任意二进制存 */
    static String mimeOf(String raw) {
        String mime = raw == null ? "" : raw.split(";", 2)[0].trim();
        return MIME.matcher(mime).matches() ? mime : Shell.UNKNOWN_MIME;
    }

    /** 入口转来的 save-file；reply 绑在收到它的那个通道上（页面换了就不发） */
    void save(JSONObject message, Consumer<String> reply) {
        Object id = message.opt("id");
        String name = message.opt("name") instanceof String text ? text : null;
        String data = message.opt("data") instanceof String text ? text : null;
        String mime = mimeOf(message.optString("mime"));
        WORKER.execute(() -> {
            Checked checked = check(id, name, data);
            if (checked.problem != null) {
                Log.w(Shell.TAG, "没保存网页给的文件：" + checked.problem);
                answer(reply, id, problemText(checked.problem));
                return;
            }
            try {
                String saved = write(checked.name, mime, checked.bytes);
                Log.i(Shell.TAG, "已保存到“下载”：" + saved);
                answer(reply, id, null);
                onMain(() -> Shell.toast(activity, activity.getString(R.string.save_done, saved)));
            } catch (IOException | RuntimeException e) {
                Log.w(Shell.TAG, "保存到“下载”没成功：" + e);
                answer(reply, id, activity.getString(R.string.save_failed));
            }
        });
    }

    private String problemText(Problem problem) {
        return switch (problem) {
            case BAD_ID, BAD_DATA -> activity.getString(R.string.save_bad_request);
            case BAD_NAME -> activity.getString(R.string.save_bad_name);
            case TOO_LARGE -> activity.getString(R.string.save_too_large, MAX_BYTES / Shell.MIB);
        };
    }

    /** 回 save-result：failure 是 null 表示存好了，否则是给人看的原因 */
    private void answer(Consumer<String> reply, Object id, String failure) {
        try {
            JSONObject result = new JSONObject().put("type", RESULT).put("id", id == null ? JSONObject.NULL : id).put("ok", failure == null);
            if (failure != null) result.put("message", failure);
            String text = result.toString();
            onMain(() -> reply.accept(text));
        } catch (JSONException e) {
            Log.w(Shell.TAG, "save-result 拼不出来：" + e.getMessage());
        }
    }

    /** 存进“下载”：先占一条待定的记录，写完再放开；中途出错删掉这条记录。返回系统实际用的名字（重名时系统会改） */
    private String write(String name, String mime, byte[] bytes) throws IOException {
        ContentResolver resolver = activity.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("系统没给“下载”里的位置");
        try {
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("打不开“下载”里的位置");
                out.write(bytes);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            // 没放开的记录在“下载”里看不见、过几天被系统清掉，不能报成功
            if (resolver.update(uri, done, null, null) < 1) throw new IOException("“下载”里的文件没能放开");
        } catch (IOException | RuntimeException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        String saved = Shell.textColumn(resolver, uri, MediaStore.MediaColumns.DISPLAY_NAME);
        return saved != null ? saved : name;
    }

    private void onMain(Runnable action) {
        Shell.onMain(activity, action);
    }
}
