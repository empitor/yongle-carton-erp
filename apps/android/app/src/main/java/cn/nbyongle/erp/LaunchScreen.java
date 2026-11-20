package cn.nbyongle.erp;

import android.graphics.drawable.Animatable;
import android.os.SystemClock;
import android.view.View;
import android.widget.ImageView;
import java.util.function.BooleanSupplier;

/**
 * 冷启动的启动画面（layout 里盖在最上面的 launch）：放商标动画（splash_logo.xml，Y、L 两个图形靠拢 0.9 秒），网页同时在后面加载。
 * 等窗口打开动画放完才开始放（入口在 onEnterAnimationComplete 里调 start；最晚 START_FALLBACK_MS 自己开始）——
 * 放早了窗口还在系统放大打开的过程里，看不到靠拢。放够 HOLD_MS、且网页好了（或最多等 WAIT_MS）后，先淡出图标、底色还盖着，
 * 再淡掉底色，图标不叠在内容上。只由入口调用。
 */
final class LaunchScreen {
    static final long HOLD_MS = 1300, WAIT_MS = 5000;
    private static final long FADE_MS = 200, POLL_MS = 50, START_FALLBACK_MS = 800;

    private final View launch;
    private final ImageView logo;
    /** 网页好了没有（ERP 页面加载完，或盖上了离线页） */
    private final BooleanSupplier ready;
    private boolean started;

    LaunchScreen(View launch, ImageView logo, BooleanSupplier ready) {
        this.launch = launch;
        this.logo = logo;
        this.ready = ready;
    }

    /** 冷启动：等窗口打开动画放完（start），最晚 START_FALLBACK_MS 后自己开始 */
    void arm() {
        launch.postDelayed(this::start, START_FALLBACK_MS);
    }

    /** 进程被系统收回后恢复：不放启动画面 */
    void skip() {
        launch.setVisibility(View.GONE);
    }

    /** 开始放；已经放过、或已经撤掉了就不再放 */
    void start() {
        if (started || launch.getVisibility() != View.VISIBLE) return;
        started = true;
        ((Animatable) logo.getDrawable()).start();
        long begin = SystemClock.uptimeMillis();
        launch.post(() -> leaveWhenReady(begin));
    }

    /** 放了 shown 毫秒后能不能退场：至少放够 HOLD_MS，并且网页好了或已经等了 WAIT_MS */
    static boolean canLeave(long shown, boolean pageReady) {
        return shown >= HOLD_MS && (pageReady || shown > WAIT_MS);
    }

    private void leaveWhenReady(long begin) {
        if (!canLeave(SystemClock.uptimeMillis() - begin, ready.getAsBoolean())) {
            launch.postDelayed(() -> leaveWhenReady(begin), POLL_MS);
            return;
        }
        Runnable hide = () -> launch.animate().alpha(0f).setDuration(FADE_MS).withEndAction(() -> launch.setVisibility(View.GONE)).start();
        logo.animate().alpha(0f).setDuration(FADE_MS).withEndAction(hide).start();
    }
}
