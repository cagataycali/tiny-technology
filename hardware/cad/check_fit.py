#!/usr/bin/env python3
"""Clearance checker for the tiny necklace cases.

Every bug this pass has been the same shape: a number changed in one place
(depth dropped 3mm for the Voice) and silently broke a clearance somewhere
else (the bail poked through both faces; the door skirt reached into the PCB;
the LED window no longer covered the LED once board float was accounted for).
Renders did not catch any of them — arithmetic did.

So the invariants live here and run on every design change:

    python3 check_fit.py            # every case
    python3 check_fit.py voice      # one case

Exit code is nonzero if any check fails, so it can gate a slice.

Numbers come from two places, deliberately. The board's measured features are
mirrored here (they come from a datasheet and a caliper, not from the model).
Everything the MODEL derives is read back out of the model itself, by rendering
it with `part="values"` — see scad_values(). A checker that restates the
model's arithmetic can agree with nothing: the six-day-old "battery connector"
mislabel in the ledge comment is what that looks like.
"""
import math
import os
import re
import subprocess
import sys
import tempfile

# ---- geometry, mirrored from tiny_necklace_split.scad -------------------------
# These are cross-checked against the model's own values in check(), so a drift
# is a FAIL rather than a silently wrong pass.
PCB_XY, PCB_T = 22.86, 0.946
CAV, BELOW = 25.5, 3.4
DOOR_T, LEDGE = 1.4, 2.5
RIB_CLEAR = 0.15                      # per-side rib clearance
NOZZLE = 0.42                         # 0.4mm nozzle extrusion width

# ---- measured board features the battery bay has to live with ------------------
# From measure_step.py on Arduino's own NiclaVision.step, in board coords
# (PCB centre = origin, PCB top = z0). J4 is the battery connector — a
# BM03B-ACHSS, mid-board and only 1.45 deep. The 2.95-deep solid on the USB
# edge that the ledge notch clears is the ESLOV, SM05B-SRSS-TB.
J4 = dict(name="J4 battery (BM03B-ACHSS)",
          x0=3.87, x1=8.17, y0=3.17, y1=8.57, deep=1.45)
WIRE_OD = 1.10                        # a pair of 28AWG leads, side by side

BOARDS = {
    "vision": dict(
        depth=12.5, cav_h=10.0,
        defines=dict(face='"mark2"', bat="false"),
        tallest=5.08,                 # camera module above PCB top
        deepest=2.95,                 # ESLOV connector below PCB bottom
        # (feature, x, y, hole, part_w, part_h, mode)
        #   mode "cover" -> the hole must be at least as big as the part
        #   mode "probe" -> the hole must sit INSIDE the part (a poke hole)
        # hole is a diameter, or (w, h) for a stadium/slot.
        # v2.5: holes are part + float + 0.25 print margin, NOT the old
        # float-absorbing oversizes — the lens at 6.8 + 1.0 cone flare read
        # ~8.8 at the face and merged with all three neighbours.
        ports=[
            # the lens wall check must use the FACE opening (lens_d + 2*cone),
            # which is the widest point, not the barrel bore
            ("camera lens", -2.55, 7.84, 5.8 + 2 * 0.15, 5.3, 5.3,  "cover"),
            ("mic",         -7.63, 8.03, 1.6,            1.0, 1.0,  "cover"),
            # the slot exposes the ToF's two ~1.0 optical apertures, not its
            # whole 2.5-tall package: the package's +Y edge is 0.77mm from the
            # camera barrel, so covering it whole CANNOT leave a printable wall
            ("ToF apertures", -3.20, 3.17, (5.5, 1.5),   4.0, 1.0,  "cover"),
            ("reset pin",      2.40, 8.67, 1.6,          2.6, 3.05, "probe"),
        ],
        float_pm=RIB_CLEAR,
    ),
    "voice": dict(
        depth=9.5, cav_h=7.0,
        defines=dict(face='"voice"', bat="false"),
        tallest=1.50,
        deepest=2.95,
        ports=[
            ("LED window", -10.24, 10.24, 3.4, 1.0, 1.08, "cover"),
            ("reset pin",   -7.58,  8.03, 1.6, 2.6, 3.05, "probe"),
        ],
        float_pm=RIB_CLEAR,
    ),
}
# Same board, taller shell: the battery locket carries the identical Vision, so
# every port and every clearance above the PCB is inherited rather than restated.
# Only depth, the cavity floor and the third part differ, and those come out of
# the model's own values.
BOARDS["vision_batt"] = dict(
    BOARDS["vision"], depth=18.2,
    defines=dict(face='"mark2"', bat="true"), battery=True)

# where the parts actually are, when different from the hole centre
PART_AT = {
    ("voice", "LED window"): (-9.89, 9.89),
}

# ---- the model's own numbers ---------------------------------------------------
SCAD = "tiny_necklace_split.scad"
CAD_DIR = os.path.dirname(os.path.abspath(__file__))
_VALS = {}


def scad_values(**defines):
    """Every derived number in the .scad, read back from the .scad.

    `part="values"` echoes one line of key=value pairs and builds no geometry,
    so this costs about a tenth of a second and cannot disagree with the STL
    that gets sliced. Rendering to `--export-format echo` is what makes the
    echo reachable without a viewer.
    """
    key = tuple(sorted(defines.items()))
    if key in _VALS:
        return _VALS[key]
    cmd = ["openscad", "--export-format", "echo"]
    with tempfile.NamedTemporaryFile(suffix=".echo") as tmp:
        cmd += ["-o", tmp.name, "-D", 'part="values"']
        for k, v in defines.items():
            cmd += ["-D", f"{k}={v}"]
        cmd.append(os.path.join(CAD_DIR, SCAD))
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.SubprocessError) as e:
            raise RuntimeError(f"cannot run openscad ({e}) — "
                               "the model's values are unreadable") from e
        out = open(tmp.name).read()
    m = re.search(r'ECHO: "VALS (.*)"', out)
    if not m:
        raise RuntimeError(f"{SCAD} printed no VALS line for {defines} "
                           f"(openscad said: {r.stderr.strip()[:200]})")
    vals = {k: float(v) for k, v in (p.split("=") for p in m.group(1).split())}
    _VALS[key] = vals
    return vals


def port_capsule(port):
    """A port as (centre segment, radius). A stadium (w,h) is a segment of
    length w-h with radius h/2; a plain circle is a zero-length segment."""
    _, x, y, hole = port[0], port[1], port[2], port[3]
    if isinstance(hole, tuple):
        w, h = hole
        half = max(0.0, (w - h) / 2)      # stadiums here are always X-major
        return (x - half, y, x + half, y), h / 2
    return (x, y, x, y), hole / 2


def seg_gap(p, q):
    """Shortest distance between two 2D segments."""
    def pt_seg(px, py, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((px-ax)*dx + (py-ay)*dy) / L))
        return math.hypot(px - (ax + t*dx), py - (ay + t*dy))
    ax, ay, bx, by = p
    cx, cy, dx_, dy_ = q
    return min(pt_seg(ax, ay, cx, cy, dx_, dy_), pt_seg(bx, by, cx, cy, dx_, dy_),
               pt_seg(cx, cy, ax, ay, bx, by), pt_seg(dx_, dy_, ax, ay, bx, by))


def capsule_gap(a, b):
    """Outline-to-outline distance between two capsules (negative = merged)."""
    (sa, ra), (sb, rb) = a, b
    return seg_gap(sa, sb) - ra - rb


