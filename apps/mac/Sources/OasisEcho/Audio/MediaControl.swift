import AppKit
import Foundation

// Pause / resume whatever app currently owns the "Now Playing" slot on
// macOS — YouTube in any browser tab, Spotify, Apple Music, Podcasts,
// Netflix, VLC, etc. Uses two building blocks:
//
//   1. MediaRemote.framework (private but stable since 10.12.4) to
//      query whether something is actually playing. Without this we
//      would risk *starting* playback when the user triggers capture
//      while everything was already paused.
//
//   2. A synthetic NX_KEYTYPE_PLAY system-defined event to toggle
//      play/pause — the same signal an F8 keystroke or a Bluetooth
//      headset's pause button sends. Every mainstream media app
//      listens for it.
//
// This is deliberately coarse: one toggle, no per-app logic, no
// AppleScript. If the private framework is missing on some future
// macOS release, the query simply returns false and we skip pausing
// rather than risk waking paused media up.

enum MediaControl {

    // The last-known "we paused it" flag. Protected by the main actor —
    // every call site already runs on main.
    private static var pausedByUs = false

    // MARK: - Private framework bootstrap

    private static let framework: CFBundle? = {
        let url = URL(fileURLWithPath: "/System/Library/PrivateFrameworks/MediaRemote.framework")
        return CFBundleCreate(kCFAllocatorDefault, url as CFURL)
    }()

    // MRMediaRemoteGetNowPlayingApplicationIsPlaying(queue, callback)
    private typealias IsPlayingFn = @convention(c) (DispatchQueue, @escaping @convention(block) (Bool) -> Void) -> Void

    private static let isPlayingFn: IsPlayingFn? = {
        guard let bundle = framework,
              let ptr = CFBundleGetFunctionPointerForName(
                bundle,
                "MRMediaRemoteGetNowPlayingApplicationIsPlaying" as CFString
              )
        else { return nil }
        return unsafeBitCast(ptr, to: IsPlayingFn.self)
    }()

    // MARK: - Public API

    /// If something is currently playing, toggle play/pause so it pauses,
    /// and remember that we did. Fire-and-forget; the callback fires
    /// after the async isPlaying probe completes (~1 ms) so that cap
    /// start is not blocked.
    @MainActor
    static func pauseIfPlaying() {
        guard let fn = isPlayingFn else { return }  // framework unavailable → no-op
        fn(.main) { playing in
            Task { @MainActor in
                guard playing, !pausedByUs else { return }
                sendPlayPauseToggle()
                pausedByUs = true
            }
        }
    }

    /// Resume what we paused, if anything. Safe to call unconditionally.
    @MainActor
    static func resumeIfPaused() {
        guard pausedByUs else { return }
        sendPlayPauseToggle()
        pausedByUs = false
    }

    // MARK: - System event

    // Code 16 is NX_KEYTYPE_PLAY in IOKit/hidsystem/ev_keymap.h.
    private static let NX_KEYTYPE_PLAY: Int32 = 16

    private static func sendPlayPauseToggle() {
        post(keyDown: true)
        post(keyDown: false)
    }

    private static func post(keyDown: Bool) {
        let flags = keyDown ? 0xA : 0xB
        let data1 = Int((NX_KEYTYPE_PLAY << 16) | Int32(flags << 8))
        guard let event = NSEvent.otherEvent(
            with: .systemDefined,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            subtype: 8,           // NSSystemDefined kIOHIDAuxControlButton
            data1: data1,
            data2: -1
        ) else { return }
        event.cgEvent?.post(tap: .cghidEventTap)
    }
}
