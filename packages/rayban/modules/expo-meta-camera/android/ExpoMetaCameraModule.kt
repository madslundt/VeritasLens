package expo.modules.metacamera

import android.graphics.Bitmap
import android.util.Base64
import com.meta.wearable.dat.camera.Stream
import com.meta.wearable.dat.camera.addStream
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamError
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoFrame
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.selectors.DeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Android Meta DAT SDK camera integration for Ray-Ban Meta and Meta Ray-Ban
 * Display glasses.
 *
 * Architecture mirrors the iOS module:
 *  - `Wearables.initialize(ctx)` is invoked once at module load. Idempotent on the
 *    Android side as long as it's called from the same process.
 *  - `startStream`: creates a `DeviceSession` via `AutoDeviceSelector`, waits for
 *    `DeviceSessionState.STARTED`, then `addStream(...)` with `MEDIUM` quality at
 *    24 fps. Latest VideoFrame's converted bitmap is cached in memory.
 *  - `captureFrame`: returns a JPEG of the most recent cached frame. If no frame
 *    has arrived yet, calls `stream.capturePhoto()` and waits for the result.
 *  - `stopStream`: stops stream + session, cancels coroutines.
 *
 * Glasses-button taps: same indirect signal as iOS. The wearer tapping the side
 * touchpad pauses the camera session (DeviceSessionState.PAUSED); the SDK
 * auto-resumes it. We treat each PAUSED → STARTED edge as an `onTap` event,
 * skipping the very first STARTED transition (initial connection).
 */
class ExpoMetaCameraModule : Module() {
  // MARK: - Threading

  private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

  // MARK: - State

  private var deviceSession: DeviceSession? = null
  private var stream: Stream? = null
  private var videoJob: Job? = null
  private var stateJob: Job? = null
  private var errorJob: Job? = null
  private var sessionStateJob: Job? = null

  /// Cached most-recent frame as raw JPEG bytes. Refreshed on each video frame
  /// callback (downsample + JPEG-encode happens off-Main).
  @Volatile private var latestJpegBytes: ByteArray? = null
  @Volatile private var latestWidth: Int = 0
  @Volatile private var latestHeight: Int = 0
  private val frameLock = Mutex()

  /// Pending photo waiters drained when photoData arrives via stream events.
  private val photoFlow = MutableSharedFlow<PhotoData>(replay = 0, extraBufferCapacity = 4)

  /// Tap-detection state. The first STARTED edge is the initial connection;
  /// only PAUSED → STARTED edges thereafter are wearer taps.
  @Volatile private var sessionHasStartedBefore: Boolean = false
  @Volatile private var lastSessionState: DeviceSessionState = DeviceSessionState.STOPPED
  @Volatile private var tapSequence: Int = 0

  private val deviceSelector: DeviceSelector by lazy { AutoDeviceSelector() }

  // MARK: - Module definition

  override fun definition() = ModuleDefinition {
    Name("ExpoMetaCameraModule")

    Events("onCameraState", "onCameraError", "onTap")

    OnCreate {
      val ctx = appContext.reactContext
      if (ctx != null) {
        try {
          Wearables.initialize(ctx)
        } catch (_: Throwable) {
          // Already initialized — fine.
        }
      }
    }

    AsyncFunction("startStream") { promise: Promise ->
      moduleScope.launch { startStreamAsync(promise) }
    }

    AsyncFunction("stopStream") { promise: Promise ->
      moduleScope.launch {
        stopStreamAsync()
        promise.resolve(null)
      }
    }

    AsyncFunction("captureFrame") { promise: Promise ->
      moduleScope.launch { captureFrameAsync(promise) }
    }

    OnDestroy {
      moduleScope.launch { stopStreamAsync() }
    }
  }

  // MARK: - Stream lifecycle