# ---- outlines, vertex for vertex as the model draws them -----------------------
def squircle_poly(ax, ay, n=4, step=3):
    """body_2d(): polygon([for (t=[0:3:357]) ...]) — a 120-gon, not a curve.

    Measuring to the ideal superellipse would report a wall the print does not
    have: the polygon's chords fall inside the curve.
    """
    pts, t = [], 0.0
    while t <= 357 + 1e-9:
        c, s = math.cos(math.radians(t)), math.sin(math.radians(t))
        pts.append((ax * math.copysign(abs(c) ** (2 / n), c),
                    ay * math.copysign(abs(s) ** (2 / n), s)))
        t += step
    return pts


def round_rect_poly(w, h, r, step=5):
    """bay_2d(): hull of four circles — sampled on the true arcs (conservative:
    the model's $fn=48 circles are inscribed, so the real bay is a hair smaller
    and the real wall a hair thicker)."""
    pts = []
    for cx, cy, a0 in ((w/2-r, h/2-r, 0), (-(w/2-r), h/2-r, 90),
                       (-(w/2-r), -(h/2-r), 180), (w/2-r, -(h/2-r), 270)):
        a = a0
        while a <= a0 + 90 + 1e-9:
            pts.append((cx + r*math.cos(math.radians(a)),
                        cy + r*math.sin(math.radians(a))))
            a += step
    return pts


def body_poly(v):
    """body_2d(): the one outline the tray, the door and the cover all share.

    With the cord slot the body is a TALLER superellipse shifted +Y (body_ay2,
    body_cy) — the extra material above the internal void is what the bore is
    cut out of. With the v2.x ring it is the plain (body_ax, body_ay) one.
    Anything measuring a wall against the outside of the case has to come
    through here, or it measures a shape the model no longer makes.
    """
    if v["slot"]:
        return [(x, y + v["body_cy"])
                for x, y in squircle_poly(v["body_ax"], v["body_ay2"])]
    return squircle_poly(v["body_ax"], v["body_ay"])


def body_x_at(v, y):
    """Half-width of the outline at a given y — the model's own body_x_at()."""
    ay, cy = (v["body_ay2"], v["body_cy"]) if v["slot"] else (v["body_ay"], 0.0)
    return v["body_ax"] * max(0.0, 1 - (abs(y - cy) / ay) ** 4) ** 0.25


def capsule_poly(cap, step=5):
    """A capsule as a closed polygon: the two end arcs plus the flanks."""
    (ax, ay, bx, by), r = cap
    ang = math.degrees(math.atan2(by - ay, bx - ax))
    pts = []
    for cx, cy, a0 in ((bx, by, ang - 90), (ax, ay, ang + 90)):
        a = a0
        while a <= a0 + 180 + 1e-9:
            pts.append((cx + r * math.cos(math.radians(a)),
                        cy + r * math.sin(math.radians(a))))
            a += step
    return pts


def slot_capsule(v, grow=0.0):
    """cord_slot(): a slot_w x slot_t stadium, as (centre segment, radius).

    `grow` is the chamfer — the bore flares by slot_ch at BOTH faces, so the
    widest the hole ever gets is grow=slot_ch, and that is the section every
    wall around it has to be measured at.
    """
    half = max(0.0, (v["slot_w"] - v["slot_t"]) / 2)
    ymid = (v["slot_y0"] + v["slot_y1"]) / 2
    return (-half, ymid, half, ymid), v["slot_t"] / 2 + grow


def rect_poly(x0, x1, y0, y1, step=0.5):
    pts = []
    for a, b, horiz in ((x0, x1, True), (y0, y1, False)):
        t = a
        while t <= b + 1e-9:
            pts += ([(t, y0), (t, y1)] if horiz else [(x0, t), (x1, t)])
            t += step
    return pts


def poly_gap(pts, poly):
    """Smallest distance from any of `pts` to the closed polygon `poly`."""
    best = float("inf")
    for px, py in pts:
        for i, (ax, ay) in enumerate(poly):
            bx, by = poly[(i + 1) % len(poly)]
            dx, dy = bx - ax, by - ay
            L = dx*dx + dy*dy
            t = 0.0 if L == 0 else max(0.0, min(1.0, ((px-ax)*dx + (py-ay)*dy) / L))
            best = min(best, math.hypot(px - (ax + t*dx), py - (ay + t*dy)))
    return best


def skirt(depth, pcb_top):
    return min(4.0, depth - DOOR_T - pcb_top - 0.35)


