package expo.modules.bluetoothaudio

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android Bluetooth HFP audio capture for Ray-Ban Meta and any other Bluetooth
 * HFP-capable headset.
 *
 * Architecture:
 *  - Acquires the SCO link via `AudioManager.startBluetoothSco()`. This routes
 *    the mic + speaker through the connected HFP profile and triggers the
 *    OS-level mSBC/CVSD codec negotiation.
 *  - Waits for `ACTION_SCO_AUDIO_STATE_UPDATED` broadcast before starting
 *    `AudioRecord`; reading from `VOICE_COMMUNICATION` source before SCO is
 *    connected returns silence or device-mic audio.
 *  - Reads PCM in ~100 ms chunks on a dedicated `HandlerThread`, emits
 *    `onAudioChunk` with the actual sample rate (16 kHz mSBC or 8 kHz CVSD).
 *  - Foreground service starts/stops alongside recording (already wired in
 *    P2-T10) so audio capture survives backgrounding.
 *
 * The same active SCO link routes TTS playback (`expo-speech`) through the
 * glasses speaker — the HFP profile is bidirectional.
 */
class ExpoBluetoothAudioModule : Module() {
  // MARK: - Threading

  private val mainHandler = Handler(Looper.getMainLooper())
  private var captureThread: HandlerThread? = null
  private var captureHandler: Handler? = null

  // MARK: - State

  private val isRecording = AtomicBoolean(false)
  private var audioRecord: AudioRecord? = null
  private var sequence: Int = 0
  private var negotiatedSampleRate: Int = 16_000
  private var scoReceiver: BroadcastReceiver? = null
  /// True while we're between startBluetoothSco() and SCO_AUDIO_STATE_CONNECTED.
  private val waitingForSco = AtomicBoolean(false)

  // MARK: - Module definition

  override fun definition() = ModuleDefinition {
    Name("ExpoBluetoothAudioModule")

    Events("onAudioState", "onAudioError", "onAudioChunk")

    AsyncFunction("startRecording") {
      val ctx = appContext.reactContext ?: return@AsyncFunction
      mainHandler.post { startRecordingOnMain(ctx) }
    }

    AsyncFunction("stopRecording") {
      val ctx = appContext.reactContext ?: return@AsyncFunction
      mainHandler.post { stopRecordingOnMain(ctx) }
    }

    OnDestroy {
      val ctx = appContext.reactContext
      if (ctx != null) mainHandler.post { stopRecordingOnMain(ctx) }
    }
  }

  // MARK: - Recording lifecycle

