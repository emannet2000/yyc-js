# YYC Driver for Android

A native companion for the existing delivery workspace. It pairs to one assigned delivery and sends GPS updates from an Android location foreground service, independently of the browser. Minimum Android 8 (API 26), compile/target Android 15 (API 35). No third-party mobile SDK or paid background-location plugin is required.

## Build

Install Android Studio, Android SDK Platform 35, Build Tools 35.0.0, and JDK 17. Open this directory in Android Studio and sync, or set `ANDROID_HOME` to the SDK and run:

```sh
./gradlew --no-daemon :app:assembleDebug :app:lintDebug
```

The bootstrap script downloads Gradle 8.11.1 from the official distribution service and verifies its SHA-256 checksum. An installed Gradle 8.11.1 can run the same tasks directly. The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Install using Android Studio or `adb install -r app/build/outputs/apk/debug/app-debug.apk` on an authorized test device. Use Android Studio's signed APK process for a production release; no signing keys or store publication are included.

The Android CI workflow builds, lints, and uploads a debug APK when its mobile paths change. That workflow is authored but has not run from this workspace. Local APK build is blocked here: no SDK/Gradle is installed and downloads fail DNS resolution. The Java source has not been compiled against an Android SDK or tested on a phone here. Node API and provider tests do not prove Android lifecycle behavior.

## Pair and run

1. Deploy the server on an HTTPS origin reachable from the phone. The app rejects cleartext HTTP, redirects and invalid TLS certificates. A desktop-only `localhost` URL will not reach the desktop from the phone.
2. In the web workspace, sign in as the approved driver and open an assigned, active delivery.
3. Under **Background location sharing**, choose **Pair Android phone**. Codes expire after five minutes and can be used once.
4. Open YYC Driver. Enter the workspace origin, pairing code and a phone name. Tap **Pair this phone**.
5. Tap **Start background location sharing** while the app is visible. Grant location and notification permissions. Approximate location works, but precise location is recommended for useful ETA estimates.
6. A persistent notification identifies the delivery and offers **Stop sharing**. You can lock the screen, close the browser, or leave the native activity. The service does not stop when the activity task is swiped away (`stopWithTask=false`).
7. Check **Location and battery settings** if the device restricts background work. Background location permission can help service recovery where offered. Sharing is explicitly started from the visible activity; it is not silently started at boot.

The app polls server authorization and retries the latest GPS sample approximately every 30 seconds. Samples older than five minutes are discarded, never presented as live. GPS loss, battery optimizations, Doze/network constraints, revoked permissions, an explicit Android force-stop or Task Manager stop, process termination, device shutdown and lost connectivity can interrupt updates. `START_STICKY` asks Android to recreate a killed service; it cannot override platform or user restrictions. Reopen YYC Driver and press Start if sharing stops. No mobile app can guarantee uninterrupted tracking under those conditions.

## Credentials and controls

Pairing authorizes only location/status/disconnect endpoints for one driver and delivery for seven days. Credentials are encrypted with an Android Keystore AES-GCM key and excluded from Android backups. No password is stored. Server tokens and pairing codes are stored only as SHA-256 hashes. Pairing a replacement phone revokes the previous phone for that driver/delivery.

Drivers and brokers can revoke a device from the delivery drawer. Completion, lost assignment, disabling the account, password recovery and database restore revoke applicable authorization. Device checks also reject revoked approvals. The service stops and removes its local authorization on HTTP 401/403/404. Browser logout ends the web session; the separately paired phone continues until stopped, disconnected, revoked or expired. **Stop location sharing** pauses the service; **Disconnect this phone** also clears its stored token and attempts server revocation. If disconnecting offline, revoke the device from the workspace when possible.

One latest sample is retained in private app storage during a short outage, scoped to the paired device. It is cleared on service stop, disconnect or pairing another phone. Server ETA recalculation happens after accepted locations, at most once per minute, and requires configured road providers. No route-provider credential is shipped in the APK.

## Required real-device acceptance

Before distributing to drivers, perform these checks on the Android versions and phone vendors you support:

- Pair an approved driver, start tracking, and verify last-seen time, location and ETA in the broker workspace.
- Lock the screen for at least ten minutes and verify new timestamps continue arriving. Repeat after closing the browser and after swiping away the native activity.
- Turn networking off, then restore it. Verify fresh samples retry and old samples are discarded.
- Revoke the phone, finish the delivery, disable the driver, and hand over to another driver. Verify tracking stops on the next authorization check.
- Stop through the notification, deny/revoke location permission, and force-stop from Settings. Verify stopped status and explicit restart behavior.
- Pair a replacement phone and verify the previous token is rejected. Verify expired and reused codes fail.
- Validate foreground-service and notification behavior on Android 13–16, including battery restrictions. Reboot requires reopening and explicitly starting sharing.

Reference: [Android location foreground services](https://developer.android.com/develop/background-work/services/fgs/service-types#location), [user-initiated stopping](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping).
