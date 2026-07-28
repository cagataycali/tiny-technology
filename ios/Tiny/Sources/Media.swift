/**
 * Media — Spotify hooks, URL-scheme-first (MusicKit later, per backlog).
 *
 *   - spotifyLinks(in:): open.spotify.com URLs in assistant replies become
 *     tappable "Open in Spotify" chips under the bubble
 *   - searchURL(_:): universal link that deep-links into the Spotify app
 *     when installed, web player otherwise — used by the relay so the web
 *     agent can say "play X on my phone" (foreground only; iOS forbids
 *     opening apps from a backgrounded process)
 */
import Foundation

enum Media {
    static func spotifyLinks(in text: String) -> [URL] {
        let pattern = "https://open\\.spotify\\.com/[A-Za-z0-9/_?=&.-]+"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        var seen = Set<String>()
        return re.matches(in: text, range: range).compactMap {
            guard let r = Range($0.range, in: text) else { return nil }
            let s = String(text[r])
            guard seen.insert(s).inserted else { return nil }
            return URL(string: s)
        }
    }

    static func searchURL(_ query: String) -> URL? {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlPathAllowedCharacterSetSafe) ?? query
        return URL(string: "https://open.spotify.com/search/\(q)")
    }

    /// "play daft punk on spotify" → "daft punk"
    static func musicQuery(from prompt: String) -> String {
        var q = prompt
        // Word-boundary match so the "play" verb is stripped wherever it leads
        // ("play …", "can you play …") WITHOUT matching it as a substring —
        // \b means "dis[play] the charts" isn't mistaken for the command.
        if let r = q.range(of: "\\bplay\\s", options: [.regularExpression, .caseInsensitive]) {
            q = String(q[r.upperBound...])
        }
        for suffix in [" on spotify", " in spotify", " on the phone", " spotify"] {
            while q.lowercased().hasSuffix(suffix) { q = String(q.dropLast(suffix.count)) }
        }
        return q.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }
}

private extension CharacterSet {
    /// urlPathAllowed still permits "/" — percent-encode it inside a search term
    static var urlPathAllowedCharacterSetSafe: CharacterSet {
        var set = CharacterSet.urlPathAllowed
        set.remove(charactersIn: "/?")
        return set
    }
}
