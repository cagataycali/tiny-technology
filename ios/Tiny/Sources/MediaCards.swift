/**
 * 🖼️🎬🔊 Inline chat media — the agent's markdown images and media links
 * become real players instead of literal text.
 *
 * The necklace (and glasses) reply with hosted URLs: JPEG photos, animated
 * GIF clips, WAV audio, MP4 video. MarkdownText only styles prose, so
 * `![clip](….gif)` rendered as raw text and a .wav link opened Safari.
 * MessageBubble now splits a message into (prose, media) with
 * ChatMedia.extract and renders each media item with the right player:
 *   jpg/png/webp → AsyncImage      gif → frame-animated UIImageView
 *   wav/mp3/m4a → AVPlayer card    mp4/mov/m4v → AVKit VideoPlayer
 */
import AVKit
import SwiftUI
import UIKit

enum ChatMedia: Identifiable, Equatable {
    case image(URL)
    case gif(URL)
    case audio(URL)
    case video(URL)

    var id: URL {
        switch self {
        case .image(let u), .gif(let u), .audio(let u), .video(let u): return u
        }
    }

    static func classify(_ url: URL) -> ChatMedia? {
        switch url.pathExtension.lowercased() {
        case "jpg", "jpeg", "png", "webp": return .image(url)
        case "gif": return .gif(url)
        case "wav", "mp3", "m4a", "aac": return .audio(url)
        case "mp4", "mov", "m4v", "webm": return .video(url)
        default: return nil
        }
    }

    /// Split message text into (prose without media markup, media items).
    /// Handles `![alt](url)` anywhere in a line — including butted against
    /// prose (`…jpg)Anything else?`) — plus bare media URLs on their own.
    ///
    /// Code is off-limits: a URL inside a ``` fence or an inline `code` span
    /// belongs to a command the user copies, so extracting it would silently
    /// delete part of that command and hoist it into a player. Fenced regions
    /// are split out, transformed piecewise, and rejoined unchanged.
    static func extract(from text: String) -> (String, [ChatMedia]) {
        // Odd-indexed pieces are inside ``` fences; leave them verbatim.
        let fenced = text.components(separatedBy: "```")
        var media: [ChatMedia] = []
        var out: [String] = []
        for (i, piece) in fenced.enumerated() {
            if i % 2 == 1 {
                out.append(piece)
            } else {
                let (prose, found) = extractFromProse(piece)
                media += found
                out.append(prose)
            }
        }
        let joined = out.joined(separator: fenced.count > 1 ? "```" : "")
        return (joined.trimmingCharacters(in: .whitespacesAndNewlines), media)
    }

    /// extract() for a fence-free region, skipping inline `code` spans.
    private static func extractFromProse(_ text: String) -> (String, [ChatMedia]) {
        let spans = text.components(separatedBy: "`")
        guard spans.count > 1 else { return extractRaw(text) }
        var media: [ChatMedia] = []
        var out: [String] = []
        for (i, piece) in spans.enumerated() {
            if i % 2 == 1 {
                out.append(piece)               // inside backticks
            } else {
                let (prose, found) = extractRaw(piece)
                media += found
                out.append(prose)
            }
        }
        return (out.joined(separator: "`"), media)
    }

    private static func extractRaw(_ text: String) -> (String, [ChatMedia]) {
        // Both passes match against the ORIGINAL text and collect (range, item),
        // so the hits can be ordered by position. Extracting pass 1 before
        // scanning pass 2 (and un-reversing the concatenation at the end) put a
        // leading `![img]` AFTER the bare links that followed it in the message.
        var hits: [(range: NSRange, media: ChatMedia)] = []
        let full = NSRange(text.startIndex..., in: text)

        // 1. Markdown images: EVERY occurrence, keeping the surrounding prose.
        if let re = try? NSRegularExpression(pattern: #"!\[[^\]]*\]\((https?://[^)\s]+)\)"#) {
            for m in re.matches(in: text, range: full) {
                guard let urlRange = Range(m.range(at: 1), in: text),
                      let url = URL(string: String(text[urlRange])) else { continue }
                // An image tag is an image even without a file extension.
                hits.append((m.range, classify(url) ?? .image(url)))
            }
        }

        // 2. Bare media links (the audio-clip replies): only when classifiable,
        //    and never one already claimed as the URL inside an image tag.
        if let re = try? NSRegularExpression(pattern: #"https?://[^\s<>()"]+\.(wav|mp3|m4a|aac|mp4|mov|m4v|gif)\b"#, options: [.caseInsensitive]) {
            for m in re.matches(in: text, range: full) {
                guard !hits.contains(where: { NSIntersectionRange($0.range, m.range).length > 0 }),
                      let r = Range(m.range, in: text),
                      let url = URL(string: String(text[r])),
                      let item = classify(url) else { continue }
                hits.append((m.range, item))
            }
        }

        hits.sort { $0.range.location < $1.range.location }
        var prose = text
        // Cut back-to-front so each removal leaves the earlier offsets valid.
        for hit in hits.reversed() {
            if let r = Range(hit.range, in: prose) { prose.removeSubrange(r) }
        }
        // NOT trimmed here: pieces are rejoined around code spans, and trimming
        // each one would eat the spaces beside them ("use `-f` then" → "use`-f`then").
        // extract() trims once, at the end.
        return (prose, hits.map(\.media))
    }
}

