package cn.nbyongle.erp;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.Test;

/** 网页要保存的文件：编号、名字、内容怎么核对，类型怎么认 */
public class FileSaverTest {
    private static final String ABC = Base64.getEncoder().encodeToString("ABC".getBytes(StandardCharsets.UTF_8));

    @Test
    public void validRequestIsDecoded() {
        FileSaver.Checked checked = FileSaver.check(3, "送货单.xlsx", ABC);
        assertNull(checked.problem);
        assertEquals("送货单.xlsx", checked.name);
        assertArrayEquals("ABC".getBytes(StandardCharsets.UTF_8), checked.bytes);
    }

    @Test
    public void idMustBeAPositiveInteger() {
        assertEquals(FileSaver.Problem.BAD_ID, FileSaver.check(0, "a.pdf", ABC).problem);
        assertEquals(FileSaver.Problem.BAD_ID, FileSaver.check(-1, "a.pdf", ABC).problem);
        assertEquals(FileSaver.Problem.BAD_ID, FileSaver.check(1.5, "a.pdf", ABC).problem);
        assertEquals(FileSaver.Problem.BAD_ID, FileSaver.check("1", "a.pdf", ABC).problem);
        assertEquals(FileSaver.Problem.BAD_ID, FileSaver.check(null, "a.pdf", ABC).problem);
    }

    /** 和分享收文件用同一个清洗：只留最后一段、去掉控制字符 */
    @Test
    public void nameIsCleanedLikeSharedFiles() {
        assertEquals("送货单.xlsx", FileSaver.check(1, "../../x/送货单\u0000.xlsx", ABC).name);
        assertEquals(FileSaver.Problem.BAD_NAME, FileSaver.check(1, "..", ABC).problem);
        assertEquals(FileSaver.Problem.BAD_NAME, FileSaver.check(1, null, ABC).problem);
    }

    @Test
    public void contentMustBeBase64() {
        assertEquals(FileSaver.Problem.BAD_DATA, FileSaver.check(1, "a.pdf", "不是 base64").problem);
        assertEquals(FileSaver.Problem.BAD_DATA, FileSaver.check(1, "a.pdf", null).problem);
    }

    @Test
    public void contentUpToTheLimitIsKept() {
        String data = Base64.getEncoder().encodeToString(new byte[(int) FileSaver.MAX_BYTES]);
        assertNull(FileSaver.check(1, "a.pdf", data).problem);
    }

    @Test
    public void contentOverTheLimitIsRefused() {
        String data = Base64.getEncoder().encodeToString(new byte[(int) FileSaver.MAX_BYTES + 1]);
        assertEquals(FileSaver.Problem.TOO_LARGE, FileSaver.check(1, "a.pdf", data).problem);
    }

    @Test
    public void mimeKeepsOnlyTypeAndSubtype() {
        assertEquals("text/csv", FileSaver.mimeOf("text/csv;charset=utf-8"));
        assertEquals("application/octet-stream", FileSaver.mimeOf(""));
        assertEquals("application/octet-stream", FileSaver.mimeOf("a\n/b"));
    }
}
