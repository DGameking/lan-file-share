package cn.dgameking.lanfileshare;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private ShareIntentPlugin sharePlugin;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareIntentPlugin.class);
        super.onCreate(savedInstanceState);
        sharePlugin = (ShareIntentPlugin) bridge.getPlugin("ShareIntent");
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null || sharePlugin == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            sharePlugin.setSharedIntent(intent);
            setIntent(intent);
        }
    }
}
