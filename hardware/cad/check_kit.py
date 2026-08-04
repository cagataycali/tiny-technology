#!/usr/bin/env python3
"""Gate a sliced cord-kit plate: is the hole each bead exists for actually open?

Every gate before this one is about the MODEL. check_fit.py measures the bead's
wall at the chamfered bore mouth and the web between its two bores, and it found
a real bug there (the outline was sized from the 2.9 bore while the plate prints
a 3.0). None of that says the SLICER drew the holes. A 2.9mm bore is seven
extrusions across; hole compensation, over-extrusion or a squashed first layer
can close it, and three beads with welded bores look exactly like three good
ones until you try to thread a cord through them.

So this reads the toolpath. For every bore, on every layer it appears:

  1. nothing may be extruded across the bore's own radius — the hole is open,
     and how open is reported as a diameter, not a verdict
  2. there must be extrusion in the ring just outside it — the hole is a hole
     in a real wall, and not a region the slicer dropped whole

Both, because "nothing inside the bore" is also true of a plate that sliced
nothing at all — the shape of every vacuous test this repo has caught.

The bores' positions are not restated here. They come from the plate itself:
the part NAME carries the bore (slider_bore290 -> 2.90) and the 3MF's own
component and item transforms say where that part sits on the bed. So this
checks the bead the human will pick up and read the name off, and a rename that
drops the number is a failure rather than a silent skip.

    python3 check_kit.py /tmp/s29kit/plate_1.gcode --project tiny_v29_cordkit.3mf
"""
import argparse
import math
import re
import sys
import zipfile
from pathlib import Path

from check_fit import NOZZLE, scad_values      # the model's own numbers, not copies

STEP = 0.25          # how finely a move is sampled, mm
RING = 1.2           # how far outside a bore still counts as "a wall around it"


def plate_bores(project):
    """[(name, bore, x, y)] on the bed, read out of the 3MF's own transforms."""
    model = zipfile.ZipFile(project).read("3D/3dmodel.model").decode()
    names = dict(re.findall(r'<object id="(\d+)"[^>]*\bname="([^"]*)"', model))
    item = re.search(r'<item\b[^>]*\btransform="([^"]*)"', model)
    if not item:
        raise SystemExit(f"{project}: no <item transform> — nothing is placed")
    t = item.group(1).split()
    ox, oy = float(t[9]), float(t[10])
    web = scad_values()["slider_web"]

    out = []
    for cid, tr in re.findall(r'<component[^>]*\bobjectid="(\d+)"'
                              r'(?:[^>]*\btransform="([^"]*)")?', model):
        name = names.get(cid, f"part{cid}")
        m = re.search(r"(\d{3})$", name)
        if not m:
            raise SystemExit(
                f"{project}: part '{name}' carries no bore in its name. Three "
                "beads differ by 0.1mm of hole and nothing else — the name is "
                "the only label they have, and this check needs it too.")
        bore = int(m.group(1)) / 100.0
        c = tr.split()
        dx, dy = (float(c[9]), float(c[10])) if len(c) >= 12 else (0.0, 0.0)
        for s in (-1, 1):
            out.append((name, bore, ox + dx + s * (bore + web) / 2, oy + dy))
    return out


def toolpath(path):
    """[(z, x, y)] samples of every extruding move, arcs included.

    Arcs matter here, not as a detail: `enable_arc_fitting` is on in this
    profile, so the perimeter around a 3mm hole is emitted as G2/G3 and a
    parser that only reads G1 would see an empty ring and pass check 2 for the
    wrong reason.
    """
    pts = []
    x = y = z = 0.0
    e_last = 0.0
    relative_e = False
    for ln in Path(path).read_text(errors="ignore").splitlines():
        # z comes from the layer marker and NEVER from a G1 Z. Z-hops move Z on
        # travel moves, so reading those made a 6mm bead 1849 "layers" deep and
        # turned check 2 into a per-hop coin flip that failed on a good plate.
        if ln.startswith("; Z_HEIGHT:"):
            z = round(float(ln.split(":")[1]), 3)
            continue
        if ln.startswith("M83"):
            relative_e = True
            continue
        if ln.startswith("M82"):
            relative_e = False
            continue
        if ln[:3] not in ("G1 ", "G2 ", "G3 ", "G0 "):
            continue
        code = ln.split(";")[0]

        def num(letter):
            m = re.search(rf"\b{letter}(-?[\d.]+)", code)
            return float(m.group(1)) if m else None

        nx, ny, e = num("X"), num("Y"), num("E")
        de = 0.0
        if e is not None:
            de = e if relative_e else e - e_last
            e_last = e if not relative_e else e_last
        moving = nx is not None or ny is not None
        x1 = nx if nx is not None else x
        y1 = ny if ny is not None else y
        if de > 0 and moving:
            if code.startswith("G2") or code.startswith("G3"):
                i, j = num("I") or 0.0, num("J") or 0.0
                cx, cy = x + i, y + j
                r = math.hypot(i, j)
                a0 = math.atan2(y - cy, x - cx)
                a1 = math.atan2(y1 - cy, x1 - cx)
                cw = code.startswith("G2")
                sweep = (a0 - a1) if cw else (a1 - a0)
                sweep %= 2 * math.pi
                n = max(2, int(r * sweep / STEP) + 1)
                for k in range(n + 1):
                    a = a0 + (-1 if cw else 1) * sweep * k / n
                    pts.append((z, cx + r * math.cos(a), cy + r * math.sin(a)))
            else:
                n = max(1, int(math.hypot(x1 - x, y1 - y) / STEP))
                for k in range(n + 1):
                    pts.append((z, x + (x1 - x) * k / n, y + (y1 - y) * k / n))
        x, y = x1, y1
    return pts