def check(name, b):
    fails, notes = [], []
    depth, float_pm = b["depth"], b["float_pm"]
    v = scad_values(**b["defines"])

    # 0. the mirrored constants above must still be what the model uses.
    for key, mine in (("depth", depth), ("cav_h", b["cav_h"]), ("cav", CAV),
                      ("below", BELOW), ("door_t", DOOR_T), ("ledge", LEDGE),
                      ("pcb_xy", PCB_XY)):
        (notes if abs(v[key] - mine) < 1e-9 else fails).append(
            f"{key}: model says {v[key]:g}, checker says {mine:g}"
            + ("" if abs(v[key] - mine) < 1e-9 else "  <-- DRIFT, every check below is suspect"))
    cav_z0 = v["cav_z0"]              # per case: 1.3 slim, 7.0 over the battery
    pcb_top = cav_z0 + BELOW + PCB_T

    # 1. the board physically fits the cavity, floor to lid
    need = b["deepest"] + PCB_T + b["tallest"]
    have = depth - DOOR_T - cav_z0
    (notes if need <= have else fails).append(
        f"internal stack: needs {need:.2f}mm, has {have:.2f}mm "
        f"({'clears by %.2f' % (have - need) if need <= have else 'SHORT by %.2f' % (need - have)})")

    # 2. whatever carries the chain must not eat a part it does not own.
    if v["slot"]:
        fails += (f2 := check_slot(v))[0]
        notes += f2[1]
    else:
        # The v2.x torus: it is unioned on unclipped, so what matters is not the
        # case's total depth but the band between the tray's own floor (0, or the
        # top of the cover's rim on the battery case) and the door plane — and the
        # torus is only 2*sqrt(r^2 - dy^2) tall where it meets the body, not 2r.
        # Measured by boolean on the old numbers: the Voice's ring overlapped its
        # door by 0.3765mm^3 while an r <= depth/2 test passed it.
        dy = v["bail_y"] - v["body_ay"]
        hy = math.sqrt(max(0.0, v["bail_r"]**2 - dy**2))
        band_lo = v["cover_h"] + v["cover_lip"] if b.get("battery") else 0.0
        band_hi = depth - DOOR_T
        lo, hi = v["bail_z"] - hy, v["bail_z"] + hy
        ok = lo >= band_lo - 1e-9 and hi <= band_hi + 1e-9
        (notes if ok else fails).append(
            f"bail r {v['bail_r']:.2f} stood off {dy:.2f}: crosses the body over z "
            f"{lo:.3f}..{hi:.3f}, tray owns {band_lo:.2f}..{band_hi:.2f} "
            f"(margins {lo-band_lo:+.3f} / {band_hi-hi:+.3f})"
            + ("" if ok else "  <-- COLLIDES WITH THE DOOR / THE COVER"))

    # 2b. THE CORNERS. Four r0.5 "corner reliefs" stood at (+/-cav/2, +/-cav/2)
    # from v1, when the cavity was square and a square PCB corner needed room.
    # Against the r2-rounded cavity they were sealed voids touching nothing —
    # 0.328mm clear of the cavity, 0.258mm (0.6 extrusions) from the outside
    # world — so the slicer drew no wall at all and all four corners printed open
    # (user, 2026-08-02: "there are some corners of the case, they must be closed
    # smooth surface"). They are gone. What replaces them is not a promise but
    # this measurement, which any new void near a corner has to survive too.
    corner = poly_gap(round_rect_poly(CAV, CAV, 2.0), body_poly(v))
    (notes if corner >= 2 * NOZZLE else fails).append(
        f"cavity to outside at the corner: {corner:.3f}mm "
        f"({corner/NOZZLE:.1f} extrusions), thinnest point of the whole shell"
        + ("" if corner >= 2 * NOZZLE else "  <-- OPEN CORNER: the slicer cannot draw this"))
    pcb_corner = 2.0 - math.hypot(PCB_XY/2 - (CAV/2 - 2.0), PCB_XY/2 - (CAV/2 - 2.0))
    (notes if pcb_corner >= 0 else fails).append(
        f"PCB corner inside the cavity's r2 arc by {pcb_corner:.3f}mm — "
        "which is why no corner relief is needed"
        + ("" if pcb_corner >= 0 else "  <-- THE BOARD'S CORNERS FOUL THE CAVITY"))

    # 3. the door skirt must stop above the seated PCB
    sk = skirt(depth, pcb_top)
    sb = depth - DOOR_T - sk
    (notes if sb >= pcb_top else fails).append(
        f"skirt bottom {sb:.2f} vs PCB top {pcb_top:.2f}"
        + ("" if sb >= pcb_top else f"  <-- CRUSHES BOARD by {pcb_top-sb:.2f}"))
    if sb >= pcb_top and sk < 2.0:
        fails.append(f"skirt only {sk:.2f}mm — too short to snap reliably")
    (notes if abs(v["skirt_h"] - sk) < 1e-9 else fails).append(
        f"skirt_h: model says {v['skirt_h']:g}, checker says {sk:g}"
        + ("" if abs(v["skirt_h"] - sk) < 1e-9 else "  <-- DRIFT"))

    # 4. every port must line up with its part at the worst board position
    for pname, hx, hy, hole, pw, ph, mode in b["ports"]:
        px, py = PART_AT.get((name, pname), (hx, hy))
        hw, hh = hole if isinstance(hole, tuple) else (hole, hole)
        worst = None
        for dx in (-float_pm, 0, float_pm):
            for dy in (-float_pm, 0, float_pm):
                ox, oy = px + dx - hx, py + dy - hy   # part centre vs hole centre
                if mode == "cover":
                    # every corner of the part must fall inside the hole outline
                    slack = min(hw / 2 - (abs(ox) + pw / 2), hh / 2 - (abs(oy) + ph / 2))
                else:
                    # the whole hole must fall inside the part outline
                    slack = min(pw / 2 - (abs(ox) + hw / 2), ph / 2 - (abs(oy) + hh / 2))
                worst = slack if worst is None else min(worst, slack)
        verb = "covers" if mode == "cover" else "lands on"
        (notes if worst >= 0 else fails).append(
            f"{pname} {verb} its part with {worst:+.2f}mm to spare"
            + ("" if worst >= 0 else "  <-- MISALIGNED"))

    # 5. ports must not merge into each other (>=2 extrusions of wall).
    #
    # The first version of this took max(gap_x, gap_y) — "separated if either
    # axis clears" — and that is simply wrong for holes set on a diagonal. It
    # failed the Voice LED/reset pair at 0.26mm when the real wall between
    # those two circles is 1.31mm. Every port here is a circle or a stadium,
    # i.e. a capsule, so the true wall is the distance between their centre
    # segments minus both radii. That is exact, not an approximation.
    for i, a in enumerate(b["ports"]):
        for c in b["ports"][i + 1:]:
            wall = capsule_gap(port_capsule(a), port_capsule(c))
            (notes if wall >= 2 * NOZZLE else fails).append(
                f"{a[0]} <-> {c[0]}: {wall:.2f}mm wall "
                f"({wall/NOZZLE:.1f} extrusions)"
                + ("" if wall >= 2 * NOZZLE else "  <-- MERGE / SUB-EXTRUSION WALL"))

    # 6. ribs locate the board tightly enough for the ports above
    notes.append(f"board located to +/-{float_pm:.2f} by ribs "
                 f"(cavity alone would allow +/-{(CAV-PCB_XY)/2:.2f})")

    # 7. the accent inlay is per-case too: the mark sits on the body's own
    #    outline (and, since v2.8, on the same face as the cord bore).
    f2, n2 = check_logo(v)
    fails += f2
    notes += n2

    if b.get("battery"):
        f2, n2 = check_battery(v)
        fails += f2
        notes += n2
    return fails, notes


# ---- the cord slot (bail_style="slot") -----------------------------------------
def check_slot(v):
    """The bail is now a hole, so it is checked as walls, not as a solid.

    v2.8 replaced the protruding torus with a bore through the body itself
    (user: "instead of using the top circle, we can leave a space on the top of
    the case"). That trades one class of failure for another: a ring can only
    collide with the door, but a hole can be too near the outside, too near the
    board's own void, or too thin in the one place the whole pendant hangs from.

    All three walls are measured at the CHAMFERED section. The bore flares
    slot_ch at each face, so the thinnest wall is never the nominal one — and
    the faces are exactly where a thin wall shows.
    """
    fails, notes = [], []

    def gate(cond, msg, why=""):
        (notes if cond else fails).append(msg + ("" if cond else "  <-- " + why))

    ch = v["slot_ch"]
    # 1. the bar the whole pendant hangs from. It is a VERTICAL wall in the
    #    print (the bore's axis is the print's Z), so this is extrusions of
    #    perimeter, not a bridge — the ring's overhang is what got the plate its
    #    "floating regions" notice and the bar has none.
    bar = v["bar_t"] - ch
    gate(bar >= 3 * NOZZLE,
         f"bar above the cord slot: {v['bar_t']:.2f}mm, {bar:.2f}mm at the "
         f"chamfered face ({bar/NOZZLE:.1f} extrusions), "
         f"{bar*v['depth']:.1f}mm^2 in section carrying the pendant",
         "THE PENDANT HANGS FROM THIS — under 3 extrusions it snaps")
    # 2. between the bore and the board's own space. Numeric against the real
    #    cavity outline, not slot_y0 - cav/2: the slot is 12mm wide and the
    #    cavity's top edge curves away at r2, so where they are closest is a
    #    question about two shapes, not two numbers.
    bore = capsule_poly(slot_capsule(v, ch))
    voids = [("board cavity", round_rect_poly(CAV, CAV, 2.0),
              "THE CORD WOULD RUB THE BOARD / open into the cavity")]
    if v["bat"]:
        voids.append(("cell bay",
                      round_rect_poly(v["bay_x"], v["bay_y"], v["bay_r"]),
                      "THE CORD WOULD PRESS ON A LIPO POUCH"))
    # void_top — and therefore slot_wall — is measured to whichever of these
    # reaches highest in +Y, so only that one is the wall the model placed.
    top = voids[-1][0] if v["bat"] else voids[0][0]
    for what, poly, why in voids:
        g = poly_gap(bore, poly)
        gate(g >= 2 * NOZZLE,
             f"cord bore to the {what}: {g:.2f}mm ({g/NOZZLE:.1f} extrusions)"
             + (f", the {v['slot_wall']:g}mm slot_wall less the {ch:g} chamfer"
                if what == top else ""), why)
    # 3. to the outside. This is the measurement the model's assert cannot make:
    #    it compares against the ideal superellipse, and the printed outline is
    #    a 120-gon whose chords fall inside that curve.
    shell = poly_gap(bore, body_poly(v))
    gate(shell >= 2 * NOZZLE,
         f"cord bore to the outside of the pendant: {shell:.2f}mm at its "
         f"thinnest ({shell/NOZZLE:.1f} extrusions)",
         "THE SLOT BREAKS OUT THROUGH THE SIDE")
    flank = body_x_at(v, v["slot_y1"]) - (v["slot_w"] / 2 + ch)
    gate(flank >= 2 * NOZZLE,
         f"flank at the slot's top edge (y {v['slot_y1']:g}, where the outline "
         f"has already curved in to {body_x_at(v, v['slot_y1']):.2f}): {flank:.2f}mm",
         "THE SLOT IS WIDER THAN THE SHOULDER IT SITS IN")
    # 4. it has to take a cord. 3.0mm leather / a 3.4mm chain link, and the
    #    stadium's ends are round so nothing has to turn a square corner.
    gate(v["slot_t"] >= 3.0,
         f"opening {v['slot_w']:g} x {v['slot_t']:g}mm "
         f"({v['slot_t']+2*ch:.1f} at the faces): passes a {v['cord_d']:g} cord "
         f"— check_cord() is what says whether a thing can ATTACH",
         "TOO TIGHT FOR THE CORD IT EXISTS FOR")
    notes.append(f"pendant {2*v['body_ax']:.1f} x "
                 f"{v['head_top']-(v['body_cy']-v['body_ay2']):.1f} x "
                 f"{v['depth']:.1f}mm overall — no part sticks out of the outline")
    f2, n2 = check_cord(v)
    return fails + f2, notes + n2


