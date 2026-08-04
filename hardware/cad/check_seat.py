#!/usr/bin/env python3
"""Gate a sliced case plate: did the slicer actually cut the crown seat?

The seat is the v2.9 feature the whole wrapped-cord necklace leans on. Without
it the cord crosses a flat 10mm crown and wanders sideways, which cants the
pendant; with it the cord is held on the centre line by a round-bottomed groove
(held, not caught — see E: in the print it rides the groove's two mouth corners).
check_fit.py proves the groove is in the MODEL — 0.9mm deep, 2.88mm at the
mouth, 1.5mm of bar left under it. That is not the same claim as "the printed
part has a groove in it", and the difference is a real hazard here: the groove
is 0.9mm deep against a 0.42 nozzle and a 0.12 layer, so it is the kind of
shallow concavity a slicer can round over, wall-compensate away, or simply fill
as solid — and a filled groove looks perfect in the preview and in every
geometry check, because the geometry was never wrong.

So this compares two point clouds, layer by layer, in bed coordinates:

  * the MESH's own cross-section at that layer's slice height, sampled off the
    triangles in the .3mf that was sliced;
  * the TOOLPATH the slicer emitted for that layer, arcs included.

and asks, at the seat's own axis:

  A. FREE RADIUS — the nearest extrusion centreline to the arc's centre, less
     half a line width, must be at least cord_d/2 wherever the mesh offers that
     much room. The cord crosses the whole depth, so one filled layer is a
     pendant the cord does not thread.
  B. DEPTH — shoulder crest minus the material at the centre line, measured the
     same way in both clouds, must AGREE. Not "must be seat_d": seat_d is the
     depth in the middle of the band, and near a part's faces the model itself
     takes the groove away.
  C. CREST — the toolpath's crown must sit half a line width under the mesh's,
     on every layer. This is what makes B non-vacuous: it pins the datum both
     depths are measured from, so a part printed 1mm short cannot pass B by
     measuring a groove-shaped nothing somewhere else.
  D. The mesh's own claim — the deepest groove in the mesh must be seat_d, on at
     least half the part's layers. Without this the whole check would pass
     beautifully on a pendant with no seat at all, by proving the slicer
     faithfully reproduced a flat crown.
  E. SEATED DEPTH — how far a cord_d cord's underside actually descends, which
     is not what A and B measure. A asks how much room the groove HAS and B how
     deep it is cut; a cord is 3mm across and cannot use either number, because
     `seat_r = cord_d/2 + 0.1` puts the arc's centre 0.7mm OUTSIDE the crown, so
     the groove is widest at its mouth and narrows going down. What stops the
     cord is therefore whichever it touches first — the arc's bottom or the two
     mouth corners — and in a print those corners are rounded by half a line
     width, which is a real 0.114mm the model cannot show.

The expectation comes from the mesh, and not from a formula, because the model
takes the groove away in more than one way and this checker cannot be trusted to
know them all. Two are already in the file: `body_ch` tapers the crown 1mm of Y
per 1mm of Z at each face, and the locket tray's bottom `cover_lip` is inset by
the rabbet the cover's rim grips — so its first ~11 layers have no crown at all,
never mind a groove in it, and the COVER carries that stretch of the cord.
An earlier version of this check hard-coded the chamfer ramp and reported the
rabbet as six failures on a good plate. Sampling the mesh instead means the next
feature that reshapes the crown is described to this check by the model.

Nothing about the seat's position is written down here. crown, seat axis, bed
height and orientation come from the 3MF's own mesh bounds and transforms, and
seat_d/seat_r/seat_w/cord_d/body_ch come from the model's own `part="values"`
echo — including which end of the part the crown is on, because
part="doorprint" prints the door FLIPPED and its crown is at the bbox's minimum
Y, and --bat is a taller body whose crown is at head_top 25.25 and not 20.0.

    python3 check_seat.py /tmp/s29case/plate_1.gcode --project tiny_v29_vision_x1.3mf
    python3 check_seat.py /tmp/s29locket/plate_1.gcode --project tiny_v29_locket.3mf \
            --bat --part tray,cover,door
"""
import argparse
import math
import re
import sys
import zipfile
from collections import namedtuple
from pathlib import Path

