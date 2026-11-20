package cn.nbyongle.erp;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import android.widget.ProgressBar;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntConsumer;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 应用内更新：冷启动后在后台读一次版本清单（构建时配置的地址，没配就不查），比当前 versionCode 新就弹“发现新版本”；
 * 用户点“下载并安装”后在应用里下载 APK（能取消、有进度），核对清单给的 sha256、包名和版本号，交给系统安装器让用户确认
 * （结果由 InstallStatusReceiver 收）。还没允许“安装未知应用”时先带去系统设置，待装的版本记在 SharedPreferences，
 * 回到前台（哪怕进程被收回过）接着装。同一包名、同一签名的新包系统才肯装。查不到、出错只记日志、提示，不影响打开 ERP。
 * 清单格式见 docs/构建与测试.md“应用内更新”。
 */
final class AppUpdater {
    private static final int TIMEOUT_MS = 15_000;
    /** 版本清单、安装包最多多大：挡住写错或被篡改的地址把流量和存储占满 */
    private static final long MANIFEST_MAX_BYTES = 64 * 1024;
    private static final long APK_MAX_BYTES = 100 * Shell.MIB;
    private static final int PERCENT = 100;
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final String PREFS = "update", PENDING_FILE = "pendingFile", PENDING_VERSION = "pendingVersion";
    /** 查清单、下载、写安装会话都排在这一条线程上 */
    private static final ExecutorService WORKER = Shell.worker("yongle-update");

    /** 清单里的新版本 */
    static final class Release {
        final int versionCode;
        final String versionName;
        final String apkUrl;
        final String sha256;
        final String notes;

        Release(int versionCode, String versionName, String apkUrl, String sha256, String notes) {
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.apkUrl = apkUrl;
            this.sha256 = sha256;
            this.notes = notes;
        }
    }

    /** 没下载成、没核对过：message 是给人看的字符串资源 */
    private static final class Failure extends Exception {
        private static final long serialVersionUID = 1L;
        final int message;

        Failure(int message, String detail) {
            super(detail);
            this.message = message;
        }
    }

    private final Activity activity;
    private final String manifestUrl;
    private final int currentVersion;
    private final File folder;
    private final SharedPreferences prefs;

    AppUpdater(Activity activity, String manifestUrl, int currentVersion) {
        this.activity = activity;
        this.manifestUrl = manifestUrl;
        this.currentVersion = currentVersion;
        folder = new File(activity.getCacheDir(), "update");
        prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    /** 清单里的这个版本能不能用：版本号更新、下载地址是 http(s)、sha256 是 64 位小写十六进制；能用返回 null，不能用返回原因 */
    static String problemOf(Release r, int currentVersion) {
        if (r.versionCode <= currentVersion) return "不比当前版本新";
        if (!r.apkUrl.startsWith("https://") && !r.apkUrl.startsWith("http://")) return "下载地址不对";
        if (!SHA256.matcher(r.sha256).matches()) return "缺校验值";
        return null;
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }

    /** 冷启动调：清掉用不着的旧安装包，再在后台查一次（没配地址就不查） */
    void check() {
        WORKER.execute(() -> {
            cleanup();
            if (manifestUrl.isEmpty()) return;
            try {
                JSONObject json = new JSONObject(new String(fetch(manifestUrl), StandardCharsets.UTF_8));
                Release release = new Release(json.getInt("versionCode"), json.getString("versionName"),
                        json.getString("apkUrl"), json.getString("sha256").toLowerCase(Locale.ROOT), json.optString("notes"));
                String problem = problemOf(release, currentVersion);
                if (problem == null) onMain(() -> offer(release));
                else Log.i(Shell.TAG, "版本清单没有可用的新版本：" + problem);
            } catch (IOException | JSONException | RuntimeException e) {
                Log.w(Shell.TAG, "检查更新没成功（不影响使用）：" + e);
            }
        });
    }

    /**
     * 回到前台：有记下的待装新版、已允许“安装未知应用”就接着装。待装记录只在后台这一条线程上读和改，
     * 冷启动时一定排在 check 的清旧包后面，清旧包不会删掉待装的那一份。
     */
    void resume() {
        WORKER.execute(() -> {
            int version = prefs.getInt(PENDING_VERSION, 0);
            String path = prefs.getString(PENDING_FILE, null);
            if (version <= currentVersion || path == null) return;
            File apk = new File(path);
            if (!apk.isFile()) forget();
            else if (activity.getPackageManager().canRequestPackageInstalls()) commitOrReport(apk);
        });
    }

    private void offer(Release release) {
        if (activity.isFinishing()) return;
        String message = activity.getString(R.string.update_found_message, release.versionName)
                + (release.notes.isEmpty() ? "" : "\n\n" + release.notes);
        new AlertDialog.Builder(activity).setTitle(R.string.update_found_title).setMessage(message)
                .setPositiveButton(R.string.update_install, (d, w) -> download(release))
                .setNegativeButton(R.string.update_later, null).show();
    }

    /** 下载框：有进度、能取消；取消、失败都删掉下了一半的文件 */
    private void download(Release release) {
        AtomicBoolean cancelled = new AtomicBoolean();
        ProgressBar bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        bar.setIndeterminate(true);
        bar.setMax(PERCENT);
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle(R.string.update_downloading).setView(bar)
                .setNegativeButton(R.string.update_cancel, (d, w) -> cancelled.set(true)).setCancelable(false).show();
        IntConsumer percent = p -> onMain(() -> {
            bar.setIndeterminate(false);
            bar.setProgress(p);
        });
        WORKER.execute(() -> {
            try {
                File apk = save(release, cancelled, percent);
                onMain(() -> {
                    dialog.dismiss();
                    // 刚下完时正好点了取消：不装，删掉
                    if (cancelled.get()) WORKER.execute(() -> discard(apk));
                    else install(apk, release.versionCode);
                });
            } catch (Failure e) {
                Log.w(Shell.TAG, "新版本没下载成：" + e.getMessage());
                onMain(() -> {
                    dialog.dismiss();
                    if (!cancelled.get()) Shell.toast(activity, activity.getString(e.message));
                });
            }
        });
    }

    /** 下载到缓存，边下边算 sha256；对不上、包名或版本号不对、出错、取消都删掉文件抛 Failure */
    private File save(Release release, AtomicBoolean cancelled, IntConsumer percent) throws Failure {
        File apk = new File(folder, "yongle-erp-" + release.versionCode + ".apk");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            fetchApk(release.apkUrl, apk, digest, cancelled, percent);
            if (!hex(digest.digest()).equals(release.sha256)) throw new Failure(R.string.update_bad_package, "sha256 对不上");
            if (!isThisApp(apk, release.versionCode)) throw new Failure(R.string.update_bad_package, "包名或版本号对不上");
            return apk;
        } catch (Failure e) {
            discard(apk);
            throw e;
        } catch (IOException | NoSuchAlgorithmException | RuntimeException e) {
            // 取消时 fetchApk 抛 CancellationException，也走这里（不提示）
            discard(apk);
            throw new Failure(R.string.update_download_failed, String.valueOf(e));
        }
    }

