package cn.nbyongle.erp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** 分享进来的文件收不收、落盘叫什么、交来的东西怎么筛 */
public class ShareInboxTest {
    @Test
    public void supportedExtensionsAreAcceptedAsIs() {
        assertEquals("客户订单.PDF", ShareInbox.acceptedName("客户订单.PDF", "pdf"));
        assertEquals("送货单.xlsx", ShareInbox.acceptedName("送货单.xlsx", null));
    }

    @Test
    public void nameWithoutExtensionGetsOneFromTheSystemType() {
        assertEquals("微信图片_20261117.jpg", ShareInbox.acceptedName("微信图片_20261117", "jpg"));
    }

    /** 落盘名和对方给的名字无关：名字里的 /、..、NUL 碰不到缓存目录 */
    @Test
    public void storedNameIsTheIndexAndTheExtensionOnly() {
        assertEquals("0.pdf", ShareInbox.storedName(0, "客户订单.PDF"));
        assertEquals("3.jpg", ShareInbox.storedName(3, ShareInbox.acceptedName(Shell.safeName("/../../x\u0000/a..jpg"), null)));
    }

    /** 别的应用在 EXTRA_STREAM 里混进 Intent、Bundle、字符串这类别的东西：跳过，不能抛异常让应用闪退 */
    @Test
    public void itemsThatAreNotUrisAreSkippedWithoutThrowing() {
        assertEquals(List.of(), ShareInbox.contentUris(Arrays.asList(new Object(), "content://x/1", 42, null)));
    }

    /** 没给读权限时名字、类型都拿不到（名字只剩地址最后一段）：算读不到，不说成格式不支持 */
    @Test
    public void missingNameAndTypeMeansUnreadable() {
        assertEquals(ShareInbox.Refusal.UNREADABLE, ShareInbox.formatRefusal(null, null));
    }

    @Test
    public void knownNameOrTypeOutsideTheListMeansUnsupported() {
        assertEquals(ShareInbox.Refusal.UNSUPPORTED, ShareInbox.formatRefusal("说明.txt", "text/plain"));
        assertEquals(ShareInbox.Refusal.UNSUPPORTED, ShareInbox.formatRefusal(null, "text/plain"));
        assertEquals(ShareInbox.Refusal.UNSUPPORTED, ShareInbox.formatRefusal("说明.txt", null));
    }

    @Test
    public void unsupportedFormatsAreRejected() {
        assertNull(ShareInbox.acceptedName("说明.txt", "txt"));
        assertNull(ShareInbox.acceptedName("安装包.apk", "pdf"));
        assertNull(ShareInbox.acceptedName("没有扩展名", null));
    }
}