# ---- what the window is worn on ------------------------------------------------
LAB = "tiny_necklace_lab.scad"


HERO = "tiny_full_necklace.scad"
HEAD_CIRC = 570.0                     # 50th-percentile adult head, mm


def file_num(fname, name):
    """One top-level constant, read out of another .scad rather than copied here.

    The chain lives in tiny_necklace_lab.scad and the bail lives in the split
    file, so the question "does that link fit this bar" spans two sources. A
    mirrored copy of link_od here could go stale in exactly the way that let a
    22mm^3 interference sit in the hero render for a day, so it is grepped.

    Only plain literals match, which is why the files being read keep the
    numbers this checker needs as literals instead of expressions.
    """
    src = open(os.path.join(CAD_DIR, fname)).read()
    m = re.search(rf"^{name}\s*=\s*([\d.]+)\s*;", src, re.M)
    return float(m.group(1)) if m else None


def lab_num(name):
    return file_num(LAB, name)


def check_cord(v):
    """The bail is a WINDOW, so check what can pass through it and around it.

    Every earlier bail check asked whether the bail collided with a part of the
    case. None of them asked the only question a wearer has: what hangs on it.
    The answer is not free — the cord goes down through the window and up over
    the crown, wrapping a bar of bar_t x depth section, and that section is what
    sets the smallest rigid ring that can ever attach. The print-in-place chain
    fails it by 5mm of inner diameter, which is why it is measured here and not
    left to a render.
    """
    fails, notes = [], []

    def gate(cond, msg, why=""):
        (notes if cond else fails).append(msg + ("" if cond else "  <-- " + why))

    # 1. the wrap. The cord makes one pass through the window and one over the
    #    crown, so what it encircles is the bar's own section.
    bar_y = v["bar_t"] - (v["seat_d"] if v["cord_seat"] else 0.0)
    diag = math.hypot(bar_y, v["depth"])
    notes.append(f"the cord wraps a bar of {bar_y:g} x {v['depth']:g}mm: "
                 f"{2*(bar_y+v['depth']):.1f}mm of inner loop for a "
                 f"{v['cord_d']:g}mm cord ({2*(bar_y+v['depth'])/v['cord_d']:.1f}x "
                 f"its diameter — it bends, it does not kink)")
    # 2. and the one thing that CANNOT attach, stated as a number. A rigid closed
    #    link has to slip over that section, i.e. clear its diagonal.
    od, sec = lab_num("link_od"), lab_num("link_sec")
    if od is None or sec is None:
        fails.append(f"cannot read link_od/link_sec from {LAB} — the chain's "
                     "fit against this bail is unverifiable")
    else:
        link_id = od - 2 * sec
        gate(link_id < diag,
             f"the print-in-place chain does NOT thread this window, as designed: "
             f"link ID {link_id:g} vs the {diag:.2f}mm diagonal it would have to "
             f"clear (boolean: 22.0mm^3 of interference). Use a cord, or thread a "
             f"bought chain by its end",
             "THE CHAIN NOW FITS — the hero render and the docs both say it cannot")
        # Units on both figures, because this sentence is the one that gets copied
        # into PRINTS.md and from there onto the landing page — and the page's
        # number checker will only accept a length from prose that spells its unit
        # (bare lengths are conceded to the scad alone, which is dimensionally
        # typed by convention). Emitted unitless, "OD >= 17.0" reached the page as
        # "17.0 mm" and was reported UNSOURCED against the source that stated it.
        notes.append(f"a printed link that WOULD attach needs ID >= {diag:.2f}mm, "
                     f"i.e. OD >= {diag + 2*sec:.1f}mm at the same {sec:g}mm section — "
                     f"{(diag + 2*sec)/od:.2f}x the current link, which is why the "
                     f"wrap is the answer and not a bigger chain")
    # 3. the window has to pass the cord it is dimensioned for.
    slack = v["slot_t"] - v["cord_d"]
    gate(slack >= 0.3,
         f"window passes the cord: {v['slot_t']:g} - {v['cord_d']:g} = "
         f"{slack:.1f}mm of slack ({v['slot_t']+2*v['slot_ch']:.1f} at the "
         f"chamfered mouth)", "THE CORD DOES NOT GO THROUGH ITS OWN BAIL")
    # 4. the crown seat. It is cut INTO the bar, so it is checked against the bar
    #    it takes from and against the cord it is cut for — and the second one is
    #    an upper bound, which is the part that is easy to get backwards: a groove
    #    WIDER than the cord does not capture it, it just lets it wander.
    if v["cord_seat"]:
        left = v["bar_t"] - v["seat_d"]
        gate(left >= 3 * NOZZLE,
             f"crown seat {v['seat_d']:g} deep leaves {left:.2f}mm of bar "
             f"({left/NOZZLE:.1f} extrusions), {left*v['depth']:.1f}mm^2 of "
             f"section vs {v['bar_t']*v['depth']:.1f} unseated",
             "THE SEAT HAS EATEN THE BAR THE PENDANT HANGS FROM")
        gate(v["seat_w"] < v["cord_d"],
             f"seat mouth {v['seat_w']:.2f}mm is narrower than the "
             f"{v['cord_d']:g}mm cord, so the cord sits {v['seat_d']:g}mm down "
             f"and {v['cord_d']-v['seat_d']:.1f} proud instead of dropping into a "
             f"slot: the pendant hangs on the cord's own line",
             "MOUTH WIDER THAN THE CORD — it locates nothing")
        # The mouth is 0.12mm narrower than the cord, and for a long time this
        # file said that meant the cord "snaps in and is captured". It does not.
        # seat_r = cord_d/2 + 0.1 puts the arc's centre seat_r - seat_d = 0.70mm
        # OUTSIDE the crown, so the void is WIDEST at the mouth and narrows all
        # the way down: there is no undercut anywhere, and a cord never has to
        # pass its own diameter through the mouth — only the width of its own
        # section at that height. So it drops in, lifts straight out, and what
        # the seat gives is a locator, not a catch. What holds the loop closed is
        # the bead. Measured rather than argued, below.
        rest = (v["seat_r"] - v["seat_d"]) - (v["seat_r"] - v["cord_d"] / 2)
        clear = math.hypot(v["seat_w"] / 2, rest) - v["cord_d"] / 2
        gate(clear >= 0,
             f"and the cord clears both mouth corners by {clear:.3f}mm on its way "
             f"to the bottom (centre resting {rest:+.2f}mm above the crown), so it "
             f"seats by hand with no undercut to force and no tool",
             "THE CORD MUST BE FORCED PAST THE MOUTH — it would have to deform "
             "to reach a groove that is supposed to cradle it")
        gate(v["cord_d"] - v["seat_w"] <= 0.5,
             f"the mouth is only {v['cord_d']-v['seat_w']:.2f}mm narrower than the "
             f"cord, i.e. the groove bites deep enough to cradle it (seat "
             f"r{v['seat_r']:g} against cord r{v['cord_d']/2:g}: the cord nests on "
             f"the arc, it does not wedge on two edges)",
             "TOO SHALLOW A BITE — the cord would perch on the mouth instead of "
             "nesting in the arc")
        # it must not reach the window below it, or the bar becomes two legs
        gate(v["head_top"] - v["seat_d"] > v["slot_y1"],
             f"seat floor at y {v['head_top']-v['seat_d']:g}, window top at "
             f"{v['slot_y1']:g} — {v['head_top']-v['seat_d']-v['slot_y1']:.2f}mm apart",
             "THE SEAT HAS BROKEN THROUGH INTO THE WINDOW")

    # 5. the slider, at the section where its two chamfers meet. Both the bore's
    #    lead-in and the bead's end chamfer eat the same wall at z=0, and at
    #    slider_wall 1.2 that pair broke out through the side of the bead.
    ax, ay, ech, ch = v["slider_ax"], v["slider_ay"], v["slider_ech"], v["slider_ch"]
    outline = squircle_poly(ax - ech, ay - ech)
    for bore in [v["slider_bmax"] - 0.2 + 0.1*i for i in range(3)]:
        cx = (bore + v["slider_web"]) / 2
        mouth = [(cx + (bore/2 + ch) * math.cos(math.radians(a)),
                  (bore/2 + ch) * math.sin(math.radians(a)))
                 for a in range(0, 360, 5)]
        wall = poly_gap(mouth, outline)
        web = (2 * cx) - bore - 2 * ch             # bore mouth to bore mouth
        worst = min(wall, web)
        gate(worst >= 2 * NOZZLE,
             f"slider bore {bore:g}: {wall:.2f}mm to the outside and {web:.2f}mm "
             f"of web at the chamfered mouth ({worst/NOZZLE:.1f} extrusions), "
             f"grip = {v['cord_d']-bore:+.1f}mm on the cord",
             "THE BORE MOUTH BREAKS OUT OF THE BEAD")
    notes.append(f"slider {2*ax:.1f} x {2*ay:.1f} x {v['slider_len']:g}mm, bores "
                 f"on Z so it prints flat with no overhang; three grips "
                 f"({v['slider_bmax']-0.2:g}/{v['slider_bmax']-0.1:g}/"
                 f"{v['slider_bmax']:g}) on one plate because friction is not "
                 f"arithmetic")
    return fails, notes


