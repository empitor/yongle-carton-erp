package cn.nbyongle.erp;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 系统栏图标深浅跟着网页最上、最下一行的底色 */
public class SystemBarsTest {
    @Test
    public void lightPageTopsGetDarkStatusBarIcons() {
        assertTrue(SystemBars.wantsDarkIcons(0xFFFFFFFF));
        assertTrue(SystemBars.wantsDarkIcons(0xFFF4F1EC));
    }

    @Test
    public void darkPageTopsGetLightStatusBarIcons() {
        assertFalse(SystemBars.wantsDarkIcons(0xFF1F3D44));
        assertFalse(SystemBars.wantsDarkIcons(0xFF1C1D20));
        assertFalse(SystemBars.wantsDarkIcons(0xFF000000));
    }
}
