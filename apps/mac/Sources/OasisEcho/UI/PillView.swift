import SwiftUI

// ONE orb. Always rendered. Only the animation rate, the colour, and
// optional pulse rings change per state. There is no second "pill"
// view that replaces the orb — the visual on screen is the same disk
// at the same coordinates the user has watched since launch.
//
// Transient feedback (Pasted / Copied · ⌘V / Mode switched / Error)
// floats above the orb as a small bubble, then fades away. The orb
// underneath is never replaced.
struct PillView: View {
    @EnvironmentObject var state: AppState

    // Geometry — kept tight so the panel can hug the orb and not
    // intercept clicks across a huge dead zone.
    private let coreSize: CGFloat = 18
    private let canvasSize: CGFloat = 36

    @State private var hovering = false
    @State private var startedAt = Date()
    @State private var now = Date()
    private let tick = Timer.publish(every: 1.0 / 60.0, on: .main, in: .common).autoconnect()

    var body: some View {
        let t = now.timeIntervalSince(startedAt)
        VStack(spacing: 4) {
            if hasToast {
                toastBubble.transition(.opacity.combined(with: .scale(scale: 0.94)))
            }
            orb(t: t)
        }
        .onReceive(tick) { now = $0 }
        .onHover { hovering = $0 }
        .transaction { $0.animation = nil }
    }

    // MARK: - Orb

    @ViewBuilder
    private func orb(t: Double) -> some View {
        ZStack {
            // Pulse rings — only when actively listening or speaking.
            // Rings emanate FROM the orb; the orb itself stays put.
            if isActive {
                ForEach(0..<3, id: \.self) { i in
                    let phase = (t * pulseRate + Double(i) * 0.45)
                        .truncatingRemainder(dividingBy: 1.4) / 1.4
                    let scale = 0.6 + phase * 1.45
                    let alpha = max(0, 1 - phase) * 0.85
                    Circle()
                        .stroke(activeColor.opacity(alpha), lineWidth: 1.5)
                        .frame(width: coreSize, height: coreSize)
                        .scaleEffect(scale)
                }
            }

            // Core gradient disk. Same disk at every state — only the
            // colour set changes when the server is unreachable.
            Circle()
                .fill(AngularGradient(
                    gradient: Gradient(colors: coreColors),
                    center: .center,
                    startAngle: .degrees(t * 25),
                    endAngle: .degrees(t * 25 + 360)
                ))
                .frame(width: coreSize, height: coreSize)
                .scaleEffect(1.0 + 0.08 * sin(t * 1.6))
                .shadow(color: activeColor.opacity(0.55), radius: 6)

            // Tiny recording dot, top-right of the orb, only when we
            // have the mic open.
            if case .listening = state.pill {
                Circle()
                    .fill(.red)
                    .frame(width: 6, height: 6)
                    .offset(x: coreSize / 2 + 3, y: -coreSize / 2 - 3)
                    .opacity(0.6 + 0.4 * sin(t * 6))
            }
        }
        .frame(width: canvasSize, height: canvasSize)
        .scaleEffect(hovering ? 1.08 : 1.0)
    }

    // MARK: - Toast bubble (transient states only)

    @ViewBuilder
    private var toastBubble: some View {
        switch state.pill {
        case .pasted(let words, let ms):
            bubble(systemImage: "checkmark.circle.fill",
                   color: .green,
                   text: words > 0 ? "\(words) words · \(ms)ms" : "Pasted")
        case .copiedOnly(let words):
            bubble(systemImage: "doc.on.clipboard.fill",
                   color: .yellow,
                   text: "Copied · ⌘V" + (words > 0 ? " (\(words))" : ""))
        case .modeSwitched(let mode):
            bubble(systemImage: mode == .echo ? "bubble.left.and.bubble.right.fill" : "text.cursor",
                   color: mode == .echo ? .purple : .blue,
                   text: "Mode: \(mode.label)")
        case .error(let msg):
            bubble(systemImage: "exclamationmark.triangle.fill",
                   color: .orange,
                   text: msg)
        case .processing:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Polishing…").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(.ultraThinMaterial, in: Capsule())
        default:
            EmptyView()
        }
    }

    private func bubble(systemImage: String, color: Color, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage).foregroundStyle(color)
            Text(text).font(.system(size: 11, weight: .medium)).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(.ultraThinMaterial, in: Capsule())
    }

    // MARK: - State-derived visuals

    private var isActive: Bool {
        switch state.pill {
        case .listening, .speaking, .processing: return true
        default: return false
        }
    }

    private var hasToast: Bool {
        switch state.pill {
        case .pasted, .copiedOnly, .modeSwitched, .error, .processing:
            return true
        default:
            return false
        }
    }

    private var pulseRate: Double {
        switch state.pill {
        case .speaking:    return 0.95
        case .listening:   return 1.20
        case .processing:  return 0.55
        default:           return 0.55
        }
    }

    private var activeColor: Color {
        // Mode tinting only when actually capturing/speaking; keep
        // the resting orb neutral.
        switch state.pill {
        case .listening, .speaking:
            return state.mode == .echo ? .purple : .blue
        default:
            return .blue
        }
    }

    private var coreColors: [Color] {
        if state.serverReachable {
            return [
                Color(red: 0.36, green: 0.60, blue: 1.00),
                Color(red: 0.62, green: 0.48, blue: 1.00),
                Color(red: 0.92, green: 0.44, blue: 0.80),
                Color(red: 0.36, green: 0.60, blue: 1.00)
            ]
        } else {
            return [.gray, Color.gray.opacity(0.4), .gray]
        }
    }
}

// Live partial-transcript caption shown above the orb during
// Transcribe-mode capture. Same backdrop treatment as the toast bubble.
struct PillCaption: View {
    @EnvironmentObject var state: AppState
    var body: some View {
        if state.liveTranscript.isEmpty {
            EmptyView()
        } else {
            Text(state.liveTranscript)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(.ultraThinMaterial, in: Capsule())
        }
    }
}
