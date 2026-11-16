package com.yyc.driver;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private EditText origin, code, name;
    private TextView status;
    private Button pair, start;
    private boolean visible;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (!visible) return;
            String message = getSharedPreferences("tracking-status", 0).getString("message", "Pair your phone with a delivery to get started.");
            status.setText((TrackingService.running ? "SHARING LOCATION\n\n" : "NOT SHARING\n\n") + message);
            handler.postDelayed(this, 2000);
        }
    };
    private int dp(int value) { return (int)(value * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(23, 51, 79));
        view.setPadding(0, dp(12), 0, dp(8)); return view;
    }
    private EditText field(LinearLayout layout, String label, String hint) {
        layout.addView(text(label, 13)); EditText input = new EditText(this); input.setSingleLine(); input.setHint(hint);
        input.setTextSize(15); input.setPadding(dp(10), dp(12), dp(10), dp(12));
        layout.addView(input, new LinearLayout.LayoutParams(-1, dp(54))); return input;
    }
    private Button button(LinearLayout layout, String value, View.OnClickListener listener) {
        Button button = new Button(this); button.setText(value); button.setAllCaps(false); button.setOnClickListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(52)); params.topMargin = dp(12); layout.addView(button, params); return button;
    }
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ScrollView scroll = new ScrollView(this); LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(24), dp(30), dp(24), dp(32)); scroll.addView(content);
        // Keep system bars clear when Android 15 enforces edge-to-edge layout.
        scroll.setOnApplyWindowInsetsListener((view, insets) -> { view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets; });
        content.addView(text("YYC DRIVER", 28)); content.addView(text("Background delivery tracking", 17));
        content.addView(text("This companion shares your location for one assigned delivery while the screen is locked or the browser is closed. You remain in control: a notification shows when sharing is active and lets you stop it.", 14));
        status = text("Checking phone…", 14); status.setPadding(dp(16), dp(18), dp(16), dp(18)); status.setBackgroundColor(Color.rgb(228, 239, 245)); content.addView(status);
        origin = field(content, "Workspace address", "https://deliveries.example.com"); origin.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        code = field(content, "One-time pairing code", "Copy from the assigned delivery in the workspace");
        name = field(content, "Phone name", "Driver phone"); name.setText(Build.MODEL);
        pair = button(content, "Pair this phone", v -> pair());
        start = button(content, "Start background location sharing", v -> startSharing());
        button(content, "Stop location sharing", v -> { stopService(new Intent(this, TrackingService.class)); getSharedPreferences("tracking-status", 0).edit().putString("message", "You stopped location sharing. Tap Start to resume.").apply(); });
        button(content, "Location and battery settings", v -> new AlertDialog.Builder(this).setTitle("Background tracking settings").setMessage("In app permissions, enable precise location. Allow background location if offered. In battery settings, allow unrestricted background use if your device stops updates. Sharing still starts only when you tap Start.").setPositiveButton("Open settings", (d, which) -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())))).setNegativeButton("Cancel", null).show());
        button(content, "Open delivery workspace", v -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(Api.origin(origin.getText().toString()) + "/react/"))); } catch (Exception e) { message(e.getMessage()); } });
        button(content, "Disconnect this phone", v -> disconnect());
        content.addView(text("Location updates are sent about every 30 seconds. A recent sample is kept on this phone during outages. Force-stop, revoked permissions, battery restrictions, GPS loss, or powering off can interrupt tracking. Reopen this app to check status and resume.", 12));
        setContentView(scroll);
        try { JSONObject saved = new TokenStore(this).load(); if (saved != null) { origin.setText(saved.getString("origin")); if (!TrackingService.running) getSharedPreferences("tracking-status", 0).edit().putString("message", "Paired to " + saved.getString("shipmentId") + ". Tap Start to share location.").apply(); } }
        catch (Exception e) { new TokenStore(this).clear(); message("Phone authorization could not be opened. Pair again."); }
    }
    private void message(String value) { getSharedPreferences("tracking-status", 0).edit().putString("message", value).apply(); if (!isFinishing()) { status.setText(value); Toast.makeText(this, value, Toast.LENGTH_LONG).show(); } }
    private void pair() {
        pair.setEnabled(false);
        final String workspace = origin.getText().toString(), pairing = code.getText().toString(), phoneName = name.getText().toString();
        worker.execute(() -> {
            try {
                String server = Api.origin(workspace);
                JSONObject result = Api.request(server, "/api/mobile/pair", null, new JSONObject().put("code", pairing).put("name", phoneName));
                stopService(new Intent(this, TrackingService.class));
                result.put("origin", server); new TokenStore(this).save(result);
                getSharedPreferences("location-buffer", 0).edit().clear().commit();
                handler.post(() -> { code.setText(""); message("Paired to " + result.optString("shipmentId") + ". Tap Start to enable background sharing."); });
            } catch (Exception e) { handler.post(() -> message(e.getMessage())); }
            finally { handler.post(() -> pair.setEnabled(true)); }
        });
    }
    private void startSharing() {
        try { if (new TokenStore(this).load() == null) { message("Pair this phone with a delivery first."); return; } }
        catch (Exception e) { message("Pair this phone again."); return; }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, 1); return;
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 2); return;
        }
        launchTracking();
    }
    private void launchTracking() {
        try { startForegroundService(new Intent(this, TrackingService.class)); }
        catch (Exception e) { message("Cannot start location sharing. Keep YYC Driver visible and check location permissions."); }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 1) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) startSharing();
            else message("Location permission is required to share delivery progress.");
        } else if (request == 2) launchTracking();
    }
    private void disconnect() {
        stopService(new Intent(this, TrackingService.class));
        JSONObject saved;
        try { saved = new TokenStore(this).load(); } catch (Exception e) { saved = null; }
        new TokenStore(this).clear();
        getSharedPreferences("tracking-status", 0).edit().putString("message", "Disconnected. Local phone credentials were removed.").apply();
        final JSONObject auth = saved;
        if (auth != null) worker.execute(() -> { try { Api.request(auth.getString("origin"), "/api/mobile/disconnect", auth.getString("token"), new JSONObject()); } catch (Exception e) { handler.post(() -> message("Phone disconnected locally. If offline, revoke its authorization from the delivery workspace too.")); } });
    }
    @Override protected void onResume() { super.onResume(); visible = true; handler.post(refresh); }
    @Override protected void onPause() { visible = false; handler.removeCallbacks(refresh); super.onPause(); }
    @Override protected void onDestroy() { worker.shutdown(); handler.removeCallbacksAndMessages(null); super.onDestroy(); }
}