# ---- the hero render, checked as geometry ---------------------------------------
def check_hero_numbers():
    """The six numbers tiny_full_necklace.scad has to restate, re-derived.

    `use` imports modules and no variables, so the hero render carries its own
    copy of where the cord sits. That copy is how the render came to show a chain
    threaded through a window it cannot enter: nothing connected the drawing to
    the model. Each literal is checked against the rule it came from, so moving
    slot_y1 or seat_d breaks the render loudly instead of silently.
    """
    fails, notes = [], []

    def gate(cond, msg, why=""):
        (notes if cond else fails).append(msg + ("" if cond else "  <-- " + why))

    v = scad_values()                     # the file's own defaults: what it draws
    seat_d = v["seat_d"] if v["cord_seat"] else 0.0
    want = {
        "cord":    (v["cord_d"], "the cord the bail is dimensioned for"),
        "face_z":  (v["depth"], "the front face it runs across"),
        "win_y":   (v["slot_y1"] - v["cord_d"] / 2,
                    "centre of a cord hanging off the bar's underside"),
        "seat_y":  (v["head_top"] - seat_d + v["cord_d"] / 2,
                    "centre of a cord nested in the crown seat"),
        "sl_bore": (v["slider_bore"], "the slider's bore, which sets the leg spacing"),
        "sl_web":  (v["slider_web"], "the web between its two bores"),
        "sl_len":  (v["slider_len"], "how far the legs run inside it"),
    }
    for name, (should, what) in want.items():
        got = file_num(HERO, name)
        if got is None:
            fails.append(f"{HERO}: no literal `{name}=` to check — the render's "
                         f"cord is no longer tied to the model")
            continue
        gate(abs(got - should) < 1e-9,
             f"{HERO} {name} = {got:g}, model says {should:g} ({what})",
             "DRIFT: the render draws a cord that does not match the pendant")

    # and the two lengths, measured off the drawn path by the render itself.
    h = hero_echo()
    if h is None:
        fails.append(f"{HERO} printed no HERO echo — the cord's length is "
                     "unmeasured, so the shopping list is a guess")
        return fails, notes
    gate(400 <= h["loop"] <= 480,
         f"worn loop {h['loop']/10:.1f}cm at the bead's drawn position "
         f"({h['neck_h']:g}mm up) — a {2*v['body_ax']:.0f}mm pendant sits on the "
         f"collarbone at 42-48",
         "THE HERO SHOWS AN UNWEARABLE LENGTH (a choker, or past the sternum)")
    # The one constraint a render cannot show: no clasp means the longest setting
    # has to clear a head, and the longest setting is the WHOLE cord, because
    # sliding the bead up puts all of both tails into the loop.
    gate(h["cord"] >= HEAD_CIRC,
         f"cord to buy: {h['cord']/10:.1f}cm of {h['cord_d']:g}mm cord — "
         f"{(h['cord']-h['loop'])/2:.0f}mm of tail each side, so the loop opens "
         f"to {h['cord']/10:.1f}cm, past a {HEAD_CIRC/10:g}cm head",
         f"CANNOT BE PUT ON: it has no clasp and opens to only "
         f"{h['cord']/10:.1f}cm")
    return fails, notes


