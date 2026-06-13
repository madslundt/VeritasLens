# Manual AndroidManifest.xml additions after `expo prebuild`

After running `npx expo prebuild`, the generated `packages/rayban/android/app/src/main/AndroidManifest.xml` does not include the foreground service declaration. Add this inside the `<application>` element:

```xml
<service
    android:name="expo.modules.bluetoothaudio.RecordingForegroundService"
    android:foregroundServiceType="microphone|camera"
    android:exported="false" />
```

The required permissions (FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, FOREGROUND_SERVICE_CAMERA) are already declared in `app.json` — Expo's prebuild step injects them automatically.
