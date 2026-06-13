import ExpoModulesCore
import MWDATCore
import MWDATCamera
import UIKit
import Foundation

/**
 * iOS Meta DAT SDK camera integration for Ray-Ban Meta and Meta Ray-Ban
 * Display glasses.
 *
 * Architecture:
 *  - `Wearables.configure()` is invoked once at module init (idempotent —
 *    if the host app already configured the SDK, this throws and is ignored).
 *  - `startStream`: creates a `DeviceSession` via `AutoDeviceSelector`,
 *    waits for `.started`, adds a `Stream` capability at low resolution
 *    (360×640) / 24 fps, and starts the stream. The most recent
 *    `VideoFrame` is cached in memory.
 *  - `captureFrame`: returns a JPEG of the most recent cached video frame
 *    (immediate, no round-trip). If no frame yet, requests a still photo
 *    via `stream.capturePhoto(.jpeg)` and waits for the
 *    `photoDataPublisher` to deliver.
 *  - `stopStream`: stops the stream and the underlying device session.
 *
 * Glasses-button taps: the DAT SDK has no explicit tap event API, but
 * tapping the Ray-Ban side touchpad pauses/resumes the camera session.
 * We surface that as `onTap` by watching `DeviceSession.state` for
 * `paused → started` transitions (the resume edge — equivalent to "tap
 * to capture"). The first `started` after startup is suppressed since
 * that's the initial connection, not a wearer gesture.
 *
 * Permission: the user must accept Meta AI's permission prompt for camera
 * access. The host app is responsible for completing the registration
 * flow (`Wearables.shared.startRegistration()`); this module only consumes
 * an already-registered session.
 */
public class ExpoMetaCameraModule: Module {
  // MARK: - State

  private var deviceSession: DeviceSession?
  private var stream: MWDATCamera.Stream?
  private var stateListenerToken: AnyListenerToken?
  private var videoFrameListenerToken: AnyListenerToken?
  private var errorListenerToken: AnyListenerToken?
  private var photoDataListenerToken: AnyListenerToken?
  private var sessionStateTask: Task<Void, Never>?

  /// Tracks paused→started edges. The first `.started` is the initial connection;
  /// only subsequent `.paused → .started` edges are treated as wearer taps.
  private var sessionHasStartedBefore: Bool = false
  private var lastSessionState: DeviceSessionState = .stopped
  private var tapSequence: Int = 0

  /// Cached latest video frame so `captureFrame()` can return synchronously.
  private var latestFrame: UIImage?
  private let frameLock = NSLock()

  /// Pending continuations waiting for a photo to arrive after `capturePhoto`.
  private var pendingPhotoContinuations: [CheckedContinuation<Data, Error>] = []
  private let photoLock = NSLock()

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("ExpoMetaCameraModule")

    Events("onCameraState", "onCameraError", "onTap")

    OnCreate {
      // Configure the SDK once at module load. The host app may have already
      // called this — `Wearables.configure()` throws on a second call, which
      // we treat as harmless.
      _ = try? Wearables.configure()
    }

    AsyncFunction("startStream") { [weak self] (promise: Promise) in
      guard let self else { promise.resolve(); return }
      Task { @MainActor in
        await self.startStreamAsync(promise: promise)
      }
    }

    AsyncFunction("stopStream") { [weak self] (promise: Promise) in
      guard let self else { promise.resolve(); return }
      Task { @MainActor in
        await self.stopStreamAsync()
        promise.resolve()
      }
    }

    AsyncFunction("captureFrame") { [weak self] (promise: Promise) in
      guard let self else {
        promise.reject("CAMERA_UNAVAILABLE", "module deallocated")
        return
      }
      Task { @MainActor in
        await self.captureFrameAsync(promise: promise)
      }
    }