from check_fit import NOZZLE, scad_values     # the model's own numbers, not copies
from check_kit import STEP, toolpath          # the arc-aware reader, not a second one

TOL = 0.15          # mm; a third of a line width, on a 0.12mm layer
NEAR_X = 6.0        # how wide a window around the seat axis to sample
NEAR_Y = 4.0        # and how far down from the crown
MIN_DEPTH = 0.3     # a dent shallower than this is not a groove a nozzle can draw
CREST_TOL = 0.10    # how far the printed crown may sit off the mesh's, past lw/2
CEN = 0.30          # half-width of the toolpath band that counts as "at the
                    # centre line". It MUST exceed STEP: at 0.15 the sampled
                    # points could straddle the groove's bottom and leave only
                    # an inner wall inside the band, which reads as a 0.92mm
                    # groove where the model has 0.31 — a false FAIL on one copy
                    # of the two-case plate, and by the same mechanism a false
                    # PASS on a groove the slicer filled.
BLIND = 0.10        # how much of a part may go unmeasured before that is a fail

# name, seat axis x, crown y, +1/-1 for which end the crown is, the part's bed
# z span, the model->bed z shift (so a taper measured in model z stays in model
# z), and its triangles already translated onto the bed.
Frame = namedtuple("Frame", "name sx crown sign z_lo z_hi zoff tris")


