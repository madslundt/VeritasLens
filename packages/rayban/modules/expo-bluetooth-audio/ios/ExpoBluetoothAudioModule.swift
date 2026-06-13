import ExpoModulesCore
import AVFoundation
import Foundation

/**
 * iOS Bluetooth HFP audio capture for Ray-Ban Meta and any other Bluetooth
 * HFP-capable headset.
 *
 * Architecture:
 *  - `AVAudioSession` configured with category `.playAndRecord`, mode
 *    `.voiceChat`, options including `.allowBluetooth` so the OS routes
 *    input/output to the connected HFP device.
 *  - `AVAudioEngine` taps the input node in 100 ms windows; each tap
 *    callback converts the Float32 buffer to signed 16-bit little-endian
 *    PCM, base64-encodes it, and emits `onAudioChunk` with the actual
 *    OS-negotiated sample rate (16 kHz mSBC or 8 kHz CVSD).
 *  - Audio interruptions (phone call, Siri, etc.) emit `onAudioError`
 *    with `code: session-interrupted`.
 *
 * The same module is used both for the mic (input tap) and as the keep-
 * alive that allows TTS playback through the glasses speaker — once the
 * session is active with `.allowBluetooth` and `.voiceChat`, `expo-speech`
 * automatically routes through the same HFP device.
 */
public class ExpoBluetoothAudioModule: Module {
  // MARK: - State

  private let audioEngine = AVAudioEngine()
  private var sequence: Int = 0
  private var isRecording: Bool = false
  /// Negotiated sample rate from `AVAudioSession`; populated when recording starts.
  private var negotiatedSampleRate: Int = 16_000
  /// Buffer accumulating fractional samples between taps so we always emit ~100 ms chunks.
  private var pendingPcm: Data = Data()
  /// Target chunk size in bytes; computed from `negotiatedSampleRate`.
  private var chunkBytes: Int = 16_000 * 2 / 10  // 100 ms at 16 kHz int16

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("ExpoBluetoothAudioModule")

    Events("onAudioState", "onAudioError", "onAudioChunk")

    AsyncFunction("startRecording") { [weak self] (promise: Promise) in
      guard let self else { promise.resolve(); return }
      Task { @MainActor in
        await self.startRecordingAsync(promise: promise)
      }
    }

    AsyncFunction("stopRecording") { [weak self] (promise: Promise) in
      guard let self else { promise.resolve(); return }
      Task { @MainActor in
        await self.stopRecordingAsync()
        promise.resolve()
      }
    }

