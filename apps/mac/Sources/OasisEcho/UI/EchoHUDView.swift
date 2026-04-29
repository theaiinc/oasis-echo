import SwiftUI

// Echo's reply text rendered above the orb. Lives in its own NSPanel
// (EchoDialogWindowController) at a fixed size, so the view just fills
// its container — no manual heights, no gradient-fade-into-orb trick.
//
// Rules:
//   • Only the agent's reply is shown. No "You" line, no role labels.
//   • Filler chunks are filtered upstream by TurnController.
//   • Auto-scroll anchored at .bottom so the freshest text is visible.
//   • Glass card look: ultraThinMaterial + a soft inner highlight stroke
//     and a thin outer hairline for that frosted-on-glass edge.
struct EchoHUDView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        let text = state.agentMessages.last(where: { $0.role == .echo })?.text ?? ""
        ZStack {
            glassBackground

            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    Text(text.isEmpty ? " " : text)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(2)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.horizontal, 22)
                        .padding(.top, 16)
                        // Extra bottom padding so text never lives in
                        // the faded region — anything below ~80% of the
                        // dialog height is being dissolved by the mask.
                        .padding(.bottom, 56)
                        .id("end")
                }
                .onChange(of: text) { _ in
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo("end", anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(6)
        // Whole-card mask: background, strokes, AND text fade together
        // so the dialog dissolves cleanly toward the orb. Bottom 20% is
        // a smooth gradient down to transparent.
        .mask(bottomFadeMask)
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    private var bottomFadeMask: some View {
        LinearGradient(
            stops: [
                .init(color: .black, location: 0.00),
                .init(color: .black, location: 0.80),
                .init(color: .clear, location: 1.00)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // Frosted-glass card: vibrancy material + a subtle white highlight
    // stroke on the inside edge (sells the "lit from above" depth) and
    // a hairline outer stroke so the card has a defined boundary
    // against any background.
    private var glassBackground: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return shape
            .fill(.ultraThinMaterial)
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.30),
                            Color.white.opacity(0.05)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1
                )
            )
            .overlay(
                shape.stroke(Color.black.opacity(0.18), lineWidth: 0.5)
            )
    }
}