    private static void fetchApk(String url, File apk, MessageDigest digest, AtomicBoolean cancelled, IntConsumer percent) throws IOException {
        Shell.ensureParent(apk);
        HttpURLConnection connection = open(url);
        long length = connection.getContentLengthLong();
        if (length > APK_MAX_BYTES) {
            connection.disconnect();
            throw new Shell.TooLarge(APK_MAX_BYTES);
        }
        int[] shown = {-1};
        try (InputStream in = new DigestInputStream(connection.getInputStream(), digest);
                OutputStream out = Files.newOutputStream(apk.toPath())) {
            Shell.copy(in, out, APK_MAX_BYTES, total -> {
                if (cancelled.get()) throw new CancellationException();
                int p = length > 0 ? (int) (total * PERCENT / length) : -1;
                if (p < 0 || p == shown[0]) return;
                shown[0] = p;
                percent.accept(p);
            });
        } finally {
            connection.disconnect();
        }
    }

    /** 安装包确实是这个应用的这个版本（系统装的时候还会核对签名） */
    @SuppressWarnings("deprecation") // 带 PackageInfoFlags 的写法安卓 13 起才有，minSdk 是 29
    private boolean isThisApp(File apk, int versionCode) {
        PackageInfo info = activity.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        return info != null && activity.getPackageName().equals(info.packageName) && info.getLongVersionCode() == versionCode;
    }

    /** 下载核对好了：交给系统安装器；还没允许“安装未知应用”就（在后台）记下待装的版本、带用户去设置里允许，回来（resume）再装 */
    private void install(File apk, int versionCode) {
        if (activity.getPackageManager().canRequestPackageInstalls()) {
            WORKER.execute(() -> commitOrReport(apk));
            return;
        }
        WORKER.execute(() -> prefs.edit().putString(PENDING_FILE, apk.getPath()).putInt(PENDING_VERSION, versionCode).apply());
        openInstallSettings();
    }

    /** 后台：忘掉待装记录（交给安装器后由系统页面接着办，取消了下次冷启动再提示），提交；没成提示 */
    private void commitOrReport(File apk) {
        forget();
        try {
            commit(apk);
        } catch (IOException | RuntimeException e) {
            Log.w(Shell.TAG, "交给系统安装器没成功：" + e);
            onMain(() -> Shell.toast(activity, activity.getString(R.string.update_not_installed)));
        }
    }

    private void forget() {
        prefs.edit().remove(PENDING_FILE).remove(PENDING_VERSION).apply();
    }

    private void openInstallSettings() {
        try {
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
            Shell.toast(activity, activity.getString(R.string.update_allow_install));
        } catch (ActivityNotFoundException e) {
            Shell.toast(activity, activity.getString(R.string.update_allow_install_manually));
        }
    }

    /** 把安装包写进安装会话再提交；写的时候出错就放弃这个会话，不留在系统里 */
    private void commit(File apk) throws IOException {
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        int id = installer.createSession(new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL));
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try {
                try (OutputStream out = session.openWrite("base.apk", 0, apk.length())) {
                    Files.copy(apk.toPath(), out);
                    session.fsync(out);
                }
                session.commit(InstallStatusReceiver.pendingIntent(activity).getIntentSender());
            } catch (IOException | RuntimeException e) {
                session.abandon();
                throw e;
            }
        }
    }

    /** 后台：清掉缓存里的安装包，只留记着待装、比当前新的那一份（装好新版后旧包都用不着了） */
    private void cleanup() {
        String pending = prefs.getInt(PENDING_VERSION, 0) > currentVersion ? prefs.getString(PENDING_FILE, null) : null;
        File[] apks = folder.listFiles();
        if (apks == null) return;
        for (File apk : apks) {
            if (!apk.getPath().equals(pending)) discard(apk);
        }
    }

    private static void discard(File file) {
        if (file.exists() && !file.delete()) Log.w(Shell.TAG, "安装包没删掉：" + file.getName());
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        int code = connection.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) {
            connection.disconnect();
            throw new IOException("服务器回了 " + code);
        }
        return connection;
    }

    private static byte[] fetch(String url) throws IOException {
        HttpURLConnection connection = open(url);
        try (InputStream in = connection.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            Shell.copy(in, out, MANIFEST_MAX_BYTES);
            return out.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    private void onMain(Runnable action) {
        Shell.onMain(activity, action);
    }
}
