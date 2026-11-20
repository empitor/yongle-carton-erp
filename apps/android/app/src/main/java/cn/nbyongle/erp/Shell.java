package cn.nbyongle.erp;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;
import android.widget.Toast;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.LongConsumer;

/**
 * 各件共用的小东西：日志标签、提示、后台线程和回主线程、取 ClipData 的地址、读内容提供者的一列、限长复制、建目录和删目录、
 * 文件名清洗。不引别的产品文件。
 */
final class Shell {
    /** 日志标签：adb logcat 按它过滤（scripts/verify-device.ps1） */
    static final String TAG = "YongleShell";
    static final long MIB = 1024 * 1024;
    /** 不知道类型的文件按任意二进制存、交 */
    static final String UNKNOWN_MIME = "application/octet-stream";
    /** 清洗后的文件名最多多少字节（UTF-8，常见文件系统的上限）、截短时保留的扩展名最多几个字（带点） */
    static final int MAX_NAME_BYTES = 255;
    private static final int MAX_EXTENSION_LENGTH = 10;
    private static final int BUFFER = 64 * 1024;
    /** UTF-8 里一个字符占 1、2、3 字节的上界（再往上 4 字节） */
    private static final int ONE_BYTE = 0x80, TWO_BYTES = 0x800, THREE_BYTES = 0x10000;

    private Shell() {
    }

    /** 超过上限的那一种读写错误：调用方据此和别的读写错误分开提示 */
    static final class TooLarge extends IOException {
        private static final long serialVersionUID = 1L;

        TooLarge(long limit) {
            super("超过 " + limit + " 字节");
        }
    }

    /** 从 in 复制到 out，返回字节数；超过 limit 就停下抛 TooLarge（等于 limit 照收） */
    static long copy(InputStream in, OutputStream out, long limit) throws IOException {
        return copy(in, out, limit, total -> { });
    }

    /** 同上，每写一块把已写的字节数交给 progress（它可以抛运行时异常来中止复制） */
    static long copy(InputStream in, OutputStream out, long limit, LongConsumer progress) throws IOException {
        if (in == null) throw new IOException("打不开");
        long total = 0;
        byte[] buffer = new byte[BUFFER];
        for (int n = in.read(buffer); n >= 0; n = in.read(buffer)) {
            total += n;
            if (total > limit) throw new TooLarge(limit);
            out.write(buffer, 0, n);
            progress.accept(total);
        }
        return total;
    }

    /** 建出 file 的上级目录；建不出来就抛错 */
    static void ensureParent(File file) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("建不了目录：" + parent.getName());
    }

    /** 给人看的提示（长：分享、更新、保存这类结果） */
    static void toast(Context context, String text) {
        Toast.makeText(context, text, Toast.LENGTH_LONG).show();
    }

    /** 短提示：返回键、下载开始这类随手的反馈 */
    static void toastShort(Context context, String text) {
        Toast.makeText(context, text, Toast.LENGTH_SHORT).show();
    }

    /** 一条有名字的后台线程，交给它的事按先后一件件做 */
    static ExecutorService worker(String name) {
        return Executors.newSingleThreadExecutor(task -> new Thread(task, name));
    }

    /** 从后台回主线程做事；Activity 已经销毁就不做（各件的状态都跟着那个 Activity 走了） */
    static void onMain(Activity activity, Runnable action) {
        activity.runOnUiThread(() -> {
            if (!activity.isDestroyed()) action.run();
        });
    }

    /** ClipData 里每一项的地址（可能有 null，调用方自己筛） */
    static List<Uri> clipUris(ClipData clip) {
        List<Uri> uris = new ArrayList<>();
        for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
        return uris;
    }

    /** 读内容提供者给这个地址的某一列文字（名字这类）；没有或读不出返回 null（对方抛什么都接住） */
    static String textColumn(ContentResolver resolver, Uri uri, String column) {
        try (Cursor cursor = resolver.query(uri, new String[] {column}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (RuntimeException e) {
            Log.w(TAG, "读不出 " + column + "：" + e.getMessage());
        }
        return null;
    }

    /** 删掉目录和里面的一切；删不掉的记日志 */
    static void deleteTree(File dir) {
        File[] children = dir.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (dir.exists() && !dir.delete()) Log.w(TAG, "缓存没删掉：" + dir.getName());
    }

    /** target 确实落在 dir 里面（按真实路径比，挡住 ..、符号链接） */
    static boolean isInside(File dir, File target) throws IOException {
        return target.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator);
    }

    /**
     * 别的应用、网页给的文件名清洗成只剩名字本身：去掉控制字符和不可见的格式字符，只取最后一个 / 或 \ 后面的部分，
     * “.”“..”算没有名字，太长时保留扩展名截短。清洗后没有名字返回空字符串。分享收文件、保存文件都用它。
     */
    static String safeName(String raw) {
        if (raw == null) return "";
        StringBuilder kept = new StringBuilder();
        raw.codePoints().filter(c -> !Character.isISOControl(c) && Character.getType(c) != Character.FORMAT)
                .forEach(kept::appendCodePoint);
        String name = kept.toString();
        name = name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).trim();
        if (".".equals(name) || "..".equals(name)) return "";
        return shorten(name);
    }

    /** 名字按 UTF-8 超过 MAX_NAME_BYTES 字节时截短（按整个字符截），扩展名（10 个字以内）留着 */
    private static String shorten(String name) {
        if (utf8Bytes(name) <= MAX_NAME_BYTES) return name;
        int dot = name.lastIndexOf('.');
        String ext = dot > 0 && name.length() - dot <= MAX_EXTENSION_LENGTH ? name.substring(dot) : "";
        int budget = MAX_NAME_BYTES - utf8Bytes(ext);
        StringBuilder base = new StringBuilder();
        int used = 0;
        int end = name.length() - ext.length();
        for (int i = 0; i < end; i += Character.charCount(name.codePointAt(i))) {
            int size = charBytes(name.codePointAt(i));
            if (used + size > budget) break;
            base.appendCodePoint(name.codePointAt(i));
            used += size;
        }
        return base + ext;
    }

    private static int utf8Bytes(String text) {
        return text.codePoints().map(Shell::charBytes).sum();
    }

    private static int charBytes(int codePoint) {
        if (codePoint < ONE_BYTE) return 1;
        if (codePoint < TWO_BYTES) return 2;
        return codePoint < THREE_BYTES ? 3 : 4;
    }
}
