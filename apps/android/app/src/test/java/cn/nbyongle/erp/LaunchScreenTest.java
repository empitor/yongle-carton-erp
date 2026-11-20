package cn.nbyongle.erp;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 启动画面什么时候退场：放够时长，并且网页好了或等到上限 */
public class LaunchScreenTest {
    @Test
    public void staysUntilTheLogoAnimationHasPlayed() {
        assertFalse(LaunchScreen.canLeave(LaunchScreen.HOLD_MS - 1, true));
    }

    @Test
    public void leavesOnceThePageIsReady() {
        assertTrue(LaunchScreen.canLeave(LaunchScreen.HOLD_MS, true));
    }

    @Test
    public void waitsForASlowPageUpToTheLimit() {
        assertFalse(LaunchScreen.canLeave(LaunchScreen.WAIT_MS, false));
        assertTrue(LaunchScreen.canLeave(LaunchScreen.WAIT_MS + 1, false));
    }
}
