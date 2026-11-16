package com.yyc.driver;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.*;
import android.os.*;
import org.json.JSONObject;
import java.time.Instant;
import java.util.concurrent.*;

public final class TrackingService extends Service implements LocationListener {
    static final String STOP = "com.yyc.driver.STOP";
    static volatile boolean running = false;
    private static final String CHANNEL = "delivery-location";
    private LocationManager manager;
    private ScheduledExecutorService worker;
    private JSONObject authorization;
    private volatile boolean stopped;
    private long lastSample;
    private String shipment = "Delivery";
    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Active delivery location", NotificationManager.IMPORTANCE_LOW));
    }
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 2, new Intent(this, TrackingService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("YYC Driver · " + shipment).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
            .addAction(new Notification.Action.Builder(null, "Stop sharing", stop).build()).build();
    }
    private void status(String text) {
        if (stopped) return;
        getSharedPreferences("tracking-status", 0).edit().putString("message", text).putLong("updatedAt", System.currentTimeMillis()).apply();
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            getSystemService(NotificationManager.class).notify(100, notification(text));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (running) return START_STICKY;
        try {
            authorization = new TokenStore(this).load();
            if (authorization == null) { stopSelf(); return START_NOT_STICKY; }
            shipment = authorization.getString("shipmentId");
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                throw new SecurityException("Location permission is required. Open YYC Driver to resume.");
            if (Build.VERSION.SDK_INT >= 29) startForeground(100, notification("Starting location sharing…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(100, notification("Starting location sharing…"));
            manager = getSystemService(LocationManager.class);
            boolean enabled = false;
            for (String provider : new String[]{ LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                if (manager.isProviderEnabled(provider)) { manager.requestLocationUpdates(provider, 30000, 0, this, Looper.getMainLooper()); enabled = true; }
            }
            running = true;
            status(enabled ? "Waiting for a location fix. Keep device location enabled." : "Device location is off. Enable location to share updates.");
            worker = Executors.newSingleThreadScheduledExecutor();
            worker.scheduleWithFixedDelay(this::sync, 0, 30, TimeUnit.SECONDS);
            return START_STICKY;
        } catch (Exception error) {
            getSharedPreferences("tracking-status", 0).edit().putString("message", "Tracking stopped. " + error.getMessage()).apply();
            stopSelf(); return START_NOT_STICKY;
        }
    }
    @Override public void onLocationChanged(Location location) {
        if (stopped || SystemClock.elapsedRealtime() - lastSample < 25000) return;
        if (System.currentTimeMillis() - location.getTime() > 300000 || !location.hasAccuracy()) return;
        lastSample = SystemClock.elapsedRealtime();
        try {
            JSONObject point = new JSONObject().put("latitude", location.getLatitude()).put("longitude", location.getLongitude())
                .put("accuracy", location.getAccuracy()).put("recordedAt", Instant.ofEpochMilli(location.getTime()).toString())
                .put("deviceId", authorization.getString("deviceId"));
            if (!getSharedPreferences("location-buffer", 0).edit().putString("sample", point.toString()).commit()) status("Cannot save GPS sample. Check device storage.");
            else if (worker != null && !worker.isShutdown()) worker.execute(this::sync);
        } catch (Exception ignored) { status("Cannot save the latest location sample."); }
    }
    private void sync() {
        if (stopped) return;
        try {
            String origin = authorization.getString("origin"), token = authorization.getString("token");
            Api.request(origin, "/api/mobile/status", token, null);
            if (stopped) return;
            String raw = getSharedPreferences("location-buffer", 0).getString("sample", null);
            if (raw == null) return;
            JSONObject point = new JSONObject(raw);
            if (!authorization.getString("deviceId").equals(point.optString("deviceId")) || System.currentTimeMillis() - Instant.parse(point.getString("recordedAt")).toEpochMilli() > 300000) {
                getSharedPreferences("location-buffer", 0).edit().remove("sample").commit();
                status("Waiting for a fresh GPS sample. Old samples are discarded."); return;
            }
            Api.request(origin, "/api/mobile/location", token, point);
            if (stopped) return;
            if (raw.equals(getSharedPreferences("location-buffer", 0).getString("sample", null))) getSharedPreferences("location-buffer", 0).edit().remove("sample").commit();
            String time = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(new java.util.Date());
            status("Location shared at " + time + ". Sharing continues with the screen locked.");
        } catch (Api.Failure error) {
            if (error.status == 401 || error.status == 403 || error.status == 404) {
                getSharedPreferences("tracking-status", 0).edit().putString("message", "Tracking stopped: " + error.getMessage()).commit();
                new TokenStore(this).clear(); new Handler(Looper.getMainLooper()).post(this::stopSelf);
            } else if (error.status == 400 || error.status == 409) {
                getSharedPreferences("location-buffer", 0).edit().remove("sample").commit();
                status("Waiting for a new GPS sample.");
            } else status("Waiting for the workspace. Latest sample is saved for retry.");
        } catch (Exception ignored) { status("Connection unavailable. Latest sample is saved for retry."); }
    }
    @Override public void onProviderEnabled(String provider) { status("Location enabled. Waiting for the next GPS sample."); }
    @Override public void onProviderDisabled(String provider) { status("Location provider disabled. Check device location settings."); }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        stopped = true; running = false;
        if (manager != null) { try { manager.removeUpdates(this); } catch (SecurityException ignored) { } }
        if (worker != null) worker.shutdownNow();
        getSharedPreferences("location-buffer", 0).edit().clear().commit();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
