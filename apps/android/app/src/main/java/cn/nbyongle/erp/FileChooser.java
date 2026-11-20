package cn.nbyongle.erp;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * 网页里点“上传”时弹出的文件选择：文件管理器选文档；入口收图片时另给“相册”和“拍照”。
 * 文件类型和单选、多选照网页文件框的 accept、multiple。结果交回网页；取消也要交回（交 null），网页才能再点。
 * 拍的照片存进系统相册的“Pictures/甬勒ERP”，不要相机权限、不引第三方库。
 */
final class FileChooser {
    /** startActivityForResult 用的请求号，入口在 onActivityResult 里按它转过来 */
    static final int REQUEST_CODE = 41;
    private static final String PHOTO_FOLDER = Environment.DIRECTORY_PICTURES + "/甬勒ERP";
    private static final String ANY = "*/*";

    private final Activity activity;
    private ValueCallback<Uri[]> pending;
    /** 拍照时给相机的保存位置；没拍成要删掉，免得相册里多一张空图 */
    private Uri photo;

    FileChooser(Activity activity) {
        this.activity = activity;
    }

    /**
     * accept 里的每一项换成 MIME 类型：".pdf" 这类扩展名用 byExtension 查，"image/*" 这类原样保留；
     * 一项都认不出（或网页没写 accept）就是“任意文件”，返回空数组。
     */
    static String[] mimeTypesOf(String[] accept, Function<String, String> byExtension) {
        Set<String> types = new LinkedHashSet<>();
        for (String raw : accept == null ? new String[0] : accept) {
            for (String item : raw.split(",")) addMime(types, item.trim().toLowerCase(Locale.ROOT), byExtension);
        }
        return types.toArray(new String[0]);
    }

    private static void addMime(Set<String> types, String item, Function<String, String> byExtension) {
        if (item.isEmpty()) return;
        if (item.contains("/")) {
            types.add(item);
            return;
        }
        String mime = byExtension.apply(item.startsWith(".") ? item.substring(1) : item);
        if (mime != null) types.add(mime);
        // 安卓给 .csv 的类型各家不一：两种写法都放进去，免得文件管理器里选不到
        if ("text/comma-separated-values".equals(mime) || "text/csv".equals(mime)) {
            types.add("text/csv");
            types.add("text/comma-separated-values");
        }
    }

    /** 收不收图片：明写了图片类型，或者任意文件 */
    static boolean acceptsImages(String[] mimes) {
        if (mimes.length == 0) return true;
        for (String mime : mimes) if (mime.startsWith("image/")) return true;
        return false;
    }

    /**
     * 选择结果里交给网页的：取消交空；选了文件交文件（去掉空地址）；没选文件但给了相机位置就算拍了照（相机一般不回 data，
     * 有的相机把保存位置原样回在 data 里）。照片确定是空的（相机回了“成功”却一个字节都没写）就不交。
     */
    static <T> List<T> chosen(boolean ok, List<T> picked, T photo, Predicate<T> surelyEmpty) {
        List<T> out = new ArrayList<>();
        if (!ok) return out;
        for (T item : picked) if (item != null) out.add(item);
        if (out.isEmpty() && photo != null) out.add(photo);
        if (photo != null && out.contains(photo) && surelyEmpty.test(photo)) out.remove(photo);
        return out;
    }

    /** WebChromeClient.onShowFileChooser 转到这里；总是由外壳接管 */
    boolean open(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        finish(null);
        discardPhoto();
        pending = callback;
        String[] mimes = mimeTypesOf(params.getAcceptTypes(), FileChooser::systemMime);
        boolean multiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        Intent chooser = Intent.createChooser(documentsIntent(mimes, multiple), activity.getString(R.string.choose_file));
        if (acceptsImages(mimes)) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, imageIntents(multiple));
        try {
            activity.startActivityForResult(chooser, REQUEST_CODE);
        } catch (ActivityNotFoundException e) {
            Shell.toast(activity, activity.getString(R.string.no_file_app));
            discardPhoto();
            finish(null);
        }
        return true;
    }

    /** 入口的 onActivityResult 转过来：交回 chosen 选出的；没交回的相机位置删掉；什么都没有交 null（网页才能再点） */
    void onResult(int resultCode, Intent data) {
        List<Uri> picked = resultCode == Activity.RESULT_OK && data != null ? urisOf(data) : new ArrayList<>();
        List<Uri> result = chosen(resultCode == Activity.RESULT_OK, picked, photo, this::surelyEmpty);
        if (!result.contains(photo)) discardPhoto();
        photo = null;
        Log.i(Shell.TAG, "文件选择交回 " + result.size() + " 份");
        finish(result.isEmpty() ? null : result.toArray(new Uri[0]));
    }

    /** 页面关闭、换了新的选择时：把还没交回的回调交掉（null），网页的文件框才不会卡住 */
    void finish(Uri[] result) {
        if (pending != null) pending.onReceiveValue(result);
        pending = null;
    }

    private static String systemMime(String extension) {
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
    }

    /**
     * 选文件：OPEN_DOCUMENT 只会打开系统的“文件”（文件管理器）。GET_CONTENT 还会列出“照片和视频”这类应用，
     * 选图片已经有前面的“相册”了，不用再给一个。
     */
    private static Intent documentsIntent(String[] mimes, boolean multiple) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimes.length == 1 ? mimes[0] : ANY);
        if (mimes.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        return intent;
    }

    /** 相册和相机两个入口；相机放在最前面 */
    private Intent[] imageIntents(boolean multiple) {
        List<Intent> intents = new ArrayList<>();
        Intent camera = cameraIntent();
        if (camera != null) intents.add(camera);
        Intent gallery = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
        gallery.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        intents.add(gallery);
        return intents.toArray(new Intent[0]);
    }

    /** 拍照：先在相册里占一个位置交给相机写；占不到位置就不给拍照入口 */
    private Intent cameraIntent() {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "yongle-" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, PHOTO_FOLDER);
        photo = activity.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (photo == null) return null;
        Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, photo);
        // 放在选择器里的相机拿不到写权限时会拍不成：把地址也放进 ClipData 一起授权
        camera.setClipData(ClipData.newRawUri("", photo));
        camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return camera;
    }

    /**
     * 删掉给相机占的位置（没拍照、上一次没交回、打不开选择器时）。有的系统（实测 vivo 安卓 16 从“照片和视频”选了图片后）
     * 不让删、抛 SecurityException：只记日志，选好的文件照常交回网页，不能让整个应用闪退。
     */
    private void discardPhoto() {
        if (photo == null) return;
        try {
            activity.getContentResolver().delete(photo, null, null);
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(Shell.TAG, "给相机占的相册位置没删掉：" + e.getMessage());
        }
        photo = null;
    }

    /**
     * 照片确定是空的：打开它读第一个字节读到了结尾。不看相册的“大小”一列（系统异步更新，刚拍完可能还是 0）；
     * 打不开、读出错都算有内容，宁可交给网页，也不删掉可能拍成的照片。
     */
    private boolean surelyEmpty(Uri uri) {
        try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
            return in != null && in.read() < 0;
        } catch (IOException | RuntimeException e) {
            Log.w(Shell.TAG, "读不了刚拍的照片，照常交回：" + e.getMessage());
            return false;
        }
    }

    /** 选择结果里的文件：多选在 ClipData 里，单选在 getData()（可能有空的，由 chosen 去掉） */
    private static List<Uri> urisOf(Intent data) {
        if (data.getClipData() != null) return Shell.clipUris(data.getClipData());
        List<Uri> uris = new ArrayList<>();
        uris.add(data.getData());
        return uris;
    }
}