  private suspend fun startStreamAsync(promise: Promise) {
    if (stream != null) {
      sendEvent("onCameraState", mapOf("state" to "streaming"))
      promise.resolve(null)
      return
    }

    sendEvent("onCameraState", mapOf("state" to "connecting"))

    // Permission gate. The host app is responsible for the Meta AI registration
    // flow (Wearables.startRegistration) AND for prompting the wearer when
    // permission isn't yet granted (it requires an Activity-result contract,
    // which this module can't run from). We only check status here; if not
    // Granted, the host must drive the request and call startStream again.
    val permission = com.meta.wearable.dat.core.types.Permission.CAMERA
    var granted = false
    Wearables.checkPermissionStatus(permission)
        .onSuccess { status ->
          granted = status == com.meta.wearable.dat.core.types.PermissionStatus.Granted
        }
        .onFailure { error, _ ->
          sendEvent(
              "onCameraError",
              mapOf("code" to "permission-denied", "message" to "Permission check failed: ${error.description}")
          )
        }
    if (!granted) {
      sendEvent(
          "onCameraError",
          mapOf("code" to "permission-denied", "message" to "Camera permission not granted (host app must call Wearables.startRegistration / RequestPermissionContract)")
      )
      sendEvent("onCameraState", mapOf("state" to "disconnected"))
      promise.resolve(null)
      return
    }

    // Create the device session.
    var newSession: DeviceSession? = null
    Wearables.createSession(deviceSelector)
        .onSuccess { newSession = it }
        .onFailure { error, _ ->
          sendEvent(
              "onCameraError",
              mapOf("code" to "sdk-unavailable", "message" to "createSession failed: ${error.description}")
          )
          sendEvent("onCameraState", mapOf("state" to "error"))
        }
    val session = newSession ?: run { promise.resolve(null); return }
    deviceSession = session

    // Spawn the long-running session-state observer (drives onTap detection).
    sessionStateJob =
        moduleScope.launch {
          session.state.collect { handleSessionStateTransition(it) }
        }

    session.start()

    // Wait for the session to reach STARTED, with a 10 s timeout.
    val started =
        withTimeoutOrNull(10_000) {
          session.state.first { it == DeviceSessionState.STARTED }
        } != null
    if (!started) {
      session.stop()
      deviceSession = null
      sessionStateJob?.cancel()
      sessionStateJob = null
      sendEvent(
          "onCameraError",
          mapOf("code" to "connection-lost", "message" to "Device session did not reach STARTED")
      )
      sendEvent("onCameraState", mapOf("state" to "error"))
      promise.resolve(null)
      return
    }

    // Add a stream capability.
    var newStream: Stream? = null
    session
        .addStream(StreamConfiguration(videoQuality = VideoQuality.MEDIUM, frameRate = 24))
        .onSuccess { newStream = it }
        .onFailure { error, _ ->
          sendEvent(
              "onCameraError",
              mapOf("code" to "sdk-unavailable", "message" to "addStream failed: ${error.description}")
          )
        }
    val s = newStream ?: run { promise.resolve(null); return }
    stream = s
    setupStreamListeners(s)
    s.start()
    promise.resolve(null)
  }

  private suspend fun stopStreamAsync() {
    videoJob?.cancel()
    stateJob?.cancel()
    errorJob?.cancel()
    sessionStateJob?.cancel()
    videoJob = null
    stateJob = null
    errorJob = null
    sessionStateJob = null

    stream?.stop()
    stream = null
    deviceSession?.stop()
    deviceSession = null

    sessionHasStartedBefore = false
    lastSessionState = DeviceSessionState.STOPPED

    frameLock.withLock {
      latestJpegBytes = null
      latestWidth = 0
      latestHeight = 0
    }

    sendEvent("onCameraState", mapOf("state" to "disconnected"))
  }

  // MARK: - Frame capture

  private suspend fun captureFrameAsync(promise: Promise) {
    // Fast path: cached JPEG.
    val cached: Triple<ByteArray, Int, Int>? =
        frameLock.withLock {
          val bytes = latestJpegBytes
          if (bytes != null) Triple(bytes, latestWidth, latestHeight) else null
        }
    if (cached != null) {
      promise.resolve(
          mapOf(
              "data" to Base64.encodeToString(cached.first, Base64.NO_WRAP),
              "width" to cached.second,
              "height" to cached.third
          )
      )
      return
    }

    // Slow path: trigger photo capture.
    val activeStream = stream
    if (activeStream == null) {
      promise.reject(
          "CAMERA_NOT_STREAMING",
          "captureFrame called before stream is active",
          null
      )
      return
    }

    val photoData =
        withTimeoutOrNull(5_000) {
          // Issue capture in parallel with the wait for photoFlow to reduce latency.
          val captureLaunch = moduleScope.launch { activeStream.capturePhoto() }
          val received = photoFlow.first()
          captureLaunch.join()
          received
        }

    if (photoData == null) {
      promise.reject(
          "CAPTURE_TIMEOUT",
          "capturePhoto did not deliver a photo within 5s",
          null
      )
      return
    }

    val (jpegBytes, w, h) = photoToJpegBytes(photoData)
    promise.resolve(
        mapOf(
            "data" to Base64.encodeToString(jpegBytes, Base64.NO_WRAP),
            "width" to w,
            "height" to h
        )
    )
  }

