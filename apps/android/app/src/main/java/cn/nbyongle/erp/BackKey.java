package cn.nbyongle.erp;

/**
 * 返回键的规则和状态（纯 Java）：这次返回该问网页、让网页后退还是按首页处理；问网页时的请求编号，回执只认正在等的那一个、
 * 认一次就作废；首页上提示后 EXIT_WINDOW_MS 内再按才退出。提示、退出、后退这些动作由入口按返回值去做。
 */
final class BackKey {
    /** 按下返回时先走哪一步：问网页（发 back）、网页后退一页、按首页处理 */
    enum Step { ASK_PAGE, GO_BACK, HOME }

    /** 入口要做的事：什么都不做、提示“再按一次返回退出”、退出 */
    enum Action { NONE, HINT, EXIT }

    /** 外壳问网页的消息、网页的回执、回执里“已在首页”的值 */
    static final String BACK = "back";
    static final String RESULT = "back-result";
    static final String HOME = "home";
    /** 首页提示“再按一次返回退出”后，多久内再按算退出 */
    static final long EXIT_WINDOW_MS = 2000;

    /** 发过的最大编号；正在等回执的编号（0 表示没在等） */
    private int lastRequest;
    private int waiting;
    /** 首页上一次按返回的时刻（uptimeMillis）；-1 表示还没按过或已重置 */
    private long lastPress = -1;

    /**
     * 按下返回：盖着外壳的离线页时按首页处理；通道接通了就问网页（关最上面一层、回“今日”、或已在首页）；
     * 没接通（点开了图片原件这类不是 ERP 的页面、页面还在加载、ERP 是没有通道的旧版本）时能后退就后退，不能就按首页处理。
     */
    static Step stepOf(boolean offline, boolean bridgeReady, boolean canGoBack) {
        if (offline) return Step.HOME;
        if (bridgeReady) return Step.ASK_PAGE;
        return canGoBack ? Step.GO_BACK : Step.HOME;
    }

    /** 首页上按返回：没提示过或已超时就提示，提示后 EXIT_WINDOW_MS 内再按就退出；lastPress 为 -1 表示没提示过 */
    private static Action backAction(long now, long lastPress) {
        return lastPress >= 0 && now - lastPress <= EXIT_WINDOW_MS ? Action.EXIT : Action.HINT;
    }

    /** 新的一次返回请求：编号加一并开始等它的回执，返回发给网页的消息 */
    String nextRequest() {
        waiting = ++lastRequest;
        return "{\"type\":\"" + BACK + "\",\"id\":" + waiting + "}";
    }

    /** 网页的回执：home 表示已在首页、没有弹层；handled 表示关了一层、回了今日，或被提交中、未保存提醒拦下 */
    Action onResult(int id, String result, long now) {
        if (id <= 0 || id != waiting) return Action.NONE;
        waiting = 0;
        if (HOME.equals(result)) return onHome(now);
        lastPress = -1;
        return Action.NONE;
    }

    /** 已在首页时按返回 */
    Action onHome(long now) {
        Action action = backAction(now, lastPress);
        if (action == Action.HINT) lastPress = now;
        return action;
    }

    /** 页面变了：“再按一次退出”的提示作废 */
    void reset() {
        lastPress = -1;
    }
}