def part_frames(project, want, v):
    """A Frame for EVERY part whose name matches one of `want`.

    Every match, not the first: a two-case plate has two trays, and one of the
    two is the copy the slicer treats differently (different toolchange order,
    different position on the bed). Checking `[0]` would have quietly halved the
    coverage on exactly the plate where it matters.

    `v` is passed in rather than read here. It used to be a bare scad_values()
    call in each of the three functions that needs it, which was fine while
    there was one variant of the model and a bug the moment there were two: the
    locket's crown is at head_top 25.25, so --bat would have moved the crown for
    the layer maths and left this function hunting for the crown of a different
    pendant, 5.25mm away.
    """
    model = zipfile.ZipFile(project).read("3D/3dmodel.model").decode()
    names = dict(re.findall(r'<object id="(\d+)"[^>]*\bname="([^"]*)"', model))
    item = re.search(r'<item\b[^>]*\btransform="([^"]*)"', model)
    if not item:
        raise SystemExit(f"{project}: no <item transform> — nothing is placed")
    t = item.group(1).split()
    ox, oy, oz = float(t[9]), float(t[10]), float(t[11])

    mesh = {}
    for obj in re.finditer(r'<object id="(\d+)"[^>]*>(.*?)</object>', model, re.S):
        body = obj.group(2)
        vs = [(float(a), float(b), float(c)) for a, b, c in re.findall(
            r'<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"', body)]
        ts = [(int(a), int(b), int(c)) for a, b, c in re.findall(
            r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"', body)]
        if vs and ts:
            mesh[obj.group(1)] = (vs, ts)

    head_top = v["head_top"]
    found = []
    for cid, tr in re.findall(r'<component[^>]*\bobjectid="(\d+)"'
                              r'(?:[^>]*\btransform="([^"]*)")?', model):
        name = names.get(cid, f"part{cid}")
        if not any(w.lower() in name.lower() for w in want) or cid not in mesh:
            continue
        vs, ts = mesh[cid]
        c = tr.split()
        dx, dy, dz = ((float(c[9]), float(c[10]), float(c[11]))
                      if len(c) >= 12 else (0.0, 0.0, 0.0))
        lo_y, hi_y = min(p[1] for p in vs), max(p[1] for p in vs)
        # which end of this part is the crown? The one whose distance from the
        # part's own origin is head_top. Getting this from the mesh rather than
        # assuming +Y is the whole reason a flipped door does not read as a
        # pendant with no groove at all.
        up, down = abs(hi_y - head_top), abs(lo_y + head_top)
        if min(up, down) > 0.1:
            raise SystemExit(
                f"{project}: part '{name}' spans y {lo_y:.3f}..{hi_y:.3f}, and "
                f"neither end is the crown at head_top {head_top:g}. This is not "
                "the part this check is about, it was rotated, or --bat is wrong "
                "for this plate — either way the numbers below would be measured "
                "somewhere arbitrary.")
        sign = 1 if up <= down else -1
        # everything from here on is bed coordinates: mesh, toolpath and the
        # gcode's own Z all in one frame, so nothing has to be converted twice
        bed = [((x + ox + dx), (y + oy + dy), (z + oz + dz)) for x, y, z in vs]
        found.append(Frame(
            name=name,
            sx=ox + dx + (min(p[0] for p in vs) + max(p[0] for p in vs)) / 2,
            crown=oy + dy + (hi_y if sign > 0 else lo_y),
            sign=sign,
            z_lo=min(p[2] for p in bed), z_hi=max(p[2] for p in bed),
            zoff=oz + dz,
            tris=[(bed[a], bed[b], bed[c]) for a, b, c in ts]))
    if not found:
        raise SystemExit(f"{project}: no part named like {'/'.join(want)} — "
                         "nothing to check")
    return found


def line_width(txt):
    m = re.search(r"^; outer_wall_line_width = ([\d.]+)", txt, re.M)
    return float(m.group(1)) if m else NOZZLE     # older profiles wrote no key


def crown_window(tris, f):
    """The triangles anywhere near the crown, with their z span precomputed.

    A part is a few thousand triangles and there are ~90 layers to slice; this
    throws away everything that cannot contribute before the slicing loop, which
    is the difference between a check that runs in a second and one nobody waits
    for.
    """
    out = []
    for t in tris:
        if (min(p[0] for p in t) > f.sx + NEAR_X
                or max(p[0] for p in t) < f.sx - NEAR_X):
            continue
        if any(f.sign * (p[1] - f.crown) < -NEAR_Y for p in t) and \
           all(f.sign * (p[1] - f.crown) < -NEAR_Y for p in t):
            continue
        out.append((min(p[2] for p in t), max(p[2] for p in t), t))
    return out


def cross_section(win, z, f):
    """The mesh's outline at bed height z near the crown, as [(x0,y0,x1,y1)].

    Segments, not samples: this side of the comparison is exact geometry, so
    keeping it exact is free, and it is what removes a band from the mesh's
    measurement entirely. A triangle with a vertex exactly on the plane
    contributes nothing — a facet's worth of gap in an outline whose facets are
    ~0.1mm, which cannot invent a groove or hide one, and is the price of not
    writing a robust polygon slicer here.
    """
    segs = []
    for zlo, zhi, t in win:
        if zlo > z or zhi < z:
            continue
        hits = []
        for p, q in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            if (p[2] - z) * (q[2] - z) < 0:
                r = (z - p[2]) / (q[2] - p[2])
                hits.append((p[0] + r * (q[0] - p[0]), p[1] + r * (q[1] - p[1])))
        if len(hits) < 2:
            continue
        (x0, y0), (x1, y1) = hits[0], hits[1]
        if (max(x0, x1) < f.sx - NEAR_X or min(x0, x1) > f.sx + NEAR_X
                or f.sign * (max(y0, y1, key=lambda y: f.sign * y)
                             - f.crown) < -NEAR_Y):
            continue
        segs.append((x0, y0, x1, y1))
    return segs


def measure_mesh(segs, f, v):
    """(crest, depth, free) off the mesh's own outline — no band, no sampling.

    Same three quantities as measure(), read exactly: the shoulder crest is the
    highest outline point clear of the mouth, the depth is the outline's height
    where it crosses the seat's axis, and the free radius is the true distance
    from the arc's centre to the outline. The toolpath cannot be read this way
    (it arrives as samples), and that asymmetry is deliberate: it puts the whole
    residual difference between the two clouds on the printing side, where it
    belongs, instead of splitting it between a real effect and my sampling.
    """
    if not segs:
        return None
    pad = v["seat_w"] / 2
    top = bot = None
    axis_y = f.crown - f.sign * (v["seat_d"] - v["seat_r"])   # the arc's centre
    free = float("inf")
    for x0, y0, x1, y1 in segs:
        # the shoulders: the part of this segment clear of the mouth. It is a
        # straight segment, so the highest point of that part is one of its ends
        # — either an original end, or where it crosses a mouth edge.
        cand = [y for x, y in ((x0, y0), (x1, y1)) if abs(x - f.sx) >= pad]
        if x0 != x1:
            for edge in (f.sx - pad, f.sx + pad):
                r = (edge - x0) / (x1 - x0)
                if 0.0 <= r <= 1.0:
                    cand.append(y0 + r * (y1 - y0))
        for y in cand:
            top = y if top is None else max(top, y, key=lambda t: f.sign * t)
        # the bottom: where the outline crosses the axis itself
        if (x0 - f.sx) * (x1 - f.sx) <= 0 and x0 != x1:
            y = y0 + (f.sx - x0) / (x1 - x0) * (y1 - y0)
            bot = y if bot is None else max(bot, y, key=lambda t: f.sign * t)
        free = min(free, pt_seg(f.sx, axis_y, x0, y0, x1, y1))
    if top is None or bot is None:
        return None
    return f.sign * (f.crown - top), f.sign * (top - bot), free


def seg_points(segs, step=0.03):
    """The mesh outline as points, for the one measurement that needs points.

    seated() asks which feature a descending circle touches first, and the
    answer can be an interior point of a facet, so this side cannot be read from
    the segment ends alone. 0.03mm is a seventh of the rounding it is measuring.
    """
    out = []
    for x0, y0, x1, y1 in segs:
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        out += [(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n)
                for k in range(n + 1)]
    return out


def seated(pts, f, rc, r_true=None):
    """(how deep the underside of a cord of radius `r_true` gets, what stopped it).

    A circle of radius rc, centred on the seat's axis, lowered until it touches
    something: for every point of the outline within rc horizontally, the circle
    cannot get past `sqrt(rc^2 - dx^2)` from it, and the binding one wins. The
    second return value is that point's x offset, which says WHICH feature is
    doing the work — ~0 is the arc's bottom, ~seat_w/2 is a mouth corner.

    Passing rc = cord_d/2 + lw/2 and measuring against extrusion CENTRELINES is
    the same question as a cord_d cord against the material, because a bead of
    width lw covers lw/2 in every direction from its path — including around a
    corner. `r_true` stays cord_d/2 through all of it: the fattened circle finds
    where the cord's CENTRE stops, and the cord's underside is its own radius
    below that. Deriving the depth from rc instead read every print 0.21mm deeper
    than the mesh it was being compared to — a 0.21 error against a 0.15
    tolerance, which failed four plates that are fine.
    """
    if r_true is None:
        r_true = rc
    best = None
    for x, y in pts:
        dx = x - f.sx
        if abs(dx) >= rc:
            continue
        yc = y + f.sign * math.sqrt(rc * rc - dx * dx)
        if best is None or f.sign * (yc - best[0]) > 0:
            best = (yc, dx)
    if best is None:
        return None
    return f.sign * (f.crown - best[0]) + r_true, best[1]


def pt_seg(px, py, ax, ay, bx, by):
    """Distance from a point to a segment."""
    dx, dy = bx - ax, by - ay
    n = dx * dx + dy * dy
    t = 0.0 if n == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / n))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def measure(ps, f, v, pad):
    """(crest under the crown, depth at the centre line, free radius) or None.

    Both clouds go through this, with the same bands, so the depths are
    differences of two heights taken the same way in each — which is what lets
    them be compared at all. An outer wall's centreline sits half a line width
    inside the surface at BOTH the shoulder and the groove's bottom, and those
    two offsets cancel in the difference; they do not cancel in the crest, which
    is why the crest is checked against lw/2 and the depth against zero.

    Both heights are the SHALLOWEST point in their band — the one nearest the
    crown. Not the deepest: 4mm behind the crown there are inner walls, the
    cavity and infill, all of them deeper than the seat, and a "deepest point"
    would find those and call the pendant's own hollow a magnificent groove.

    CEN is half a toolpath sample apart from the centre line and not half a line
    width, which is a 0.06mm distinction worth this paragraph: the seat is an arc
    of r1.6, so at 0.42 off centre it has already climbed 0.056mm, and the
    printed path bottoms out flat across that width. A line-width band therefore
    measured the mesh 0.096mm shallower than the print on EVERY layer of every
    plate — a systematic bias eating two thirds of the tolerance below, and the
    kind of bias that quietly turns a gate into a coin flip.
    """
    if not ps:
        return None
    sho = [p for p in ps if abs(p[0] - f.sx) > v["seat_w"] / 2 + pad]
    ctr = [p for p in ps if abs(p[0] - f.sx) <= CEN]
    if not sho or not ctr:
        return None
    top = max(sho, key=lambda p: f.sign * p[1])[1]
    bot = max(ctr, key=lambda p: f.sign * p[1])[1]
    axis_y = f.crown - f.sign * (v["seat_d"] - v["seat_r"])   # the arc's centre
    return (f.sign * (f.crown - top), f.sign * (top - bot),
            min(math.hypot(p[0] - f.sx, p[1] - axis_y) for p in ps))


