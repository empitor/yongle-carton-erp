package cn.nbyongle.erp;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** 共用小件：限长复制、建上级目录、落在目录里、文件名清洗 */
public class ShellTest {
    @Rule
    public final TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void copyReturnsTheByteCountAndAllowsExactlyTheLimit() throws IOException {
        byte[] data = new byte[100_000];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        assertEquals(data.length, Shell.copy(new ByteArrayInputStream(data), out, data.length));
        assertArrayEquals(data, out.toByteArray());
    }

    @Test
    public void copyStopsWhenOverTheLimit() {
        ByteArrayInputStream in = new ByteArrayInputStream(new byte[11]);
        assertThrows(Shell.TooLarge.class, () -> Shell.copy(in, new ByteArrayOutputStream(), 10));
    }

    @Test
    public void copyRefusesAMissingStream() {
        assertThrows(IOException.class, () -> Shell.copy(null, new ByteArrayOutputStream(), 10));
    }

    @Test
    public void ensureParentCreatesMissingFolders() throws IOException {
        File target = new File(temp.getRoot(), "a/b/c.txt");
        Shell.ensureParent(target);
        assertTrue(Files.isDirectory(target.getParentFile().toPath()));
    }

    @Test
    public void onlyFilesReallyInsideTheFolderCountAsInside() throws IOException {
        File dir = temp.newFolder("share");
        assertTrue(Shell.isInside(dir, new File(dir, "0.pdf")));
        assertFalse(Shell.isInside(dir, new File(dir, "../x.pdf")));
        assertFalse(Shell.isInside(dir, new File(dir, "0-/../../shared_prefs/x.pdf")));
        assertFalse(Shell.isInside(dir, dir));
    }

    @Test
    public void namesKeepOnlyTheLastPathSegment() {
        assertEquals("x.pdf", Shell.safeName("/../../../../shared_prefs/x.pdf"));
        assertEquals("报价单.xlsx", Shell.safeName("C:\\Users\\某人\\报价单.xlsx"));
        assertEquals("a.pdf", Shell.safeName("/a.pdf"));
    }

    @Test
    public void controlAndInvisibleCharactersAreRemoved() {
        assertEquals("a.pdf", Shell.safeName("a\u0000.pdf"));
        assertEquals("订单.pdf", Shell.safeName("订\n单\u202e.pdf"));
    }

    @Test
    public void pathOnlyNamesBecomeEmpty() {
        assertEquals("", Shell.safeName(".."));
        assertEquals("", Shell.safeName("a/"));
        assertEquals("", Shell.safeName("  "));
        assertEquals("", Shell.safeName(null));
    }

    /** 文件名上限按 UTF-8 字节算（一个汉字 3 字节），截到 255 字节以内，扩展名留着 */
    @Test
    public void longNamesAreCutToTheByteLimitKeepingTheExtension() {
        String name = Shell.safeName("长".repeat(300) + ".pdf");
        int bytes = name.getBytes(StandardCharsets.UTF_8).length;
        assertTrue(bytes <= Shell.MAX_NAME_BYTES);
        assertTrue(bytes + 3 > Shell.MAX_NAME_BYTES);
        assertTrue(name.endsWith("长.pdf"));
    }

    @Test
    public void namesWithinTheByteLimitAreKept() {
        String name = "长".repeat(80) + ".xlsx";
        assertEquals(name, Shell.safeName(name));
    }

    /** 四字节的字符（表情这类）不会被截成半个 */
    @Test
    public void cuttingNeverSplitsACharacter() {
        String name = Shell.safeName("😀".repeat(100) + ".pdf");
        assertEquals(name, new String(name.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8));
        assertTrue(name.getBytes(StandardCharsets.UTF_8).length <= Shell.MAX_NAME_BYTES);
    }
}
