package cn.nbyongle.erp;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** 返回键：先走哪一步、只认正在等的那次回执、首页连按两次才退出 */
public class BackKeyTest {
    private static final long NOW = 10_000;

    @Test
    public void offlineScreenIsTreatedAsHome() {
        assertEquals(BackKey.Step.HOME, BackKey.stepOf(true, true, true));
    }

    @Test
    public void connectedPageIsAskedFirst() {
        assertEquals(BackKey.Step.ASK_PAGE, BackKey.stepOf(false, true, true));
    }

    /** 点开图片原件这类不是 ERP 的页面时没有通道：后退回到 ERP，不能困在那一页 */
    @Test
    public void withoutTheBridgeTheWebViewGoesBack() {
        assertEquals(BackKey.Step.GO_BACK, BackKey.stepOf(false, false, true));
    }

    @Test
    public void withoutTheBridgeAndHistoryItIsHome() {
        assertEquals(BackKey.Step.HOME, BackKey.stepOf(false, false, false));
    }

    @Test
    public void replyWithoutAnIdIsIgnoredEvenBeforeAnyRequest() {
        assertEquals(BackKey.Action.NONE, new BackKey().onResult(0, BackKey.HOME, NOW));
    }

    @Test
    public void aReplyCountsOnlyOnce() {
        BackKey back = new BackKey();
        back.nextRequest();
        assertEquals(BackKey.Action.HINT, back.onResult(1, BackKey.HOME, NOW));
        assertEquals(BackKey.Action.NONE, back.onResult(1, BackKey.HOME, NOW + 1));
    }

    @Test
    public void firstBackOnHomeOnlyShowsTheExitHint() {
        assertEquals(BackKey.Action.HINT, new BackKey().onHome(NOW));
    }

    @Test
    public void secondBackWithinTheWindowExits() {
        BackKey back = new BackKey();
        back.onHome(NOW);
        assertEquals(BackKey.Action.EXIT, back.onHome(NOW + BackKey.EXIT_WINDOW_MS));
    }

    @Test
    public void backAfterTheWindowStartsOverWithTheHint() {
        BackKey back = new BackKey();
        back.onHome(NOW);
        assertEquals(BackKey.Action.HINT, back.onHome(NOW + BackKey.EXIT_WINDOW_MS + 1));
    }

    @Test
    public void requestsCarryIncreasingIds() {
        BackKey back = new BackKey();
        assertEquals("{\"type\":\"back\",\"id\":1}", back.nextRequest());
        assertEquals("{\"type\":\"back\",\"id\":2}", back.nextRequest());
    }

    @Test
    public void homeReplyToTheLatestRequestShowsTheHint() {
        BackKey back = new BackKey();
        back.nextRequest();
        assertEquals(BackKey.Action.HINT, back.onResult(1, BackKey.HOME, NOW));
    }

    @Test
    public void replyToAnOlderRequestIsIgnored() {
        BackKey back = new BackKey();
        back.nextRequest();
        back.nextRequest();
        assertEquals(BackKey.Action.NONE, back.onResult(1, BackKey.HOME, NOW));
    }

    @Test
    public void handledReplyClearsTheExitHint() {
        BackKey back = new BackKey();
        back.onHome(NOW);
        back.nextRequest();
        assertEquals(BackKey.Action.NONE, back.onResult(1, "handled", NOW + 1));
        assertEquals(BackKey.Action.HINT, back.onHome(NOW + 2));
    }

    @Test
    public void pageChangeClearsTheExitHint() {
        BackKey back = new BackKey();
        back.onHome(NOW);
        back.reset();
        assertEquals(BackKey.Action.HINT, back.onHome(NOW + 1));
    }
}