    OnDestroy {
      // Best-effort cleanup if the JS side never called stopRecording.
      Task { @MainActor [weak self] in
        await self?.stopRecordingAsync()
      }
    }
  }

  // MARK: - Recording lifecycle

  @MainActor
  private func startRecordingAsync(promise: Promise) async {
    if isRecording {
      promise.resolve()
      return
    }

    sendEvent("onAudioState", ["state": "starting"])

    let session = AVAudioSession.sharedInstance()
    do {
      // .voiceChat mode triggers wide-band (mSBC) negotiation when the headset
      // supports it; .allowBluetooth forces HFP profile selection over A2DP so
      // we get bidirectional audio (mic + speaker) on Bluetooth Classic.
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .defaultToSpeaker, .allowBluetoothA2DP]
      )
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      sendEvent("onAudioError", [
        "code": "permission-denied",
        "message": "AVAudioSession activation failed: \(error.localizedDescription)",
      ])
      promise.resolve()
      return
    }

    // Read the OS-negotiated sample rate AFTER activation. iOS reports the
    // active route's effective rate here — 16 kHz when mSBC negotiated,
    // 8 kHz when only CVSD is available.
    let osSampleRate = Int(session.sampleRate.rounded())
    negotiatedSampleRate = (osSampleRate > 0) ? osSampleRate : 16_000
    chunkBytes = (negotiatedSampleRate * 2) / 10  // 100 ms at int16 mono

    // Subscribe to interruption notifications.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleInterruption(_:)),
      name: AVAudioSession.interruptionNotification,
      object: session
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: session
    )

    // Configure the engine input tap.
    let input = audioEngine.inputNode
    let inputFormat = input.inputFormat(forBus: 0)
    let bufferSize: AVAudioFrameCount = 1024  // ~64 ms at 16 kHz; flushed via accumulation buffer

    input.removeTap(onBus: 0)  // defensive: clear any prior tap
    input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
      self?.handleAudioBuffer(buffer)
    }

    do {
      audioEngine.prepare()
      try audioEngine.start()
    } catch {
      sendEvent("onAudioError", [
        "code": "unknown",
        "message": "AVAudioEngine start failed: \(error.localizedDescription)",
      ])
      promise.resolve()
      return
    }

    isRecording = true
    sequence = 0
    pendingPcm.removeAll(keepingCapacity: true)
    sendEvent("onAudioState", ["state": "recording"])
    promise.resolve()
  }

  @MainActor
  private func stopRecordingAsync() async {
    if !isRecording { return }
    isRecording = false

    audioEngine.inputNode.removeTap(onBus: 0)
    if audioEngine.isRunning {
      audioEngine.stop()
    }

    NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)

    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      // Non-fatal — surface but don't fail the stop transition.
      sendEvent("onAudioError", [
        "code": "unknown",
        "message": "AVAudioSession deactivation failed: \(error.localizedDescription)",
      ])
    }

    pendingPcm.removeAll(keepingCapacity: false)
    sendEvent("onAudioState", ["state": "idle"])
  }

  // MARK: - Audio conversion

  /// Convert an `AVAudioPCMBuffer` (Float32) to signed 16-bit little-endian PCM
  /// and feed the accumulator. Emits `onAudioChunk` whenever ~100 ms is buffered.
  private func handleAudioBuffer(_ buffer: AVAudioPCMBuffer) {
    guard let floatData = buffer.floatChannelData else { return }
    let frameCount = Int(buffer.frameLength)
    if frameCount == 0 { return }

    // Average across channels → mono. Most BT HFP routes are mono, but some
    // platforms expose a stereo input format with the same signal on both
    // channels; averaging is safe in either case.
    let channelCount = Int(buffer.format.channelCount)
    var int16Bytes = Data(count: frameCount * 2)
    int16Bytes.withUnsafeMutableBytes { rawPtr in
      guard let dst = rawPtr.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
      for frame in 0..<frameCount {
        var sum: Float = 0
        for ch in 0..<channelCount {
          sum += floatData[ch][frame]
        }
        let mono = sum / Float(channelCount)
        // Clamp and scale Float [-1, 1] → Int16 [-32768, 32767].
        let clamped = max(-1.0, min(1.0, mono))
        dst[frame] = Int16(clamped * 32767.0)
      }
    }

    pendingPcm.append(int16Bytes)
    flushChunksIfReady()
  }

  /// Drains the accumulator one chunk at a time. Each emitted chunk is
  /// `chunkBytes` long (~100 ms of int16 mono at the negotiated sample rate).
  private func flushChunksIfReady() {
    while pendingPcm.count >= chunkBytes {
      let chunk = pendingPcm.prefix(chunkBytes)
      pendingPcm.removeFirst(chunkBytes)
      sequence += 1
      sendEvent("onAudioChunk", [
        "pcm": chunk.base64EncodedString(),
        "sampleRate": negotiatedSampleRate,
        "sequence": sequence,
      ])
    }
  }

  // MARK: - Interruption + route change handling

  @objc private func handleInterruption(_ notification: Notification) {
    guard
      let info = notification.userInfo,
      let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: typeValue)
    else { return }

    switch type {
    case .began:
      sendEvent("onAudioError", [
        "code": "session-interrupted",
        "message": "Audio session interrupted (phone call, Siri, or another audio app)",
      ])
    case .ended:
      // Re-activation is the JS side's responsibility — it re-calls
      // startRecording when the user wants to resume.
      break
    @unknown default:
      break
    }
  }

  @objc private func handleRouteChange(_ notification: Notification) {
    guard
      let info = notification.userInfo,
      let reasonValue = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
    else { return }

    switch reason {
    case .oldDeviceUnavailable:
      // Glasses went out of range or were powered off.
      sendEvent("onAudioError", [
        "code": "no-hfp-route",
        "message": "Bluetooth audio route lost",
      ])
    default:
      break
    }
  }
}