def check(gcode, project):
    fails, notes = [], []
    bores = plate_bores(project)
    pts = toolpath(gcode)
    if not pts:
        return [f"{gcode}: no extruding moves parsed — nothing below can fail"], notes
    zs = sorted({p[0] for p in pts})
    notes.append(f"{len(pts)} toolpath samples over {len(zs)} layers "
                 f"(z {zs[0]:g}..{zs[-1]:g}), {len(bores)} bores to check")

    # How many layers the bead SHOULD be, from its own height and the profile's
    # own layer height. Without this, one parsed layer would make check 2 pass by
    # having nothing to disagree with.
    txt = Path(gcode).read_text(errors="ignore")
    lh = float(re.search(r"^; layer_height = ([\d.]+)", txt, re.M).group(1))
    ih = float(re.search(r"^; initial_layer_print_height = ([\d.]+)",
                         txt, re.M).group(1))
    want = round((scad_values()["slider_len"] - ih) / lh) + 1
    (notes if abs(len(zs) - want) <= 1 else fails).append(
        f"{len(zs)} layers for a {scad_values()['slider_len']:g}mm bead at "
        f"{ih:g}+{lh:g} = {want} expected"
        + ("" if abs(len(zs) - want) <= 1 else
           "  <-- THE PLATE IS NOT THE BEAD (wrong part, or the layers were "
           "misparsed and every per-layer check below is meaningless)"))

    for name, bore, bx, by in bores:
        r = bore / 2
        near = [(p[0], math.hypot(p[1] - bx, p[2] - by)) for p in pts
                if abs(p[1] - bx) < r + RING and abs(p[2] - by) < r + RING]
        layers = sorted({z for z, d in near if d <= r + RING})
        inside = min((d for _, d in near), default=float("inf"))
        # an extrusion centred `inside` from the axis covers half a line width
        # towards it, so what the cord actually passes through is smaller
        free = 2 * (inside - NOZZLE / 2)
        ok_open = free >= bore - 0.3
        (notes if ok_open else fails).append(
            f"{name} bore at ({bx:.2f},{by:.2f}): nearest extrusion centreline "
            f"{inside:.2f}mm from the axis, so the open hole is "
            f"{free:.2f}mm across vs the modelled {bore:g}"
            + ("" if ok_open else "  <-- THE SLICER CLOSED IT: no cord goes "
                                  "through this bead"))
        ok_wall = len(layers) >= 0.9 * want
        (notes if ok_wall else fails).append(
            f"{name} bore walled on {len(layers)} of {len(zs)} layers"
            + ("" if ok_wall else "  <-- NO WALL AROUND THE HOLE on "
               f"{len(zs)-len(layers)} layers: the region was dropped, which is "
               "also why check 1 passed"))
    return fails, notes


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gcode")
    ap.add_argument("--project", required=True,
                    help="the .3mf that was sliced — it holds the bore names "
                         "and the bed positions")
    a = ap.parse_args(argv)
    fails, notes = check(a.gcode, a.project)
    for n in notes:
        print(f"  ok    {n}")
    for f in fails:
        print(f"  FAIL  {f}")
    print("KIT CHECKS PASS" if not fails else f"{len(fails)} KIT CHECK(S) FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
