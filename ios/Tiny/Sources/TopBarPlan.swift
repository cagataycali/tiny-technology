/**
 * 📐 TopBarPlan — the width-budget planner for the presence strip.
 *
 * iOS 26 does not truncate a trailing toolbar item it cannot fit: it EVICTS the
 * whole custom capsule (and the principal title) into "More" — proven on the
 * owner's 402 pt phone, build 88, 2026-09-17. So the strip must never ask for
 * more width than the bar has. This planner decides, from the online bodies
 * (newest first) and the width the bar can spare, which tiles render inline and
 * which fold into the Devices menu (the menu is ALWAYS there — it lists every
 * body, offline ones dimmed — and wears a "+N" badge when it holds overflow).
 *
 * Pure. TinyTests/TopBarPlanTests pins it at 402 / 393 / 375 pt with 0…6 online.
 */
import CoreGraphics

enum TopBarPlan {
    struct Plan: Equatable {
        var inline: [BodyId] = []
        var overflow: [BodyId] = []
        var overflowCount: Int { overflow.count }
    }

    /// Tile metrics (points). A camera tile is the 46×30 live thumbnail
    /// (ArmToolbarButton's size since build 79); a glyph tile is 30×30.
    static let cameraTileWidth: CGFloat = 46
    static let glyphTileWidth: CGFloat = 30
    static let gap: CGFloat = 6
    /// The Devices menu button (overflow + offline list) is always inline.
    static let menuWidth: CGFloat = 30

    /// What the rest of the bar needs on a compact phone: the leading universe
    /// button (56 incl. margins), the account Menu (56) and a title that stays
    /// readable (88 — "tiny" with the lock glyph, or the inline navigationTitle).
    static let leadingReserve: CGFloat = 56
    static let accountReserve: CGFloat = 56
    static let minTitleReserve: CGFloat = 88

    /// Width left for tiles on a bar `screenWidth` wide (menu already deducted).
    static func available(screenWidth: CGFloat) -> CGFloat {
        max(0, screenWidth - leadingReserve - accountReserve - minTitleReserve - menuWidth - gap)
    }

    static func tileWidth(_ id: BodyId) -> CGFloat {
        id.hasCamera ? cameraTileWidth : glyphTileWidth
    }

    /// Width the inline tiles of `plan` occupy (tiles + gaps between them and the menu).
    static func inlineWidth(_ inline: [BodyId]) -> CGFloat {
        inline.reduce(0) { $0 + tileWidth($1) + gap }
    }

    /// Greedy in the given order (callers pass newest-online first): a tile goes
    /// inline while it fits; the first one that does not, and everything after
    /// it, overflow — order is preserved so the menu lists newest first too.
    /// Bodies are never skipped-then-resumed: a later, narrower glyph tile does
    /// not jump ahead of an older camera tile (stable positions matter more than
    /// squeezing one more glyph in).
    static func make(online: [BodyId], available: CGFloat) -> Plan {
        var plan = Plan()
        var used: CGFloat = 0
        var spilled = false
        for id in online {
            let w = tileWidth(id) + gap
            if !spilled, used + w <= available {
                plan.inline.append(id)
                used += w
            } else {
                spilled = true
                plan.overflow.append(id)
            }
        }
        return plan
    }

    /// Convenience: plan straight from a screen width.
    static func make(online: [BodyId], screenWidth: CGFloat) -> Plan {
        make(online: online, available: available(screenWidth: screenWidth))
    }
}
