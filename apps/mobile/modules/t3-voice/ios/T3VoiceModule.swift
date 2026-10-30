import AVFoundation
import ExpoModulesCore
import Speech
import UIKit

public final class T3VoiceModule: Module {
  private lazy var voice = T3VoiceSession()

  public func definition() -> ModuleDefinition {
    Name("T3Voice")

    AsyncFunction("prepare") { (promise: Promise) in
      self.voice.prepare(promise)
    }.runOnQueue(.main)

    AsyncFunction("listen") { (promise: Promise) in
      self.voice.listen(promise)
    }.runOnQueue(.main)

    AsyncFunction("speak") { (text: String, promise: Promise) in
      self.voice.speak(text, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.voice.stop()
    }.runOnQueue(.main)

    Function("playPing") { (tone: String) in
      let soundId: SystemSoundID
      switch tone {
      case "listening":
        soundId = 1113 // Begin recording / active ping
      case "sent":
        soundId = 1001 // Sent mail / dispatch ping
      case "reply":
        soundId = 1002 // Received message / chime
      case "chime":
        soundId = 1003 // Resonant alert chime for incoming blocks
      default:
        soundId = 1104 // Subtle tap
      }
      AudioServicesPlaySystemSound(soundId)
    }

    OnDestroy {
      DispatchQueue.main.async { self.voice.stop() }
    }
  }
}

private final class T3VoiceSession: NSObject, AVSpeechSynthesizerDelegate {
  private let engine = AVAudioEngine()
  private let synthesizer = AVSpeechSynthesizer()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var pending: Promise?
  private var silenceTimer: Timer?
  private var limitTimer: Timer?
  private var transcript = ""
  private var tapped = false
  private var generation = 0
  private var observers: [NSObjectProtocol] = []
  private var utterance: AVSpeechUtterance?

  override init() {
    super.init()
    synthesizer.delegate = self
    let center = NotificationCenter.default
    for name in [AVAudioSession.interruptionNotification,
                 AVAudioSession.routeChangeNotification,
                 AVAudioSession.mediaServicesWereResetNotification,
                 UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
        if notification.name == AVAudioSession.routeChangeNotification {
          let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
          guard reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
        }
        self?.stop()
      })
    }
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  func prepare(_ promise: Promise) {
    let preparation = generation
    SFSpeechRecognizer.requestAuthorization { [weak self] status in
      DispatchQueue.main.async {
        guard let self, self.generation == preparation else {
          promise.reject("cancelled", "Voice setup was cancelled.")
          return
        }
        guard status == .authorized else {
          promise.reject("permission", "Enable Speech Recognition for T3 Code in iPhone Settings.")
          return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
          DispatchQueue.main.async {
            guard self.generation == preparation else {
              promise.reject("cancelled", "Voice setup was cancelled.")
              return
            }
            guard granted else {
              promise.reject("permission", "Enable Microphone access for T3 Code in iPhone Settings.")
              return
            }
            let recognizer = SFSpeechRecognizer(locale: Locale.current)
            guard recognizer?.supportsOnDeviceRecognition == true, recognizer?.isAvailable == true else {
              promise.reject("unavailable", "On-device speech recognition is unavailable for this iPhone language. Download its dictation language in iPhone Settings and try again.")
              return
            }
            self.recognizer = recognizer
            promise.resolve()
          }
        }
      }
    }
  }

  func listen(_ promise: Promise) {
    stop()
    guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
      promise.reject("unavailable", "On-device speech recognition is unavailable.")
      return
    }
    let listening = generation
    pending = promise
    transcript = ""
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
      try session.setActive(true)
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.requiresOnDeviceRecognition = true
      request.shouldReportPartialResults = true
      request.taskHint = .dictation
      self.request = request
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        finish(error: "No microphone is available.")
        return
      }
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }
      tapped = true
      task = recognizer.recognitionTask(with: request) { [weak self] result, error in
        DispatchQueue.main.async {
          guard let self, self.generation == listening, self.pending != nil else { return }
          if let result {
            let text = result.bestTranscription.formattedString
            if text != self.transcript {
              self.transcript = text
              self.silenceTimer?.invalidate()
              self.silenceTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
                self?.finish()
              }
            }
            if result.isFinal { self.finish(); return }
          }
          if error != nil { self.finish(error: "Speech recognition stopped. Try resuming voice chat.") }
        }
      }
      engine.prepare()
      try engine.start()
      limitTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
        self?.finish()
      }
    } catch {
      finish(error: "Could not start the microphone. Check your audio connection and try again.")
    }
  }

  func speak(_ text: String, promise: Promise) {
    stop()
    pending = promise
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try session.setActive(true)
      let utterance = AVSpeechUtterance(string: text)
      self.utterance = utterance
      
      let allVoices = AVSpeechSynthesisVoice.speechVoices()
      // Prioritize Ava (Premium/Enhanced), then any Premium voice, then Enhanced, then Siri, then locale default
      let voice = allVoices.first(where: { $0.name.localizedCaseInsensitiveContains("Ava") && $0.quality == .premium })
        ?? allVoices.first(where: { $0.name.localizedCaseInsensitiveContains("Ava") })
        ?? allVoices.first(where: { $0.language.hasPrefix("en") && $0.quality == .premium })
        ?? allVoices.first(where: { $0.language.hasPrefix("en") && $0.quality == .enhanced })
        ?? allVoices.first(where: { $0.identifier.contains("siri") })
        ?? AVSpeechSynthesisVoice(language: Locale.current.identifier)
      
      utterance.voice = voice
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.02
      utterance.pitchMultiplier = 1.0
      synthesizer.speak(utterance)
    } catch {
      finish(error: "Could not play the spoken reply. Check your audio connection.")
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    guard self.utterance === utterance else { return }
    finish()
  }

  func stop() {
    let promise = pending
    pending = nil
    cleanup()
    promise?.reject("cancelled", "Voice chat was paused.")
  }

  private func finish(error: String? = nil) {
    guard let promise = pending else { return }
    pending = nil
    let text = transcript
    cleanup()
    if let error { promise.reject("voice", error) }
    else { promise.resolve(text) }
  }

  private func cleanup() {
    generation += 1
    silenceTimer?.invalidate()
    limitTimer?.invalidate()
    silenceTimer = nil
    limitTimer = nil
    engine.stop()
    if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    utterance = nil
    synthesizer.stopSpeaking(at: .immediate)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