  private fun startRecordingOnMain(ctx: Context) {
    if (isRecording.get() || waitingForSco.get()) return

    if (!hasMicrophonePermission(ctx)) {
      sendEvent(
        "onAudioError",
        mapOf("code" to "permission-denied", "message" to "RECORD_AUDIO permission not granted")
      )
      return
    }

    sendEvent("onAudioState", mapOf("state" to "starting"))

    // Start the foreground service so audio capture survives backgrounding.
    val serviceIntent = Intent(ctx, RecordingForegroundService::class.java)
    ctx.startForegroundService(serviceIntent)

    val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    // Some devices already report SCO connected (e.g. an active call); short-circuit
    // straight to recording when that's the case.
    @Suppress("DEPRECATION")
    if (audioManager.isBluetoothScoOn) {
      beginAudioCapture(ctx, audioManager)
      return
    }

    // Register a receiver to be notified when SCO is established.
    waitingForSco.set(true)
    val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        val state = intent?.getIntExtra(
          AudioManager.EXTRA_SCO_AUDIO_STATE,
          AudioManager.SCO_AUDIO_STATE_ERROR
        ) ?: AudioManager.SCO_AUDIO_STATE_ERROR

        when (state) {
          AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
            if (waitingForSco.compareAndSet(true, false)) {
              beginAudioCapture(ctx, audioManager)
            }
          }
          AudioManager.SCO_AUDIO_STATE_DISCONNECTED, AudioManager.SCO_AUDIO_STATE_ERROR -> {
            if (waitingForSco.get() || isRecording.get()) {
              waitingForSco.set(false)
              sendEvent(
                "onAudioError",
                mapOf("code" to "no-hfp-route", "message" to "Bluetooth SCO disconnected")
              )
              cleanup(ctx)
            }
          }
        }
      }
    }
    scoReceiver = receiver
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      ctx.registerReceiver(receiver, filter)
    }

    @Suppress("DEPRECATION")
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    @Suppress("DEPRECATION")
    audioManager.startBluetoothSco()
  }

  private fun beginAudioCapture(ctx: Context, audioManager: AudioManager) {
    @Suppress("DEPRECATION")
    audioManager.isBluetoothScoOn = true

    // Probe the negotiated sample rate. mSBC reports 16 kHz; CVSD falls back to 8 kHz.
    // Some devices don't honour the requested rate — try 16k first, fall back to 8k.
    val candidateRates = intArrayOf(16_000, 8_000)
    var record: AudioRecord? = null
    var chosenRate = 0

    for (rate in candidateRates) {
      val minBuf = AudioRecord.getMinBufferSize(
        rate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
      if (minBuf <= 0) continue

      // Allocate a buffer comfortably larger than 100 ms to avoid overruns.
      val bufferSize = maxOf(minBuf, rate * 2 / 5) // ~200 ms

      try {
        @Suppress("MissingPermission")  // checked above in startRecordingOnMain
        val candidate = AudioRecord(
          MediaRecorder.AudioSource.VOICE_COMMUNICATION,
          rate,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          bufferSize
        )
        if (candidate.state == AudioRecord.STATE_INITIALIZED) {
          record = candidate
          chosenRate = rate
          break
        } else {
          candidate.release()
        }
      } catch (_: IllegalArgumentException) {
        // Try the next rate.
      } catch (_: SecurityException) {
        sendEvent(
          "onAudioError",
          mapOf("code" to "permission-denied", "message" to "AudioRecord refused: missing permission")
        )
        cleanup(ctx)
        return
      }
    }

    if (record == null || chosenRate == 0) {
      sendEvent(
        "onAudioError",
        mapOf("code" to "unknown", "message" to "Could not initialise AudioRecord at 16k or 8k")
      )
      cleanup(ctx)
      return
    }

    audioRecord = record
    negotiatedSampleRate = chosenRate
    sequence = 0

    val thread = HandlerThread("ExpoBluetoothAudio-capture").apply { start() }
    captureThread = thread
    captureHandler = Handler(thread.looper)

    record.startRecording()
    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      sendEvent(
        "onAudioError",
        mapOf("code" to "unknown", "message" to "AudioRecord did not enter RECORDING state")
      )
      cleanup(ctx)
      return
    }

    isRecording.set(true)
    sendEvent("onAudioState", mapOf("state" to "recording"))

    val chunkBytes = (chosenRate * 2) / 10  // 100 ms of int16 mono
    val readBuffer = ByteArray(chunkBytes)

    captureHandler?.post(object : Runnable {
      override fun run() {
        if (!isRecording.get()) return
        val r = audioRecord ?: return
        val read = r.read(readBuffer, 0, chunkBytes)
        if (read > 0) {
          val payload = if (read == chunkBytes) readBuffer else readBuffer.copyOf(read)
          val base64 = Base64.encodeToString(payload, Base64.NO_WRAP)
          sequence += 1
          // Hop back to the main thread to emit the event — JSI bridge calls
          // are safest from a single thread to avoid surprising re-entrancy.
          val seqSnapshot = sequence
          mainHandler.post {
            if (isRecording.get()) {
              sendEvent(
                "onAudioChunk",
                mapOf(
                  "pcm" to base64,
                  "sampleRate" to negotiatedSampleRate,
                  "sequence" to seqSnapshot
                )
              )
            }
          }
        } else if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_BAD_VALUE) {
          mainHandler.post {
            sendEvent(
              "onAudioError",
              mapOf("code" to "unknown", "message" to "AudioRecord.read returned $read")
            )
          }
        }
        // Schedule next read; AudioRecord.read blocks until samples are
        // available, so there's no need to throttle here beyond what the
        // hardware provides.
        captureHandler?.post(this)
      }
    })
  }

  private fun stopRecordingOnMain(ctx: Context) {
    if (!isRecording.get() && !waitingForSco.get()) {
      // Even if we never started, ensure the foreground service is dropped if
      // the JS side called startRecording → stopRecording rapidly.
      val svcIntent = Intent(ctx, RecordingForegroundService::class.java)
      ctx.stopService(svcIntent)
      return
    }
    cleanup(ctx)
    sendEvent("onAudioState", mapOf("state" to "idle"))
  }

  private fun cleanup(ctx: Context) {
    isRecording.set(false)
    waitingForSco.set(false)

    captureHandler?.removeCallbacksAndMessages(null)
    captureHandler = null
    captureThread?.quitSafely()
    captureThread = null

    audioRecord?.let {
      if (it.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
        try { it.stop() } catch (_: IllegalStateException) { /* ignore */ }
      }
      it.release()
    }
    audioRecord = null

    val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    @Suppress("DEPRECATION")
    audioManager.isBluetoothScoOn = false
    @Suppress("DEPRECATION")
    audioManager.stopBluetoothSco()
    @Suppress("DEPRECATION")
    audioManager.mode = AudioManager.MODE_NORMAL

    scoReceiver?.let {
      try { ctx.unregisterReceiver(it) } catch (_: IllegalArgumentException) { /* not registered */ }
    }
    scoReceiver = null

    val svcIntent = Intent(ctx, RecordingForegroundService::class.java)
    ctx.stopService(svcIntent)
  }

  // MARK: - Helpers

  private fun hasMicrophonePermission(ctx: Context): Boolean {
    return ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  }
}