    OnDestroy {
      Task { @MainActor [weak self] in
        await self?.stopStreamAsync()
      }
    }
  }

  // MARK: - Stream lifecycle

  @MainActor
  private func startStreamAsync(promise: Promise) async {
    if stream != nil {
      // Already streaming — emit current state and resolve.
      sendEvent("onCameraState", ["state": "streaming"])
      promise.resolve()
      return
    }

    sendEvent("onCameraState", ["state": "connecting"])

    // Permission gate.
    do {
      let wearables = Wearables.shared
      var status = try await wearables.checkPermissionStatus(.camera)
      if status != .granted {
        status = try await wearables.requestPermission(.camera)
      }
      if status != .granted {
        sendEvent("onCameraError", [
          "code": "permission-denied",
          "message": "Camera permission was not granted",
        ])
        sendEvent("onCameraState", ["state": "disconnected"])
        promise.resolve()
        return
      }
    } catch {
      sendEvent("onCameraError", [
        "code": "sdk-unavailable",
        "message": "Permission check failed: \(error.localizedDescription)",
      ])
      sendEvent("onCameraState", ["state": "error"])
      promise.resolve()
      return
    }

    // Create a device session.
    let session: DeviceSession
    do {
      let wearables = Wearables.shared
      let selector = AutoDeviceSelector(wearables: wearables)
      session = try wearables.createSession(deviceSelector: selector)
      try session.start()

      // Wait for the session to reach .started, with a 10 s timeout.
      let deadline = Date().addingTimeInterval(10.0)
      var started = session.state == .started
      if !started {
        for await state in session.stateStream() {
          if state == .started { started = true; break }
          if state == .stopped { break }
          if Date() > deadline { break }
        }
      }
      guard started else {
        session.stop()
        sendEvent("onCameraError", [
          "code": "connection-lost",
          "message": "Device session did not reach .started",
        ])
        sendEvent("onCameraState", ["state": "error"])
        promise.resolve()
        return
      }
      deviceSession = session
      sessionHasStartedBefore = true
      lastSessionState = .started
      // Spawn a long-running observer that emits onTap on each paused→started edge.
      sessionStateTask = Task { [weak self] in
        guard let self else { return }
        for await state in session.stateStream() {
          await self.handleSessionStateTransition(state)
        }
      }
    } catch {
      sendEvent("onCameraError", [
        "code": "sdk-unavailable",
        "message": "createSession failed: \(error.localizedDescription)",
      ])
      sendEvent("onCameraState", ["state": "error"])
      promise.resolve()
      return
    }

    // Add a stream capability. Low resolution + 24 fps gives the smallest
    // BT bandwidth footprint; we don't need pristine quality for LLM input.
    let config = StreamConfiguration(
      videoCodec: .raw,
      resolution: .low,
      frameRate: 24
    )
    guard let newStream = try? session.addStream(config: config) else {
      sendEvent("onCameraError", [
        "code": "sdk-unavailable",
        "message": "addStream returned nil",
      ])
      sendEvent("onCameraState", ["state": "error"])
      promise.resolve()
      return
    }
    stream = newStream
    setupStreamListeners(for: newStream)
    await newStream.start()
    promise.resolve()
  }

  @MainActor
  private func stopStreamAsync() async {
    sessionStateTask?.cancel()
    sessionStateTask = nil
    sessionHasStartedBefore = false
    lastSessionState = .stopped

    if let activeStream = stream {
      stream = nil
      clearStreamListeners()
      await activeStream.stop()
    }
    if let activeSession = deviceSession {
      deviceSession = nil
      activeSession.stop()
    }
    frameLock.lock()
    latestFrame = nil
    frameLock.unlock()

    // Reject any pending photo waiters.
    photoLock.lock()
    let waiters = pendingPhotoContinuations
    pendingPhotoContinuations.removeAll()
    photoLock.unlock()
    for c in waiters {
      c.resume(throwing: CameraModuleError.streamStopped)
    }

    sendEvent("onCameraState", ["state": "disconnected"])
  }

  // MARK: - Frame capture

  @MainActor
  private func captureFrameAsync(promise: Promise) async {
    // Fast path: return the most recent cached frame.
    frameLock.lock()
    let cached = latestFrame
    frameLock.unlock()
    if let image = cached, let data = image.jpegData(compressionQuality: 0.85) {
      promise.resolve([
        "data": data.base64EncodedString(),
        "width": Int(image.size.width),
        "height": Int(image.size.height),
      ])
      return
    }

    // Slow path: trigger a still capture via the SDK's photo path.
    guard let activeStream = stream else {
      promise.reject("CAMERA_NOT_STREAMING", "captureFrame called before stream is active")
      return
    }

    do {
      let data = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
        photoLock.lock()
        pendingPhotoContinuations.append(cont)
        photoLock.unlock()
        let success = activeStream.capturePhoto(format: .jpeg)
        if !success {
          // Roll back: pop the continuation we just pushed and reject it.
          photoLock.lock()
          if let last = pendingPhotoContinuations.last {
            pendingPhotoContinuations.removeLast()
            photoLock.unlock()
            last.resume(throwing: CameraModuleError.captureFailed)
          } else {
            photoLock.unlock()
          }
        }
      }
      // Decode dimensions from JPEG header.
      let img = UIImage(data: data)
      promise.resolve([
        "data": data.base64EncodedString(),
        "width": Int(img?.size.width ?? 0),
        "height": Int(img?.size.height ?? 0),
      ])
    } catch {
      promise.reject("CAPTURE_FAILED", error.localizedDescription)
    }
  }

  // MARK: - Stream listeners

  private func setupStreamListeners(for s: MWDATCamera.Stream) {
    stateListenerToken = s.statePublisher.listen { [weak self] state in
      Task { @MainActor in self?.handleStateChange(state) }
    }
    videoFrameListenerToken = s.videoFramePublisher.listen { [weak self] frame in
      // Frame callbacks fire on a background queue; lock-only critical
      // section, no UI work here.
      guard let self else { return }
      if let image = frame.makeUIImage() {
        self.frameLock.lock()
        self.latestFrame = image
        self.frameLock.unlock()
      }
    }
    errorListenerToken = s.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.handleStreamError(error) }
    }
    photoDataListenerToken = s.photoDataPublisher.listen { [weak self] data in
      guard let self else { return }
      self.photoLock.lock()
      let waiters = self.pendingPhotoContinuations
      self.pendingPhotoContinuations.removeAll()
      self.photoLock.unlock()
      for c in waiters {
        c.resume(returning: data.data)
      }
    }
  }

  private func clearStreamListeners() {
    stateListenerToken = nil
    videoFrameListenerToken = nil
    errorListenerToken = nil
    photoDataListenerToken = nil
  }

  @MainActor
  private func handleStateChange(_ state: StreamState) {
    let mapped: String
    switch state {
    case .streaming: mapped = "streaming"
    case .stopped: mapped = "disconnected"
    case .stopping, .starting, .waitingForDevice, .paused: mapped = "connecting"
    @unknown default: mapped = "connecting"
    }
    sendEvent("onCameraState", ["state": mapped])
  }

  @MainActor
  private func handleStreamError(_ error: StreamError) {
    sendEvent("onCameraError", [
      "code": "connection-lost",
      "message": error.localizedDescription,
    ])
  }

  /// Convert DeviceSession state transitions into `onTap` events.
  /// The wearer's side-touchpad gesture pauses the camera session; the
  /// SDK then auto-resumes it. The paused → started edge is therefore a
  /// reliable proxy for "tap to capture".
  @MainActor
  private func handleSessionStateTransition(_ state: DeviceSessionState) {
    let prev = lastSessionState
    lastSessionState = state

    if state == .started {
      if prev == .paused && sessionHasStartedBefore {
        tapSequence += 1
        sendEvent("onTap", ["sequence": tapSequence])
      }
      sessionHasStartedBefore = true
    }
  }
}

// MARK: - Errors

private enum CameraModuleError: LocalizedError {
  case streamStopped
  case captureFailed

  var errorDescription: String? {
    switch self {
    case .streamStopped: return "Stream was stopped before capture completed"
    case .captureFailed: return "capturePhoto returned false"
    }
  }
}
