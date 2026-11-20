package cn.nbyongle.erp;

import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 缓存里待交的分享：每批一个目录 root/编号/，里面是“序号.扩展名”的文件和清单 batch.json（编号，每份给网页看的名字、类型、
 * 字节数、缓存文件名）。清单在复制完时写，这一批交完或被替换时连目录一起删；进程被收回、Activity 重建后据它接着交。
 * 只在 ShareInbox 的后台线程上用。
 */
final class ShareBatches {
    private static final String MANIFEST = "batch.json";

    /** 从清单读回的一批 */
    static final class Batch {
        final String id;
        final List<ShareRelay.Received> files;

        Batch(String id, List<ShareRelay.Received> files) {
            this.id = id;
            this.files = files;
        }
    }

    private final File root;

    ShareBatches(File root) {
        this.root = root;
    }

    File dirOf(String id) {
        return new File(root, id);
    }

    /** 写清单；写不成返回 false（这一批就当没收下） */
    boolean save(String id, List<ShareRelay.Received> files) {
        try {
            JSONArray list = new JSONArray();
            for (ShareRelay.Received f : files) {
                list.put(new JSONObject().put("name", f.name).put("mime", f.mime).put("size", f.size).put("file", f.file.getName()));
            }
            String text = new JSONObject().put("shareId", id).put("files", list).toString();
            Files.write(new File(dirOf(id), MANIFEST).toPath(), text.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (IOException | JSONException e) {
            Log.w(Shell.TAG, "分享清单没写成：" + e.getMessage());
            return false;
        }
    }

    /** 留下最新一批清单完好、文件都在的；别的目录（复制到一半、没有清单、清单坏了、更早的）都删掉。没有返回 null */
    Batch restore() {
        File[] dirs = root.listFiles(File::isDirectory);
        if (dirs == null) return null;
        Batch newest = null;
        long newestTime = Long.MIN_VALUE;
        for (File dir : dirs) {
            Batch batch = read(dir);
            long time = new File(dir, MANIFEST).lastModified();
            if (batch == null || time < newestTime) {
                delete(dir.getName());
                continue;
            }
            if (newest != null) delete(newest.id);
            newest = batch;
            newestTime = time;
        }
        return newest;
    }

    void delete(String id) {
        Shell.deleteTree(dirOf(id));
    }

    private Batch read(File dir) {
        try {
            JSONObject json = new JSONObject(new String(Files.readAllBytes(new File(dir, MANIFEST).toPath()), StandardCharsets.UTF_8));
            if (!dir.getName().equals(json.getString("shareId"))) return null;
            JSONArray list = json.getJSONArray("files");
            List<ShareRelay.Received> files = new ArrayList<>();
            for (int i = 0; i < list.length(); i++) {
                JSONObject f = list.getJSONObject(i);
                File file = new File(dir, f.getString("file"));
                if (!file.isFile() || !Shell.isInside(dir, file)) return null;
                files.add(new ShareRelay.Received(f.getString("name"), f.getString("mime"), f.getLong("size"), file));
            }
            return files.isEmpty() ? null : new Batch(dir.getName(), files);
        } catch (IOException | JSONException e) {
            return null;
        }
    }
}
