package cn.nbyongle.erp;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.graphics.Rect;
import android.os.Build;
import android.util.Log;
import android.view.PixelCopy;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import java.util.Objects;

/**
 * 系统栏：安卓 11 起窗口画到系统栏后面，网页让出状态栏、导航栏、刘海和键盘的位置，让出的上下两块垫上色带；
 * 网页（或离线页）每次重画后稍等一会儿读网页最上、最下一行的颜色给色带，并按底色深浅切换系统栏图标。只由入口调用。
 */
final class SystemBars {
    /** 重画后隔多久取一次上下两行的颜色（只读 1 像素宽的一条）、避开最边上几行（分隔线）；底色亮度超过 LUMA 时图标用深色 */
    private static final long SAMPLE_DELAY_MS = 250;
    private static final int SAMPLE_INSET_PX = 2, LIGHT_BACKGROUND_LUMA = 150;

    private final Activity activity;
    /** 窗口的内容层（layout 用 merge 直接挂在它下面）、网页加离线页那一层、状态栏和导航栏后面的两条色带 */
    private final View root, page, statusShade, navShade;
    private int topColor, bottomColor;
    /** 排着一次取色；窗口看不见了（onStop 到 onStart 之间） */
    private boolean sampleScheduled, stopped;

    SystemBars(Activity activity) {
        this.activity = activity;
        root = activity.findViewById(android.R.id.content);
        page = activity.findViewById(R.id.page);
        statusShade = activity.findViewById(R.id.status_shade);
        navShade = activity.findViewById(R.id.nav_shade);
    }

    /** 底色够亮时系统栏图标用深色（颜色是 0xAARRGGBB，按人眼亮度粗算到 0–255） */
    static boolean wantsDarkIcons(int color) {
        int luma = 299 * ((color >> 16) & 0xFF) + 587 * ((color >> 8) & 0xFF) + 114 * (color & 0xFF);
        return luma / 1000 > LIGHT_BACKGROUND_LUMA;
    }

    /** 让出系统栏位置、先垫上 color、之后每次重画都取色 */
    void start(int color) {
        fit();
        paint(color, color, true);
        root.getViewTreeObserver().addOnDrawListener(this::schedule);
    }

    /**
     * 安卓 11 起窗口画到系统栏后面：网页让出状态栏、导航栏、刘海和键盘的位置，让出的上下两块由色带填上。
     * setDecorFitsSystemWindows 从安卓 15 起过时（targetSdk 35 起系统强制画到系统栏后面），安卓 11–14 还得调，所以压下过时提示。
     */
    @SuppressWarnings("deprecation")
    private void fit() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        activity.getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int types = WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout();
            Insets bars = insets.getInsets(types);
            FrameLayout.LayoutParams area = (FrameLayout.LayoutParams) page.getLayoutParams();
            area.setMargins(bars.left, bars.top, bars.right, bars.bottom);
            statusShade.getLayoutParams().height = bars.top;
            navShade.getLayoutParams().height = bars.bottom;
            page.setLayoutParams(area);
            return WindowInsets.CONSUMED;
        });
    }

    /** 窗口看不见了（onStop）：不再取色，窗口没有画面时取色会出错 */
    void stop() {
        stopped = true;
    }

    /** 窗口又看得见了（onStart）：补取一次 */
    void resume() {
        stopped = false;
        schedule();
    }

    /** 网页（或离线页）重画过就在稍后取一次色；排着一次时不再重复排 */
    private void schedule() {
        if (sampleScheduled) return;
        sampleScheduled = true;
        root.postDelayed(this::sample, SAMPLE_DELAY_MS);
    }

    /** 从屏幕上读网页最上、最下一行左边的像素颜色（只看画出来的结果），给状态栏、导航栏垫同样的底色 */
    private void sample() {
        sampleScheduled = false;
        if (stopped || activity.isDestroyed() || page.getHeight() <= 2 * SAMPLE_INSET_PX) return;
        int[] at = new int[2];
        page.getLocationInWindow(at);
        Rect column = new Rect(at[0], at[1], at[0] + 1, at[1] + page.getHeight());
        Bitmap pixels = Bitmap.createBitmap(1, column.height(), Bitmap.Config.ARGB_8888);
        try {
            PixelCopy.request(activity.getWindow(), column, pixels, result -> {
                if (result != PixelCopy.SUCCESS || activity.isDestroyed()) return;
                int bottom = pixels.getPixel(0, pixels.getHeight() - 1 - SAMPLE_INSET_PX);
                paint(pixels.getPixel(0, SAMPLE_INSET_PX), bottom, false);
            }, root.getHandler());
        } catch (IllegalArgumentException e) {
            // 窗口正好没有画面（刚切到后台、刚打开别的界面）时系统会抛这个：这次不取，下次重画再取
            Log.w(Shell.TAG, "这次没取到系统栏颜色：" + e.getMessage());
        }
    }

    private void paint(int top, int bottom, boolean force) {
        if (!force && top == topColor && bottom == bottomColor) return;
        topColor = top;
        bottomColor = bottom;
        root.setBackgroundColor(top);
        statusShade.setBackgroundColor(top);
        navShade.setBackgroundColor(bottom);
        setIcons(top, bottom);
    }

    /** 安卓 11 起按底色切换图标深浅；安卓 10 走 paintWindowBars */
    private void setIcons(int top, int bottom) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            paintWindowBars(top, bottom);
            return;
        }
        int both = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        int wanted = (wantsDarkIcons(top) ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0)
                | (wantsDarkIcons(bottom) ? WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS : 0);
        Objects.requireNonNull(activity.getWindow().getInsetsController()).setSystemBarsAppearance(wanted, both);
    }

    /** 安卓 10：系统栏颜色和图标深浅设在窗口上（这几个接口在新系统上已不起作用，只走这一支） */
    @SuppressWarnings("deprecation")
    private void paintWindowBars(int top, int bottom) {
        Window window = activity.getWindow();
        window.setStatusBarColor(top);
        window.setNavigationBarColor(bottom);
        View decor = window.getDecorView();
        int flags = decor.getSystemUiVisibility() & ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        if (wantsDarkIcons(top)) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (wantsDarkIcons(bottom)) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        decor.setSystemUiVisibility(flags);
    }
}
