package cn.nbyongle.erp;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 安装结果里给的 Intent：只打开系统的安装确认页 */
public class InstallStatusReceiverTest {
    @Test
    public void systemInstallConfirmationIsOpened() {
        assertTrue(InstallStatusReceiver.isInstallConfirmation("android.content.pm.action.CONFIRM_INSTALL"));
    }

    @Test
    public void anyOtherIntentIsNotOpened() {
        assertFalse(InstallStatusReceiver.isInstallConfirmation("android.intent.action.VIEW"));
        assertFalse(InstallStatusReceiver.isInstallConfirmation(null));
    }
}