  /**
   * Convert a `PhotoData` into JPEG bytes. The SDK delivers either a Bitmap or
   * raw HEIC; we always re-encode to JPEG so the LLM clients receive a uniform
   * format regardless of platform.
   */
  private fun photoToJpegBytes(photo: PhotoData): Triple<ByteArray, Int, Int> {
    return when (photo) {
      is PhotoData.Bitmap -> {
        val bmp = photo.bitmap
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
        Triple(out.toByteArray(), bmp.width, bmp.height)
      }
      is PhotoData.HEIC -> {
        // Decode HEIC → Bitmap → JPEG. BitmapFactory handles HEIC on API 28+.
        val byteArray = ByteArray(photo.data.remaining())
        photo.data.get(byteArray)
        val bmp = android.graphics.BitmapFactory.decodeByteArray(byteArray, 0, byteArray.size)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
        Triple(out.toByteArray(), bmp.width, bmp.height)
      }
    }
  }

  // MARK: - Stream listeners

  private fun setupStreamListeners(s: Stream) {
    videoJob =
        moduleScope.launch(Dispatchers.Default) {
          s.videoStream.collect { handleVideoFrame(it) }
        }

    stateJob =
        moduleScope.launch {
          s.state.collect { state ->
            val mapped =
                when (state) {
                  StreamState.STREAMING -> "streaming"
                  StreamState.CLOSED -> "disconnected"
                  StreamState.STARTING, StreamState.STOPPING, StreamState.PAUSED -> "connecting"
                  else -> "connecting"
                }
            sendEvent("onCameraState", mapOf("state" to mapped))
          }
        }

    errorJob =
        moduleScope.launch {
          s.errorStream.collect { error ->
            if (error == StreamError.STREAM_ERROR) return@collect
            sendEvent(
                "onCameraError",
                mapOf("code" to "connection-lost", "message" to error.description)
            )
          }
        }

    // photoDataPublisher equivalent: collect from the stream's photo flow if
    // exposed. The Android sample wires capturePhoto via a Result<PhotoData>
    // return value, so we don't need a separate listener — the photoFlow is
    // emitted from captureFrameAsync directly when capturePhoto resolves.
  }

  /// Convert an I420 video frame into a JPEG bitmap and cache it.
  /// Runs on Dispatchers.Default — the conversion is CPU-intensive and must
  /// not block the main thread.
  private suspend fun handleVideoFrame(frame: VideoFrame) {
    val bitmap = yuvI420ToBitmap(frame.buffer, frame.width, frame.height) ?: return
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, 75, out)
    val bytes = out.toByteArray()
    frameLock.withLock {
      latestJpegBytes = bytes
      latestWidth = frame.width
      latestHeight = frame.height
    }
  }

  /**
   * Minimal I420 → ARGB conversion. The Android sample app uses a more
   * optimised converter (`YuvToBitmapConverter` with IntArray pooling); for
   * the rayban use case we capture frames infrequently so a simpler
   * implementation is acceptable.
   *
   * `buffer` layout is I420 planar: Y plane (width * height bytes), then U
   * plane (width/2 * height/2 bytes), then V plane (width/2 * height/2 bytes).
   */
  private fun yuvI420ToBitmap(buffer: ByteBuffer, width: Int, height: Int): Bitmap? {
    if (width <= 0 || height <= 0) return null
    val frameSize = width * height
    val chromaSize = frameSize / 4

    val src = ByteArray(buffer.remaining())
    buffer.get(src)

    if (src.size < frameSize + 2 * chromaSize) return null

    val argb = IntArray(frameSize)
    val uOffset = frameSize
    val vOffset = frameSize + chromaSize

    for (y in 0 until height) {
      for (x in 0 until width) {
        val yIndex = y * width + x
        val uvIndex = (y / 2) * (width / 2) + (x / 2)
        val yVal = (src[yIndex].toInt() and 0xFF) - 16
        val uVal = (src[uOffset + uvIndex].toInt() and 0xFF) - 128
        val vVal = (src[vOffset + uvIndex].toInt() and 0xFF) - 128

        val yScale = 1.164f * yVal
        var r = (yScale + 1.596f * vVal).toInt()
        var g = (yScale - 0.392f * uVal - 0.813f * vVal).toInt()
        var b = (yScale + 2.017f * uVal).toInt()

        if (r < 0) r = 0 else if (r > 255) r = 255
        if (g < 0) g = 0 else if (g > 255) g = 255
        if (b < 0) b = 0 else if (b > 255) b = 255

        argb[yIndex] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
      }
    }

    return Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888)
  }

  // MARK: - Tap detection

  private fun handleSessionStateTransition(state: DeviceSessionState) {
    val prev = lastSessionState
    lastSessionState = state

    if (state == DeviceSessionState.STARTED) {
      if (prev == DeviceSessionState.PAUSED && sessionHasStartedBefore) {
        tapSequence += 1
        sendEvent("onTap", mapOf("sequence" to tapSequence))
      }
      sessionHasStartedBefore = true
    }
  }
}
