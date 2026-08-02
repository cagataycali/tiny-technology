/**
 * ChatMediaTests — the chat media splitter (MediaCards.swift ChatMedia.extract).
 *
 * This is the logic that broke in the user's hands: the agent butts an image
 * against prose (`…jpg)Anything else?`) and replies with bare .wav/.gif links,
 * so a whole-line-only parser rendered them as literal markdown text. extract()
 * pulls every media URL out into real players and leaves the prose readable.
 *
 * The sharp edge is CODE: a URL inside a ``` fence or an inline `code` span is
 * part of a command the user copies. Extracting it would silently DELETE part of
 * that command and hoist it into a player, so the fenced/backticked regions must
 * come back byte-identical.
 *
 * Android parity target: android/…/ui/Markdown.kt (isolateMediaLines +
 * mediaLineMatch) and MarkdownMediaTest.kt — the twin that must classify the
 * same URLs the same way.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct ChatMediaExtractTests {

    // ── extraction: the fix for "media rendered as raw text" ─────────────────

    @Test func imageButtedAgainstProseIsExtracted() {
        let (prose, media) = ChatMedia.extract(
            from: "Got it 📸 — ![necklace photo](https://plugin.tiny.technology/media/a1.jpg)Anything else?"
        )
        #expect(media == [.image(URL(string: "https://plugin.tiny.technology/media/a1.jpg")!)])
        #expect(prose == "Got it 📸 — Anything else?")
    }

    @Test func bareMediaLinkIsExtractedAndClassified() {
        let (prose, media) = ChatMedia.extract(
            from: "Here's the clip https://plugin.tiny.technology/media/b2.wav have a listen"
        )
        #expect(media == [.audio(URL(string: "https://plugin.tiny.technology/media/b2.wav")!)])
        #expect(prose.contains("Here's the clip"))
        #expect(!prose.contains("b2.wav"))
    }

    @Test func severalMediaItemsComeBackInDocumentOrder() {
        let (_, media) = ChatMedia.extract(
            from: "photo ![p](https://x.test/1.jpg) then clip https://x.test/2.gif and audio https://x.test/3.wav"
        )
        #expect(media.map(\.id.lastPathComponent) == ["1.jpg", "2.gif", "3.wav"])
    }

    @Test func markdownImageIsNotAlsoExtractedAsABareLink() {
        // The image regex runs first and removes the whole `![…](…)`, so the bare
        // -URL pass must not find a second copy of a .gif image tag.
        let (prose, media) = ChatMedia.extract(from: "![clip](https://x.test/c.gif)")
        #expect(media == [.gif(URL(string: "https://x.test/c.gif")!)])
        #expect(prose.isEmpty)
    }

    @Test func proseWithoutMediaIsUntouched() {
        let text = "Just a sentence about a gif, no links here."
        let (prose, media) = ChatMedia.extract(from: text)
        #expect(media.isEmpty)
        #expect(prose == text)
    }

    // ── classification: extension vocabulary, shared with Android ────────────

    @Test func extensionsClassifyDistinctly() {
        func kind(_ s: String) -> ChatMedia? { ChatMedia.classify(URL(string: s)!) }
        #expect(kind("https://x.test/a.jpg") == .image(URL(string: "https://x.test/a.jpg")!))
        #expect(kind("https://x.test/a.gif") == .gif(URL(string: "https://x.test/a.gif")!))
        #expect(kind("https://x.test/a.wav") == .audio(URL(string: "https://x.test/a.wav")!))
        #expect(kind("https://x.test/a.m4a") == .audio(URL(string: "https://x.test/a.m4a")!))
        #expect(kind("https://x.test/a.mp4") == .video(URL(string: "https://x.test/a.mp4")!))
        #expect(kind("https://x.test/a.mov") == .video(URL(string: "https://x.test/a.mov")!))
        #expect(kind("https://tiny.technology/about") == nil)
    }

    @Test func extensionMatchingIsCaseInsensitive() {
        let (_, media) = ChatMedia.extract(from: "see https://x.test/A.GIF now")
        #expect(media.count == 1)
        // classify() lowercases the extension, so an uppercase URL still plays.
        #expect(media.first == .gif(URL(string: "https://x.test/A.GIF")!))
    }

    @Test func anImageTagWithoutAnExtensionIsStillAnImage() {
        // R2 signed URLs can arrive extension-less; `![…]` is the author's claim.
        let (_, media) = ChatMedia.extract(from: "![shot](https://x.test/media/abc123)")
        #expect(media == [.image(URL(string: "https://x.test/media/abc123")!)])
    }

    // ── code is off-limits ───────────────────────────────────────────────────

    @Test func mediaURLInsideACodeFenceSurvivesAsCode() {
        let src = "Run this:\n```bash\ncurl -o out.gif https://x.test/clip.gif\n```\ndone"
        let (prose, media) = ChatMedia.extract(from: src)
        #expect(media.isEmpty)
        #expect(prose.contains("curl -o out.gif https://x.test/clip.gif"))
        #expect(prose == src)   // fences rejoin byte-identical
    }

    @Test func mediaURLInAnInlineCodeSpanIsLeftAlone() {
        let src = "run `curl https://x.test/clip.gif` then play it"
        let (prose, media) = ChatMedia.extract(from: src)
        #expect(media.isEmpty)
        #expect(prose == src)
    }

    @Test func mediaOutsideBackticksStillExtractsWhenACodeSpanIsPresent() {
        let (prose, media) = ChatMedia.extract(from: "use `--flag` then see https://x.test/c.wav ok")
        #expect(media == [.audio(URL(string: "https://x.test/c.wav")!)])
        // The space either side of the code span must survive the rejoin —
        // trimming each piece would give "use`--flag`then".
        #expect(prose.contains("use `--flag` then see"))
    }

    @Test func codeAndRealMediaCanCoexistAcrossAFence() {
        let src = "Here it is:\n\n![clip](https://x.test/real.gif)\n\nTo re-download:\n```\ncurl https://x.test/real.gif\n```"
        let (prose, media) = ChatMedia.extract(from: src)
        #expect(media == [.gif(URL(string: "https://x.test/real.gif")!)])       // played once
        #expect(prose.contains("curl https://x.test/real.gif"))                 // and still copyable
    }
}