def hero_echo():
    """The lengths the hero render measures off its own path.

    Re-deriving a Bezier's arc length in this file would be the mirrored-constant
    mistake with extra steps: it would check a curve, not THE curve. The .scad
    sums the path it actually draws and echoes it; this only reads it.
    """
    cmd = ["openscad", "--export-format", "echo"]
    with tempfile.NamedTemporaryFile(suffix=".echo") as tmp:
        cmd += ["-o", tmp.name, os.path.join(CAD_DIR, HERO)]
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            return None
        out = open(tmp.name).read()
    m = re.search(r'ECHO: "HERO (.*)"', out)
    if not m:
        return None
    return {k: float(v) for k, v in (p.split("=") for p in m.group(1).split())}


def _scad_volume(body, label):
    """mm^3 of one expression built out of the hero file. 0 if it builds nothing.

    Empty output is not an error here — it is the answer for the clash — but it
    IS an error for either half, so both are measured and the caller decides.
    """
    from check_slice import stl_volume          # the repo's own reader, not a copy
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, f"{label}.scad")
        stl = os.path.join(d, f"{label}.stl")
        with open(src, "w") as f:
            f.write(f"use <{os.path.join(CAD_DIR, HERO)}>\n{body}\n")
        r = subprocess.run(["openscad", "-o", stl, src],
                           capture_output=True, text=True, timeout=900)
        if not os.path.exists(stl) or os.path.getsize(stl) < 100:
            if "empty" not in (r.stderr + r.stdout).lower() and r.returncode:
                raise RuntimeError(f"openscad failed on {label}: "
                                   f"{r.stderr.strip()[-200:]}")
            return 0.0
        return stl_volume(stl)


def check_hero_clash():
    """Can the assembly in the hero render be assembled? Measured, not looked at.

    A render is not evidence. Two separate things hid in this one: the chain that
    overlapped the case by 22.0mm^3, and — for a whole session — a window that
    LOOKED filled in because PNG export without --render uses OpenCSG, which
    silently drops a subtraction once the CSG nests deeply enough. Both are the
    same lesson: intersect the solids and read the number.

    Slow (a CGAL boolean over the cord's ~600 hulled spheres), so it is opt-in.
    """
    fails, notes = [], []

    def gate(cond, msg, why=""):
        (notes if cond else fails).append(msg + ("" if cond else "  <-- " + why))

    try:
        case = _scad_volume("hero_case();", "case")
        cord = _scad_volume("hero_cord();", "cord")
        clash = _scad_volume("intersection(){ hero_cord(); hero_case(); }", "clash")
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        return [f"cannot measure the hero render: {e}"], notes

    # an empty intersection is also what two empty halves produce. Check them
    # first, or this whole function is a test that cannot fail.
    for what, vol in (("hero_case()", case), ("hero_cord()", cord)):
        gate(vol > 100.0, f"{what} builds {vol/1000:.2f}cm^3",
             "BUILDS (ALMOST) NOTHING — the clash check below would pass vacuously")
    gate(clash < 0.05,
         f"cord vs case: {clash:.3f}mm^3 of overlap — the cord goes where the "
         f"render says it goes (through the window, over the seat, into the slider)",
         f"THE RENDER SHOWS AN ASSEMBLY NOBODY CAN ASSEMBLE: {clash:.1f}mm^3 "
         f"of solid-on-solid interference")
    return fails, notes