def check(gcode, project, want=("tray",), **defines):
    fails, notes = [], []
    v = scad_values(**defines)
    if not v["cord_seat"]:
        return (["the model has cord_seat off — there is no groove to find, and "
                 "every check below would pass by measuring nothing"], notes)
    txt = Path(gcode).read_text(errors="ignore")
    lw = line_width(txt)
    lh = float(re.search(r"^; layer_height = ([\d.]+)", txt, re.M).group(1))
    ih = float(re.search(r"^; initial_layer_print_height = ([\d.]+)",
                         txt, re.M).group(1))
    pts = toolpath(gcode)               # parsed once, measured per part
    for f in part_frames(project, want, v):
        pf, pn = check_part(pts, f, v, lw, lh, ih, gcode)
        fails += [f"{f.name}: {m}" for m in pf]
        notes += [f"{f.name}: {m}" for m in pn]
    return fails, notes


def check_part(pts, f, v, lw, lh, ih, gcode):
    fails, notes = [], []
    tall = f.z_hi - f.z_lo
    notes.append(f"crown at bed y {f.crown:.3f} ({'+' if f.sign > 0 else '-'}Y "
                 f"end), seat axis x {f.sx:.3f}, bed z {f.z_lo:g}..{f.z_hi:g} "
                 f"({tall:g}mm tall), outer wall {lw:g}mm")
    if abs(f.z_lo) > 0.05:
        fails.append(f"the part does not sit on the bed: its lowest z is "
                     f"{f.z_lo:.3f}, so the slicer either dropped it silently or "
                     f"the plate needs a z offset in mf3_pack")

    # the toolpath, by layer. A layer's walls are sliced at its MIDDLE, not at
    # its top: on a crown that tapers 1mm of Y per mm of Z that is 0.06mm of
    # expected depth, which is a third of the tolerance below.
    by_z = {}
    for z, x, y in pts:
        if abs(x - f.sx) < NEAR_X and -NEAR_Y < f.sign * (y - f.crown) <= 0.5:
            by_z.setdefault(round(z, 3), []).append((x, y))
    zs = sorted(z for z in by_z if f.z_lo - 0.01 <= z <= f.z_hi + 0.01)
    if not zs:
        return ([f"{gcode}: no extrusion sampled around this part's crown — "
                 "nothing below can fail"], notes)

    # How many layers SHOULD have material at the crown: from the height of the
    # crown itself, not of the part. A door is 5.4mm of rim plugging into the
    # tray and 1.4mm of lid at the head, so measuring its bbox claimed 44 layers
    # of crown, found 11, and shouted "THE PLATE IS NOT THIS PART" at a plate
    # that was perfectly correct.
    win = crown_window(f.tris, f)
    if not win:
        return ([f"no triangle of this part is within {NEAR_X}mm of the seat axis "
                 "and the crown — it has no crown to check"], notes)
    crown_hi = max(zhi for _, zhi, _ in win)
    want_n = round((crown_hi - max(f.z_lo, 0.0) - ih) / lh) + 1
    ok = abs(len(zs) - want_n) <= 1
    (notes if ok else fails).append(
        f"{len(zs)} layers of toolpath at the crown, which the mesh carries from "
        f"z {f.z_lo:g} to {crown_hi:g} — at {ih:g}+{lh:g} that is {want_n}"
        + (f" (the part itself is {tall:g}mm tall: the rest of it is not crown)"
           if abs(crown_hi - f.z_hi) > lh else "")
        + ("" if ok else "  <-- THE SLICER DID NOT DRAW THE CROWN IT WAS GIVEN: "
                         "every per-layer measurement below belongs to something "
                         "else"))

    rows = []                    # (z, mesh(crest,depth,free), print(crest,depth,free))
    blind = []
    cradle = {}                  # z -> (nest in the mesh, in a perfect print, printed)
    for z in zs:
        cut = z - (ih if z <= ih + 1e-6 else lh) / 2
        segs = cross_section(win, cut, f)
        m = measure_mesh(segs, f, v)
        p = measure(by_z[z], f, v, lw / 2)
        if m is None or p is None:
            blind.append(z)
            continue
        mesh_pts = seg_points(segs)
        rc = v["cord_d"] / 2
        cradle[z] = (seated(mesh_pts, f, rc),                   # sharp mesh edges
                     seated(mesh_pts, f, rc + lw / 2, rc),      # printed in beads
                     seated(by_z[z], f, rc + lw / 2, rc))       # what was emitted
        rows.append((z, m, p))
    if not rows:
        return ([f"{gcode}: no layer had a shoulder either side of the mouth in "
                 "both the mesh and the toolpath — nothing was compared"], notes)
    if blind:
        ok = len(blind) <= BLIND * len(zs)
        (notes if ok else fails).append(
            f"{len(blind)} of {len(zs)} layer(s) had no shoulder either side of "
            f"the mouth in one of the two clouds (z {min(blind):g}.."
            f"{max(blind):g}) — not compared"
            + ("" if ok else f"  <-- that is more than {BLIND:.0%} of the part "
                             "going unmeasured, which is coverage lost quietly "
                             "rather than a feature checked"))

    # ---- D. the mesh's own claim, first: is there a seat in this part? --------
    # Measured on the axis itself, so this is seat_d and not a number derived
    # from how the check samples — which keeps the gate tight enough to catch a
    # groove modelled 0.1mm shallow, rather than loosening TOL to fit a bias.
    deep = [r for r in rows if r[1][1] >= v["seat_d"] - 0.05]
    ok = len(deep) >= len(rows) / 2
    (notes if ok else fails).append(
        f"the mesh carries the seat on {len(deep)} of {len(rows)} layers, "
        f"{max(r[1][1] for r in rows):.3f}mm deep at most on the axis vs seat_d "
        f"{v['seat_d']:g} — so there is a groove here for the slicer to get wrong"
        + ("" if ok else "  <-- THE MESH HAS NO SEAT: the checks below would "
                         "pass by proving the slicer faithfully printed a flat "
                         "crown. Wrong part, or cord_seat did not reach it"))

    # ---- A. the space the cord gets, wherever the model offers it -------------
    room = [r for r in rows if r[1][2] >= v["cord_d"] / 2]
    worst = min(room, key=lambda r: r[2][2], default=None)
    if len(room) < len(rows) / 2:
        fails.append(
            f"the MESH offers a {v['cord_d']:g} cord its {v['cord_d']/2:g}mm of "
            f"room on only {len(room)} of {len(rows)} layers, so there is no "
            f"through-groove to measure the print against — restricting the check "
            f"to those layers is how it would have passed by looking at three")
    else:
        free = worst[2][2] - lw / 2
        ok = free >= v["cord_d"] / 2
        (notes if ok else fails).append(
            f"free radius at the seat axis: {free:.3f}mm at its tightest "
            f"(z {worst[0]:g}) over {len(room)} layers, vs seat_r "
            f"{v['seat_r']:g} modelled and {v['cord_d']/2:g} needed by a "
            f"{v['cord_d']:g} cord"
            + ("" if ok else "  <-- THE PRINTED GROOVE DOES NOT HOLD THE CORD: "
                             "the slicer filled or rounded it"))

    # ---- B. depth: the toolpath against the mesh, layer for layer ------------
    cmp = [(z, m[1], p[1]) for z, m, p in rows if m[1] >= MIN_DEPTH]
    if not cmp:
        fails.append(f"no layer has a >= {MIN_DEPTH}mm groove in the mesh to "
                     "compare the toolpath against")
    else:
        bad = [(z, mm, pp) for z, mm, pp in cmp if abs(pp - mm) > TOL]
        ok = not bad
        off = max((abs(pp - mm) for _, mm, pp in cmp))
        (notes if ok else fails).append(
            f"groove depth follows the mesh on {len(cmp)} layers: worst "
            f"disagreement {off:.3f}mm (+/-{TOL}), printed "
            f"{min(p for _, _, p in cmp):.3f}..{max(p for _, _, p in cmp):.3f} "
            f"where the mesh has {min(m for _, m, _ in cmp):.3f}.."
            f"{max(m for _, m, _ in cmp):.3f}"
            + ("" if ok else "  <-- " + ", ".join(
                f"z{z:g} printed {pp:.2f} where the mesh has {mm:.2f}"
                for z, mm, pp in bad[:3])
                + f" ({len(bad)} layers off): THE GROOVE IS NOT AS DEEP AS THE "
                  "CORD NEEDS TO SIT IN IT"))

    # ---- E. where the CORD comes to rest, which is not where the groove ends --
    # B measures the groove. This measures the cord in it, and they are different
    # numbers on purpose: seat_r is cord_d/2 + 0.1, so the arc's centre is 0.7mm
    # outside the crown and the groove is WIDEST at its mouth. A cord therefore
    # never fills it — it is stopped by the arc's bottom or by the two mouth
    # corners, and half a line width of bead rounds those corners into the cord's
    # path. The expectation is the same mesh measured with the same rounding, so
    # the gate is still "the print matches what this mesh can give", never a
    # constant; the sharp-edged number is reported next to it because that is the
    # one the model claims and the two are 0.1mm apart.
    seat = [(z, c) for z, c in sorted(cradle.items())
            if None not in c and c[0][0] >= v["seat_d"] - 0.05]
    if len(seat) < len(rows) / 2:
        fails.append(
            f"a {v['cord_d']:g} cord reaches the modelled {v['seat_d']:g}mm on "
            f"only {len(seat)} of {len(rows)} layers of the MESH — there is no "
            "seated cord here to check the print against, so agreement below "
            "would only mean both clouds are equally flat")
    else:
        # Two bounds, both per layer and both off this mesh, because the two ways
        # of being wrong are not the same shape. Too SHALLOW is measured against
        # the beaded mesh (a pinched mouth, or a floor filled in): the cord rides
        # high and can be pulled off the crown. Too DEEP is measured against the
        # sharp mesh (0.9 plus the local taper), because the modelled void is the
        # deepest a cord can go if every modelled bead is there — past that, the
        # groove's own floor is missing.
        shallow = [(z, c) for z, c in seat if c[2][0] < c[1][0] - TOL]
        deep = [(z, c) for z, c in seat if c[2][0] > c[0][0] + TOL]
        ok = not shallow and not deep
        corners = sum(1 for _, c in seat if abs(c[2][1]) > v["seat_w"] / 4)
        (notes if ok else fails).append(
            f"a {v['cord_d']:g} cord seats "
            f"{min(c[2][0] for _, c in seat):.3f}.."
            f"{max(c[2][0] for _, c in seat):.3f}mm below the crown in the print "
            f"over {len(seat)} layers, where this mesh printed in {lw:g} beads "
            f"gives {min(c[1][0] for _, c in seat):.3f}.."
            f"{max(c[1][0] for _, c in seat):.3f} and its sharp edges "
            f"{min(c[0][0] for _, c in seat):.3f}.."
            f"{max(c[0][0] for _, c in seat):.3f} (seat_d {v['seat_d']:g} plus the "
            f"face taper). The cord rests on the mouth corners on {corners} of "
            f"those layers and on the arc's bottom on {len(seat) - corners}"
            + ("" if ok else
               ("  <-- THE CORD RIDES HIGH on "
                f"{len(shallow)} layer(s) (worst z"
                f"{min(shallow, key=lambda r: r[1][2][0] - r[1][1][0])[0]:g}): the "
                "mouth is pinched or the floor filled, and a cord sitting proud of "
                "the crown is one that can be pulled sideways off it. " if shallow
                else "")
               + (f"  <-- THE FLOOR IS MISSING on {len(deep)} layer(s) (worst z"
                  f"{max(deep, key=lambda r: r[1][2][0] - r[1][0][0])[0]:g}): the "
                  "cord goes deeper than the modelled void, so the groove was cut "
                  "past the mesh and the bar under it is thinner than check_fit "
                  "gated." if deep else "")))

    # ---- C. the datum both depths were measured from ------------------------
    off = [(z, p[0] - m[0]) for z, m, p in rows]
    bad = [o for o in off if abs(o[1] - lw / 2) > CREST_TOL]
    ok = not bad
    (notes if ok else fails).append(
        f"the printed crown tracks the mesh's within "
        f"{min(o[1] for o in off):.3f}..{max(o[1] for o in off):.3f}mm on all "
        f"{len(off)} layers, i.e. half a line width ({lw/2:g}) — including the "
        f"mesh's own taper, which runs {min(m[0] for _, m, _ in rows):.2f}.."
        f"{max(m[0] for _, m, _ in rows):.2f}mm under the crown"
        + ("" if ok else f"  <-- {len(bad)} layer(s) off, worst z{max(bad, key=lambda o: abs(o[1]))[0]:g}"
                         ": the crown is not where the mesh says it is, so the "
                         "depths above were measured from the wrong datum"))

    # ---- and the chamfer, in the model's own terms, where the part has one ---
    ramp = [(z - f.zoff, m[0]) for z, m, _ in rows if z - f.zoff <= v["body_ch"]]
    if len(ramp) < 3:
        notes.append(f"no {v['body_ch']:g}mm face chamfer in this part's z span "
                     f"(model z {f.z_lo - f.zoff:g}..{f.z_hi - f.zoff:g}) — its "
                     "bed face is a cut through the body, not a face of it")
    else:
        lo, hi = min(ramp), max(ramp)
        slope = (lo[1] - hi[1]) / (hi[0] - lo[0])
        ok = abs(slope - 1.0) <= 0.1
        (notes if ok else fails).append(
            f"the mesh's chamfer measures {slope:.3f}mm of Y per mm of Z over "
            f"{len(ramp)} layers (1.0 = the 45deg body_slab() draws), so the "
            "groove fades out with the face and does not notch the silhouette"
            + ("" if ok else "  <-- not the taper body_slab() draws"))
    return fails, notes


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gcode")
    ap.add_argument("--project", required=True,
                    help="the .3mf that was sliced — it holds the part's bed "
                         "position and orientation")
    ap.add_argument("--part", default="tray",
                    help="which parts carry the groove, comma separated and "
                         "matched in the part names (default: tray)")
    ap.add_argument("--bat", action="store_true",
                    help="the plate is a locket (bat=true): a taller body, so "
                         "the crown is at head_top 25.25 and not 20.0")
    a = ap.parse_args(argv)
    fails, notes = check(a.gcode, a.project,
                         tuple(w.strip() for w in a.part.split(",") if w.strip()),
                         **({"bat": "true"} if a.bat else {}))
    for n in notes:
        print(f"  ok    {n}")
    for f in fails:
        print(f"  FAIL  {f}")
    print("SEAT CHECKS PASS" if not fails
          else f"{len(fails)} SEAT CHECK(S) FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
