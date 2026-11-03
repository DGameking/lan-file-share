package cn.dgameking.lanfileshare;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.database.Cursor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

/**
 * 系统分享接入：接收 ACTION_SEND / ACTION_SEND_MULTIPLE，
 * 将分享内容（文本或文件流）拷贝到应用缓存，交给 WebView 上传投送。
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

    private Intent shared;

    /** 由 MainActivity 在 onCreate / onNewIntent 时调用 */
    public void setSharedIntent(Intent intent) {
        this.shared = intent;
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject ret = new JSObject();
        if (shared == null) {
            ret.put("has", false);
            call.resolve(ret);
            return;
        }
        String action = shared.getAction();
        ret.put("has", true);
        ret.put("action", action);
        if (Intent.ACTION_SEND.equals(action)) {
            String text = shared.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && text.length() > 0) ret.put("text", text);
            Uri uri = shared.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) {
                ArrayList<String> files = new ArrayList<>();
                String path = copyToCache(uri);
                if (path != null) files.add(path);
                ret.put("files", files);
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = shared.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            ArrayList<String> files = new ArrayList<>();
            if (uris != null) {
                for (Uri u : uris) {
                    String p = copyToCache(u);
                    if (p != null) files.add(p);
                }
            }
            ret.put("files", files);
        }
        shared = null; // 一次性消费
        call.resolve(ret);
    }

    /** 把 content:// 流拷入 cacheDir/share，返回绝对路径；失败返回 null */
    private String copyToCache(Uri uri) {
        InputStream in = null;
        FileOutputStream out = null;
        try {
            in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) return null;
            File dir = new File(getContext().getCacheDir(), "share");
            dir.mkdirs();
            String name = queryName(uri);
            File dest = new File(dir, name);
            out = new FileOutputStream(dest);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return dest.getAbsolutePath();
        } catch (Exception e) {
            return null;
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) {}
            try { if (out != null) out.close(); } catch (Exception ignored) {}
        }
    }

    private String queryName(Uri uri) {
        String name = "shared_" + System.currentTimeMillis();
        Cursor c = null;
        try {
            c = getContext().getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String n = c.getString(idx);
                    if (n != null && n.length() > 0) name = n;
                }
            }
        } catch (Exception ignored) {
        } finally {
            try { if (c != null) c.close(); } catch (Exception ignored) {}
        }
        // 清理文件名非法字符
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }
}