# ---- the battery locket (bat=true) ---------------------------------------------
def check_battery(v):
    """The third part, the cell it holds, and the wire route to J4.

    Nothing here is about the board — check() covers that, and the board is the
    same board. These are the invariants that only exist because there is now a
    4mm pouch cell under the PCB and a 26x35.8 bay in a 31.6x41.9 pendant.
    """
    fails, notes = [], []

    def gate(cond, msg, why=""):
        (notes if cond else fails).append(msg + ("" if cond else "  <-- " + why))

    # 1. the cell fits its bay, with room to swell (a pouch grows with cycles)
    for axis, slack, need in (("x", v["bay_x"] - v["cell_x"], 0.6),
                              ("y", v["bay_y"] - v["cell_y"], 0.6),
                              ("z", v["bay_z"] - v["cell_t"], 0.4)):
        gate(slack >= need, f"cell {axis}: {slack:.2f}mm of bay clearance "
             f"(need {need:.2f} for swell + print tolerance)",
             "CELL WILL NOT SEAT / no room to swell")

    # 1b. ...and its CORNERS fit, which is a different question. The bay is a
    # rounded rect and the pouch is not: at bay_r 3.0 every bounding-box
    # clearance above passed while the cell overlapped the bay by 0.607mm
    # radially at each corner — 6mm^3, confirmed by boolean. The radius is
    # therefore bounded ABOVE by the cell, not below by the wall.
    r = v["bay_r"]
    dx, dy = r - (v["bay_x"] - v["cell_x"]) / 2, r - (v["bay_y"] - v["cell_y"]) / 2
    corner = r - math.hypot(max(0.0, dx), max(0.0, dy))
    gate(corner >= 0.05,
         f"cell corner vs the bay's r{r:g} arc: {corner:+.3f}mm "
         f"(r must stay under ~{r-corner+0.001:.2f} at these slacks)",
         "THE POUCH'S CORNERS FOUL THE BAY — it cannot be seated")

    # 2. the bay must not eat the shell. Numeric, because both outlines are
    #    curved and the thinnest point is neither at a corner nor on an axis.
    wall = poly_gap(round_rect_poly(v["bay_x"], v["bay_y"], v["bay_r"]),
                    body_poly(v))
    gate(wall >= 2 * NOZZLE,
         f"bay wall: {wall:.2f}mm at its thinnest ({wall/NOZZLE:.1f} extrusions) "
         f"from {v['bat_wall']:g}mm of shell",
         "SUB-EXTRUSION SHELL — the slicer will drop it")

    # 3. the three z stacks have to close on each other
    stack = v["cover_t"] + v["bay_z"] + v["part_t"]
    gate(abs(stack - v["cav_z0"]) < 1e-9,
         f"cover floor {v['cover_t']:g} + bay {v['bay_z']:g} + partition "
         f"{v['part_t']:g} = {stack:g} = cavity floor {v['cav_z0']:g}",
         "THE PARTS DO NOT MEET — a gap or an overlap at the joint")
    gate(v["cover_h"] == v["cover_t"] + v["bay_z"],
         f"cover height {v['cover_h']:g} = floor + bay",
         "cover_h disagrees with its own contents")

    # 4. the partition is the only thing between a LiPo and the board
    lay = v["part_t"] / LAYER_H
    gate(v["part_t"] >= 1.0,
         f"partition {v['part_t']:.2f}mm = {lay:.1f} layers of solid between "
         "cell and PCB", "TOO THIN to trust over a pouch cell")

    # 5. the logo moved to the cover: it is debossed into a 1.2 floor
    left = v["cover_t"] - v["mark_z"]
    gate(left >= NOZZLE,
         f"cover floor behind the logo: {left:.2f}mm "
         f"({left/LAYER_H:.1f} layers) under the {v['mark_z']:g} deboss",
         "THE LOGO WOULD BREAK THROUGH INTO THE BAY")

    # 6. the rim/rabbet/snap arithmetic, all of it derived from one thickness
    gate(v["rab_t"] >= 2 * NOZZLE,
         f"cover rim {v['rab_t']:.2f}mm ({v['rab_t']/NOZZLE:.1f} extrusions)",
         "RIM TOO THIN TO PRINT")
    tray_wall = v["body_ax"] - (v["rab_t"] + v["rab_c"]) - v["cav"]/2
    gate(tray_wall >= 2 * NOZZLE,
         f"tray wall left by the rabbet: {tray_wall:.2f}mm "
         f"({tray_wall/NOZZLE:.1f} extrusions)",
         "THE RABBET CUTS INTO THE CAVITY")
    rim_face = v["body_ax"] - v["rab_t"]            # inner face of the cover's rim
    bump_tip = rim_face + 0.05 - v["snap_h"]        # bump centre is +0.05 outboard
    rab_face = v["body_ax"] - v["rab_t"] - v["rab_c"]   # what the bump rides over
    eng = rab_face - bump_tip
    gate(0.1 <= eng <= 0.35,
         f"snap engagement {eng:.2f}mm (bump tip {bump_tip:.2f} vs rabbet face "
         f"{rab_face:.2f}); {v['snap_len']:g}mm long",
         "NO CLICK (<0.1) or TOO STIFF TO CLOSE (>0.35)")
    socket_in = rab_face - 0.1 - (v["snap_h"] + 0.1)
    gate(socket_in <= bump_tip,
         f"socket reaches {socket_in:.2f}, bump tip {bump_tip:.2f} — "
         f"{bump_tip-socket_in:.2f}mm to spare at the bottom",
         "THE BUMP BOTTOMS OUT BEFORE THE RIM SEATS")
    gate(rim_face + 0.05 + v["snap_h"] <= v["body_ax"] - 0.3,
         f"bump outer face {rim_face+0.05+v['snap_h']:.2f} inside the body "
         f"{v['body_ax']:g}", "THE BUMP PROTRUDES THROUGH THE OUTSIDE WALL")

    # 7. the wire route. One prism does two jobs: a groove in solid wall
    #    outboard of the cavity, a through-port in the partition inboard of it.
    gate(v["chan_y0"] < v["cav"]/2,
         f"channel starts at y {v['chan_y0']:g}, inside the cavity edge "
         f"{v['cav']/2:g} — so it opens into the board bay",
         "THE CHANNEL IS A BLIND SLOT: no path to the board")
    gate(v["chan_y1"] >= v["bay_y"]/2,
         f"channel ends at y {v['chan_y1']:g}, past the cell's end "
         f"{v['bay_y']/2:g}", "the leads leave the bay under the cell, not over its end")
    gate(v["wire_x"] == (J4["x0"] + J4["x1"]) / 2,
         f"channel centred on {J4['name']} at x {v['wire_x']:g}",
         "THE CHANNEL DOES NOT POINT AT THE CONNECTOR")
    gate(v["wire_w"] >= (J4["x1"] - J4["x0"]),
         f"channel {v['wire_w']:g}mm wide vs the connector's "
         f"{J4['x1']-J4['x0']:.2f}mm", "narrower than the plug it feeds")
    gate(v["chan_h"] >= WIRE_OD,
         f"channel {v['chan_h']:g}mm tall for {WIRE_OD:.2f}mm of lead",
         "THE LEADS DO NOT FIT")
    # the board's seat must not be undermined by the channel's roof
    seat = v["cav_z0"] + BELOW - (v["cover_h"] + v["chan_h"])
    gate(seat >= 2 * NOZZLE,
         f"material under the PCB seat above the channel: {seat:.2f}mm "
         f"({seat/NOZZLE:.1f} extrusions)",
         "THE CHANNEL UNDERCUTS THE LEDGE THE BOARD SITS ON")
    # ... and the channel must not surface through the outside of the pendant
    cw = poly_gap(rect_poly(v["wire_x"] - v["wire_w"]/2, v["wire_x"] + v["wire_w"]/2,
                            v["chan_y0"], v["chan_y1"]),
                  body_poly(v))
    gate(cw >= 2 * NOZZLE,
         f"channel to outside wall: {cw:.2f}mm at its thinnest "
         f"({cw/NOZZLE:.1f} extrusions)", "THE CHANNEL BREAKS OUT OF THE SHELL")
    notes.append(f"channel roof is a {v['wire_w']:g}mm bridge — under the 10mm "
                 "this profile prints unsupported")

    # 8. the plug costs no depth: this is why the approved plug well was dropped
    room = BELOW - J4["deep"]
    gate(J4["deep"] + WIRE_OD <= BELOW,
         f"{J4['name']} hangs {J4['deep']:.2f} into the {BELOW:g}mm below-PCB "
         f"gap the ESLOV already forces — {room:.2f}mm left for the leads",
         "THE MATED PLUG DOES NOT FIT UNDER THE BOARD")

    # 9. the ring dips below the cover's rim, but only out in free air.
    #    Nothing to say once the bail is a slot: it is inside the body, and
    #    check_slot owns it (both of these read as contradictions if printed
    #    anyway — they describe a part the plate no longer has).
    if not v["slot"]:
        dip, rim = v["bail_z"] - v["bail_r"], v["cover_h"] + v["cover_lip"]
        if dip < rim:
            notes.append(
                f"bail's lowest point z {dip:.2f} is {rim-dip:.2f} below the "
                f"cover, but at y {v['bail_y']:g} — {v['bail_y']-v['body_ay']:.2f}mm "
                "outboard of the body, so it passes in air (check 2 covers the crossing)")
        notes.append(f"pendant {2*v['body_ax']:.1f} x {2*v['body_ay']:.1f} x "
                     f"{v['depth']:.1f}mm, {v['bail_y']+v['bail_r']+v['body_ay']:.1f}mm "
                     "tip to tip with the bail")
    return fails, notes


def mark_rings():
    """The 7 ring centres, in the SVG's own viewBox units, parsed out of the
    .scad's own `mark_rings` list.

    Not restated here on purpose. A checker carrying its own copy of the artwork
    proves that SOME mark is printable, which is worth nothing if the one being
    sliced is a different one.
    """
    src = open(os.path.join(CAD_DIR, SCAD)).read()
    m = re.search(r"^mark_rings\s*=\s*(\[.*?\])\s*;", src, re.S | re.M)
    if not m:
        raise RuntimeError(f"{SCAD}: no `mark_rings` list to check")
    return [(float(x), float(y)) for x, y in
            re.findall(r"\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]", m.group(1))]