struct ChatMediaCard: View {
    let media: ChatMedia
    @State private var showViewer = false

    var body: some View {
        Group {
            switch media {
            case .image(let url):
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .failure: mediaMiss("photo unavailable")
                    default: ProgressView().frame(height: 120)
                    }
                }
                .frame(maxWidth: 280)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(alignment: .topTrailing) { mediaActions }
                .onTapGesture { showViewer = true }
            case .gif(let url):
                ChatGIFView(url: url)
                    .frame(maxWidth: 280, maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(alignment: .topTrailing) { mediaActions }
                    .onTapGesture { showViewer = true }
            case .audio(let url):
                AudioClipCard(url: url, trailing: {
                    AnyView(ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.down")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                    })
                })
            case .video(let url):
                VideoPlayer(player: AVPlayer(url: url))
                    .frame(maxWidth: 280)
                    .aspectRatio(4.0 / 3.0, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(alignment: .topTrailing) { mediaActions }
            }
        }
        .fullScreenCover(isPresented: $showViewer) {
            MediaViewerSheet(media: media)
        }
    }

    /// ⬇ share/save + ⤢ full-screen, floating on the media corner. ShareLink's
    /// sheet carries "Save Image"/"Save to Files" — the platform's download.
    private var mediaActions: some View {
        HStack(spacing: 6) {
            ShareLink(item: media.id) {
                Image(systemName: "square.and.arrow.down")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(6)
                    .background(.ultraThinMaterial, in: Circle())
            }
            Button {
                showViewer = true
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(6)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel("View full screen")
        }
        .foregroundStyle(.primary)
        .padding(6)
    }

    private func mediaMiss(_ label: String) -> some View {
        Text(label).font(.caption2).foregroundStyle(.secondary)
            .frame(maxWidth: 280, minHeight: 60)
            .background(Color(.secondarySystemBackground))
    }
}

/// Full-screen media viewer: pinch-zoom images/GIFs, autoplaying video,
/// share (= download) in the toolbar.
struct MediaViewerSheet: View {
    let media: ChatMedia
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch media {
                case .image(let url):
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFit()
                                .scaleEffect(scale)
                                .gesture(
                                    MagnificationGesture()
                                        .onChanged { scale = max(1, $0) }
                                        .onEnded { _ in withAnimation { scale = min(max(1, scale), 5) } }
                                )
                        } else {
                            ProgressView().tint(.white)
                        }
                    }
                case .gif(let url):
                    ChatGIFView(url: url)
                case .audio(let url):
                    AudioClipCard(url: url, trailing: { AnyView(EmptyView()) })
                        .padding()
                case .video(let url):
                    VideoPlayer(player: player)
                        .onAppear {
                            let p = AVPlayer(url: url)
                            player = p
                            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                            p.play()
                        }
                        .onDisappear { player?.pause() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: media.id) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
    }
}

/// Animated GIF in chat — SwiftUI's Image/AsyncImage only ever show frame 1;
/// GIFDecoder (Views.swift) builds the animated UIImage. Reduce Motion shows
/// the first frame alone.
struct ChatGIFView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> UIImageView {
        let v = UIImageView()
        v.contentMode = .scaleAspectFit
        v.clipsToBounds = true
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        let animate = !UIAccessibility.isReduceMotionEnabled
        let url = url
        Task { @MainActor [weak v] in
            guard let (data, resp) = try? await URLSession.shared.data(from: url),
                  (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true
            else { return }
            v?.image = animate ? GIFDecoder.animatedImage(data) : UIImage(data: data)
        }
        return v
    }

    func updateUIView(_ uiView: UIImageView, context: Context) {}
}

/// A hosted audio clip (the necklace's 2s WAVs, voice notes) as a play/pause
/// card — SpeechCardView's remote-URL sibling.
struct AudioClipCard: View {
    let url: URL
    var trailing: () -> AnyView = { AnyView(EmptyView()) }
    @State private var player: AVPlayer?
    @State private var playing = false

    var body: some View {
        HStack(spacing: 12) {
            Button {
                toggle()
            } label: {
                Image(systemName: playing ? "stop.fill" : "play.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Color.accentColor, in: Circle())
            }
            .accessibilityLabel(playing ? "Stop audio clip" : "Play audio clip")
            VStack(alignment: .leading, spacing: 3) {
                Text(playing ? "PLAYING" : "AUDIO CLIP")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .kerning(0.8)
                Text(url.lastPathComponent)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(12)
        .frame(maxWidth: 280, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func toggle() {
        if playing {
            player?.pause()
            playing = false
            return
        }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        let p = AVPlayer(url: url)
        player = p
        NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
        ) { _ in Task { @MainActor in playing = false } }
        p.play()
        playing = true
    }
}
