package cn.nbyongle.erp;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** 网页文件框的 accept 怎么换成系统选择器的文件类型、什么时候给相册和拍照、选择结果交回什么 */
public class FileChooserTest {
    /** 代替系统的 MimeTypeMap（单元测试里没有） */
    private static final Map<String, String> SYSTEM = new HashMap<>();

    static {
        SYSTEM.put("pdf", "application/pdf");
        SYSTEM.put("jpg", "image/jpeg");
        SYSTEM.put("jpeg", "image/jpeg");
        SYSTEM.put("png", "image/png");
        SYSTEM.put("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        SYSTEM.put("csv", "text/comma-separated-values");
    }

    private static String[] mimes(String... accept) {
        return FileChooser.mimeTypesOf(accept, SYSTEM::get);
    }

    @Test
    public void extensionsBecomeSystemTypesWithoutDuplicates() {
        // AI 导入的写法：一整串逗号分隔的扩展名（WebView 有时拆开、有时原样给）
        assertArrayEquals(new String[] {"application/pdf", "image/jpeg", "image/png"}, mimes(".pdf,.jpg,.jpeg,.png"));
        assertArrayEquals(new String[] {"application/pdf", "image/jpeg"}, mimes(".PDF", " .jpg "));
    }

    @Test
    public void mimeTypesInAcceptAreKeptAsWritten() {
        assertArrayEquals(new String[] {"image/*"}, mimes("image/*"));
    }

    @Test
    public void csvGetsBothCommonTypesSoFileManagersShowIt() {
        assertArrayEquals(new String[] {"text/comma-separated-values", "text/csv"}, mimes(".csv"));
    }

    @Test
    public void unknownOrMissingAcceptMeansAnyFile() {
        assertArrayEquals(new String[0], mimes(""));
        assertArrayEquals(new String[0], mimes(".unknownext"));
        assertArrayEquals(new String[0], FileChooser.mimeTypesOf(null, SYSTEM::get));
    }

    @Test
    public void imageCapableInputsGetGalleryAndCamera() {
        assertTrue(FileChooser.acceptsImages(mimes(".pdf,.jpg")));
        assertTrue(FileChooser.acceptsImages(mimes("image/*")));
        assertTrue(FileChooser.acceptsImages(mimes("")));
    }

    @Test
    public void documentOnlyInputsDoNotOfferCamera() {
        assertFalse(FileChooser.acceptsImages(mimes(".csv,.xlsx")));
    }

    private static List<String> chosen(boolean ok, List<String> picked, String photo, boolean photoSurelyEmpty) {
        return FileChooser.chosen(ok, picked, photo, p -> photoSurelyEmpty);
    }

    @Test
    public void cancelGivesNothing() {
        assertEquals(List.of(), chosen(false, Arrays.asList("a"), "photo", false));
    }

    @Test
    public void pickedFilesAreGivenWithoutEmptyEntries() {
        assertEquals(List.of("a", "b"), chosen(true, Arrays.asList("a", null, "b"), "photo", false));
    }

    /** 相机一般不回 data：给了相机位置、照片不确定是空的就算拍成了（说不准时照常交，不删可能拍成的照片） */
    @Test
    public void cameraWithoutDataGivesThePhoto() {
        assertEquals(List.of("photo"), chosen(true, Arrays.asList((String) null), "photo", false));
        assertEquals(List.of("photo"), chosen(true, List.of("photo"), "photo", false));
    }

    /** 相机回了“成功”却一个字节都没写：不把空图交给网页 */
    @Test
    public void surelyEmptyPhotoIsNotGiven() {
        assertEquals(List.of(), chosen(true, List.of(), "photo", true));
        assertEquals(List.of(), chosen(true, List.of("photo"), "photo", true));
    }
}