def check_logo(v):
    """The 7-ring mark, as an inlay: every accent feature >= 2 extrusions.

    v2.8 replaced the halo + "tiny" wordmark with the supplied 7-ring mark. It
    is drawn from ONE scale factor, ms = mark_w / mark_svg_w, so the whole check
    is: what do the SVG's stroke and its ring spacing become at that scale, and
    does the result still land inside the face it is inlaid into.

    Two of these can only be got wrong at this scale: the RING GAP has to be
    measured after the pocket's mark_clr offset eats it from both sides, and the
    mark now shares its face with the cord bore.
    """
    fails, notes = [], []

    def gate(cond, msg, why=""):
        (notes if cond else fails).append(msg + ("" if cond else "  <-- " + why))

    ms = v["mark_w"] / v["mark_svg_w"]
    r_out = (v["mark_ring_r"] + v["mark_stroke"] / 2) * ms
    r_in = (v["mark_ring_r"] - v["mark_stroke"] / 2) * ms
    rings = [((x - v["mark_svg_w"] / 2) * ms,
              (v["mark_svg_h"] / 2 - y) * ms + v["mark_cy"]) for x, y in mark_rings()]
    gate(len(rings) == 7, f"{len(rings)} rings at ms={ms:.5f} "
         f"({v['mark_w']:g}mm wide from a {v['mark_svg_w']:g}-unit viewBox)",
         "THE MARK IS NOT THE ONE THAT WAS SUPPLIED")

    stroke = v["mark_stroke"] * ms
    gate(stroke >= 2 * NOZZLE,
         f"ring stroke: {stroke:.2f}mm = {stroke/NOZZLE:.1f} extrusions "
         f"(the whole mark is stroke — nothing else to fall back on)",
         "TOO THIN, WILL SLICE AS DASHES")
    gate(2 * r_in >= 2 * NOZZLE,
         f"black island inside each ring: {2*r_in:.2f}mm across "
         f"({2*r_in/NOZZLE:.1f} extrusions)",
         "THE RINGS FILL IN AND THE MARK READS AS 7 DOTS")

    # ring to ring, AFTER the pocket offset. The insert is the artwork; the
    # pocket is offset(mark_clr) OUTWARD from it, so the black web between two
    # rings loses mark_clr from each side. 2*mark_clr is 0.24mm of the gap.
    near = min(math.hypot(a[0] - b[0], a[1] - b[1])
               for i, a in enumerate(rings) for b in rings[i + 1:])
    gap = near - 2 * r_out - 2 * v["mark_clr"]
    gate(gap >= 2 * NOZZLE,
         f"closest ring pair {near:.2f}mm apart: {gap:.2f}mm of black web left "
         f"after the {v['mark_clr']:g} pocket offset ({gap/NOZZLE:.1f} extrusions)",
         "THE POCKETS MERGE — adjacent rings bleed into one blob")

    # inside the face, and clear of the cord bore it now shares that face with.
    outline = body_poly(v)
    pts = [p for c in rings for p in capsule_poly(((c[0], c[1], c[0], c[1]), r_out))]
    out = [p for p in pts
           if (abs(p[0]) / v["body_ax"]) ** 4
           + (abs(p[1] - (v["body_cy"] if v["slot"] else 0)) /
              (v["body_ay2"] if v["slot"] else v["body_ay"])) ** 4 > 1]
    edge = poly_gap(pts, outline)
    gate(not out and edge >= 2 * NOZZLE,
         f"mark to the edge of the face: {edge:.2f}mm at its thinnest "
         f"(mark_cy {v['mark_cy']:+.2f} centres it on the FACE, not on the board)",
         f"{len(out)} sample points OUTSIDE THE OUTLINE" if out else
         "THE MARK RUNS OFF THE EDGE OF THE FACE")
    if v["slot"]:
        bore = poly_gap(pts, capsule_poly(slot_capsule(v, v["slot_ch"])))
        gate(bore >= 2 * NOZZLE,
             f"mark to the cord bore: {bore:.2f}mm ({bore/NOZZLE:.1f} extrusions)",
             "THE TOP RINGS ARE CUT BY THE CORD SLOT")
    return fails, notes


# ---- two-color deboss vs the layer stack --------------------------------------
# The slice profile these cases print with (see PRINTS.md). A layer boundary sits
# at INITIAL_LAYER + k*LAYER_H; the slicer decides what a layer contains from a
# plane through the layer's MIDDLE, which is why depths that fall mid-layer round
# in a direction that depends on the layer height.
INITIAL_LAYER, LAYER_H = 0.20, 0.12


def check_deboss():
    """The accent insert and its pocket must be the same depth, on a boundary.

    Read from the .scad rather than restated here: this is the one number that
    two modules have to agree on, and a copy in this file could agree with
    neither. Both `tray_backmark` (the pocket) and `mark_skin_print` (the white
    insert) must extrude `mark_z`.
    """
    fails, notes = [], []
    path = os.path.join(CAD_DIR, SCAD)
    try:
        src = open(path).read()
    except OSError as e:
        return [f"cannot read {SCAD}: {e}"], notes

    def scad_num(name):
        m = re.search(rf"^{name}\s*=\s*([\d.]+)\s*;", src, re.M)
        return float(m.group(1)) if m else None

    mark_z, mark_clr = scad_num("mark_z"), scad_num("mark_clr")
    if mark_z is None:
        return [f"{SCAD}: no `mark_z` — pocket and insert depths are unlinked"], notes
    if mark_clr is None:
        return [f"{SCAD}: no `mark_clr` — pocket/insert walls may be coincident"], notes

    for mod, what in (("tray_backmark", "pocket"), ("mark_skin_print", "insert")):
        body = re.search(rf"module {mod}\(\)\{{(.*?)\n\}}", src, re.S)
        uses = body and "mark_z" in body.group(1)
        (notes if uses else fails).append(
            f"{what} ({mod}) extrudes mark_z"
            + ("" if uses else "  <-- HARDCODED DEPTH, can drift from the pocket"))

    layers = (mark_z - INITIAL_LAYER) / LAYER_H
    on_boundary = abs(layers - round(layers)) < 1e-9
    (notes if on_boundary else fails).append(
        f"mark_z {mark_z:.2f} = initial {INITIAL_LAYER} + {layers:.2f} x {LAYER_H}"
        + ("" if on_boundary else "  <-- MID-LAYER: the top face rounds unpredictably"))
    n_layers = 1 + round(layers)
    (notes if n_layers >= 3 else fails).append(
        f"accent is {n_layers} layers thick"
        + ("" if n_layers >= 3 else "  <-- TOO SHALLOW, needs >= 3"))
    (notes if 0 < mark_clr < NOZZLE else fails).append(
        f"pocket XY clearance {mark_clr:.2f}mm ({mark_clr/NOZZLE:.1f} extrusions): "
        "walls not coincident, gap under one extrusion so it closes up"
        + ("" if 0 < mark_clr < NOZZLE else "  <-- 0 = COINCIDENT WALLS / >1 = VISIBLE GAP"))
    return fails, notes


if __name__ == "__main__":
    argv = sys.argv[1:]
    hero = bool({"hero", "--hero"} & set(argv))
    argv = [a for a in argv if a not in ("hero", "--hero")]
    which = argv or list(BOARDS)
    bad = 0
    for name in which:
        try:
            fails, notes = check(name, BOARDS[name])
        except RuntimeError as e:
            fails, notes = [str(e)], []
        print(f"\n=== {name.upper()} (depth {BOARDS[name]['depth']}mm) ===")
        for n in notes:
            print(f"  ok    {n}")
        for f in fails:
            print(f"  FAIL  {f}")
        bad += len(fails)
    sections = [(f"TWO-COLOR DEBOSS ({INITIAL_LAYER} initial + {LAYER_H} layers)",
                 check_deboss()),
                (f"THE HERO RENDER'S NUMBERS ({HERO})", check_hero_numbers())]
    if hero:
        sections.append(("THE HERO RENDER AS GEOMETRY (CGAL boolean)",
                         check_hero_clash()))
    for title, (fails, notes) in sections:
        print(f"\n=== {title} ===")
        for n in notes:
            print(f"  ok    {n}")
        for f in fails:
            print(f"  FAIL  {f}")
        bad += len(fails)
    if not hero:
        print("\n  skipped  the hero render's boolean (~1 min of CGAL): "
              "`python3 check_fit.py hero`")
    print(f"\n{'ALL CHECKS PASS' if not bad else str(bad) + ' CHECK(S) FAILED'}")
    sys.exit(1 if bad else 0)
