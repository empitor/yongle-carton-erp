package cn.nbyongle.erp;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

/**
 * 系统安装器的结果。清单里登记、不导出（exported=false）：只有系统按外壳自己给的 PendingIntent 投来，别的应用发不进来。
 * 要用户确认就打开系统的确认页（只认安装确认、去掉一切授权标志再打开）；没装上就提示。装成功后应用被替换，收不到成功。
 */
public final class InstallStatusReceiver extends BroadcastReceiver {
    /** 系统安装器要用户确认时给的 Intent 的 action（PackageInstaller.ACTION_CONFIRM_INSTALL 是系统接口，SDK 里没有，只能写字面值） */
    static final String CONFIRM_INSTALL = "android.content.pm.action.CONFIRM_INSTALL";
    private static final int GRANTS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;

    /** 交给安装会话的回执：显式指向本接收器；系统要往里填结果，所以可变（安卓 12 起要明写） */
    static PendingIntent pendingIntent(Context context) {
        int mutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        Intent intent = new Intent(context, InstallStatusReceiver.class);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutable);
    }

    /** 只打开系统的安装确认页 */
    static boolean isInstallConfirmation(String action) {
        return CONFIRM_INSTALL.equals(action);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) confirm(context, intent);
        else if (status != PackageInstaller.STATUS_SUCCESS) failed(context, status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
    }

    /** 带类型的 getParcelableExtra(String, Class) 安卓 13 起才有，minSdk 是 29，所以用旧写法 */
    @SuppressWarnings("deprecation")
    private static void confirm(Context context, Intent intent) {
        Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
        if (confirm == null || !isInstallConfirmation(confirm.getAction())) {
            Log.w(Shell.TAG, "安装器给的确认页不对，没有打开：" + (confirm == null ? null : confirm.getAction()));
            Shell.toast(context, context.getString(R.string.update_not_installed));
            return;
        }
        confirm.removeFlags(GRANTS);
        confirm.setClipData(null);
        try {
            context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException e) {
            // 个别系统找不到确认页、或不让从后台打开时会抛：提示没装上，不能让接收器把应用带崩
            Log.w(Shell.TAG, "打不开系统的安装确认页：" + e);
            Shell.toast(context, context.getString(R.string.update_not_installed));
        }
    }

    /** 没装上：用户在系统页面点了取消就不再提示；其余记日志（系统给的原因是英文）、提示没装上 */
    private static void failed(Context context, int status, String why) {
        Log.w(Shell.TAG, "系统安装器没装上：" + status + " " + why);
        if (status != PackageInstaller.STATUS_FAILURE_ABORTED) Shell.toast(context, context.getString(R.string.update_not_installed));
    }
}
