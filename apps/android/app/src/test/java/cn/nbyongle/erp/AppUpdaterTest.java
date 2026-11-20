package cn.nbyongle.erp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.junit.Test;

/** 版本清单里的新版本能不能用、校验值怎么算 */
public class AppUpdaterTest {
    private static final String SHA = "a".repeat(64);

    private static AppUpdater.Release release(int code, String url, String sha) {
        return new AppUpdater.Release(code, "0.2.0", url, sha, "");
    }

    @Test
    public void newerReleaseWithUrlAndChecksumIsOffered() {
        assertNull(AppUpdater.problemOf(release(2, "https://example.invalid/yongle-erp.apk", SHA), 1));
    }

    @Test
    public void sameOrOlderVersionIsNotOffered() {
        assertEquals("不比当前版本新", AppUpdater.problemOf(release(1, "https://example.invalid/a.apk", SHA), 1));
        assertEquals("不比当前版本新", AppUpdater.problemOf(release(1, "https://example.invalid/a.apk", SHA), 2));
    }

    @Test
    public void releaseWithoutChecksumOrWithOddUrlIsRefused() {
        assertEquals("缺校验值", AppUpdater.problemOf(release(2, "https://example.invalid/a.apk", ""), 1));
        assertEquals("缺校验值", AppUpdater.problemOf(release(2, "https://example.invalid/a.apk", "ABC"), 1));
        assertEquals("下载地址不对", AppUpdater.problemOf(release(2, "file:///sdcard/a.apk", SHA), 1));
    }

    @Test
    public void hexMatchesTheUsualSha256Text() throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest("abc".getBytes(StandardCharsets.UTF_8));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", AppUpdater.hex(digest));
    }
}
