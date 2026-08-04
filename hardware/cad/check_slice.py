#!/usr/bin/env python3
"""Gate a SLICED two-color plate: does the accent colour reach the visible face?

`check_fit.py` gates the geometry, and it passed with full marks on a plate
whose 7-ring mark did not exist on the face it decorates. Nothing was wrong
with the model — the slicer printed the mark in the case colour — so the check
has to read the G-code:

  1. **The filament loaded FIRST is never named.** `M1020 S<slot>` only records
     CHANGES, so every extrusion before toolchange #1 belongs to an unstated
     slot, and *whichever region the slicer schedules first on layer 1 inherits
     it*. On the v2.8 plate that was the accent: 1.93mm of ring band per case,
     sliced perfectly, printed black. Guessing the opening slot is how that
     defect got both confirmed and denied in one session, so it is not guessed
     here — it is derived. Assume each slot in turn, sum the extrusion, and keep
     the assumption that reproduces the header's own
     `; total filament length [mm]`. Exactly one does, to 0.01mm.

     Two things have to be right for that sum to close, and each was a bug:
     `enable_arc_fitting` puts extrusion in `G2`/`G3` as well as `G1`, and
     unretraction is positive E with no X/Y/I/J and must not be counted.

  2. **The order that fixes 1 must be pinned, not lucky.** With
     `first_layer_print_sequence` on auto, layer-1 ordering flips on the shape
     of the accent (solid discs got white, thin rings got black). The project
     has to force slot 1 first — see force_first_layer_order in
     patch_project.py.

  3. **A flush table that is too SHORT reads as zero, not as absent.** The
     matrix is n x n per extruder; a single block passes the CLI slice and then
     makes Studio zero-fill the second one — 0mm3 of purge on the black->white
     change, i.e. grey rings on the face that is the whole point of the inlay.
     Studio says so in a banner nobody reads in a headless run.

    python3 check_slice.py plate_1.gcode --accent-stl v28_vision_markskin.stl \\
            --copies 2 --project tiny_v28_vision_x2.3mf

Exit code is nonzero if any check fails, so this can gate a print the same way
check_fit.py gates a slice.
"""
import argparse
import collections
import json
import math
import re
import struct
import sys
import zipfile
from pathlib import Path

FILAMENT_D = 1.75           # mm; E is filament length, not extruded length
AREA = math.pi * (FILAMENT_D / 2) ** 2
# Walls that overlap in a narrow band extrude a little less than the band's
# volume, and purge lands outside the object, so the object-only accent total
# is allowed this much slack against the STL.
VOL_LO, VOL_HI = 0.85, 1.15


def stl_volume(path):
    """Signed-tetrahedron volume in mm3, binary or ascii STL."""
    data = Path(path).read_bytes()
    tris = []
    if not data[:5].lower().startswith(b"solid") or b"facet" not in data[:512]:
        n = struct.unpack("<I", data[80:84])[0]
        for i in range(n):
            off = 84 + i * 50 + 12
            tris.append(struct.unpack("<9f", data[off:off + 36]))
    else:
        nums = [float(x) for x in re.findall(
            r"vertex\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)",
            data.decode(errors="ignore")) for x in x]
        tris = [tuple(nums[i:i + 9]) for i in range(0, len(nums) - 8, 9)]
    vol = 0.0
    for t in tris:
        ax, ay, az, bx, by, bz, cx, cy, cz = t
        vol += (ax * (by * cz - bz * cy)
                - ay * (bx * cz - bz * cx)
                + az * (bx * cy - by * cx)) / 6.0
    return abs(vol)


def scan(path):
    """(header totals, runs) where a run is (slot or None, {(z, feature): E}).

    The opening run's slot is None: it is the one the G-code never states.
    """
    txt = Path(path).read_text(errors="ignore")
    m = re.search(r"total filament length \[mm\] : ([\d.,]+)", txt)
    if not m:
        raise SystemExit(f"{path}: no '; total filament length' header — "
                         "not a Bambu slice?")
    totals = [float(x) for x in m.group(1).split(",")]
    first_h = re.search(r"initial_layer_print_height = ([\d.]+)", txt)
    first_h = float(first_h.group(1)) if first_h else 0.2
    runs = [(None, collections.defaultdict(float))]
    z, feat = 0.0, ""
    for ln in txt.splitlines():
        if ln.startswith("; Z_HEIGHT:"):
            z = round(float(ln.split(":")[1]), 3)
        elif ln.startswith("; FEATURE:"):
            feat = ln.split(":", 1)[1].strip()
        elif ln.startswith("M1020 S"):
            runs.append((int(re.match(r"M1020 S(\d+)", ln).group(1)),
                         collections.defaultdict(float)))
        elif ln[:3] in ("G1 ", "G2 ", "G3 "):
            e = re.search(r" E([-\d.]+)", ln)
            # arcs carry extrusion too; unretraction is E with nowhere to go.
            if e and float(e.group(1)) > 0 and re.search(
                    r"[XYIJ]-?[\d.]", ln.split(";")[0][3:]):
                runs[-1][1][(z, feat)] += float(e.group(1))
    return totals, first_h, runs


def initial_slot(totals, runs):
    """Which slot is loaded before toolchange #1, from the header's own totals.

    Returns (slot_index, per_slot_totals, residual). The residual is how far the
    best assumption is from the header; anything but ~0 means this parser is
    missing extrusion somewhere and no verdict below can be trusted.
    """
    best = None
    for guess in range(len(totals)):
        per = [0.0] * len(totals)
        for slot, moves in runs:
            per[guess if slot is None else slot] += sum(moves.values())
        residual = max(abs(per[i] - totals[i]) for i in range(len(totals)))
        if best is None or residual < best[2]:
            best = (guess, per, residual)
    return best


def accent_layers(runs, init, accent):
    """{z: object extrusion} for the accent slot, purge tower excluded."""
    per_z = collections.defaultdict(float)
    for slot, moves in runs:
        if (init if slot is None else slot) == accent:
            for (z, feat), e in moves.items():
                if feat != "Prime tower":
                    per_z[z] += e
    return {z: e for z, e in sorted(per_z.items()) if e > 0.01}


def check_project(project, slots):
    """The two project-level settings that decide the accent's fate."""
    cfg = json.loads(zipfile.ZipFile(project).read(
        "Metadata/project_settings.config"))
    fails, notes = [], []

    seq = cfg.get("first_layer_print_sequence") or []
    if slots > 1 and [str(s) for s in seq] != [str(i + 1) for i in range(slots)]:
        fails.append(f"first_layer_print_sequence is {seq}, wanted "
                     f"{[str(i + 1) for i in range(slots)]} — on auto, layer 1 "
                     "orders itself and the first region printed inherits "
                     "slot 1 with no toolchange")
    elif slots > 1:
        notes.append(f"first layer pinned to slot order {list(seq)} "
                     "(so the accent is a real toolchange, not the default)")

    matrix = [float(x) for x in cfg["flush_volumes_matrix"]]
    extruders = len(cfg.get("nozzle_diameter") or ["0.4"])
    want = slots * slots * extruders
    if len(matrix) != want:
        fails.append(f"flush_volumes_matrix has {len(matrix)} entries, "
                     f"{slots} slots x {slots} x {extruders} extruders wants "
                     f"{want} (Studio zero-fills the rest: no purge on a "
                     "colour change)")
        return fails, notes
    for e in range(extruders):
        block = matrix[e * slots * slots:(e + 1) * slots * slots]
        off = [block[r * slots + c] for r in range(slots)
               for c in range(slots) if r != c]
        if min(off) <= 0:
            fails.append(f"extruder {e + 1} flush block has a 0 between two "
                         f"different slots: {block}")
        else:
            notes.append(f"extruder {e + 1} purge {min(off):.0f}-{max(off):.0f}"
                         "mm3 per colour change")
    mult = cfg.get("flush_multiplier") or []
    if isinstance(mult, list) and len(mult) < extruders:
        fails.append(f"flush_multiplier has {len(mult)} entries for {extruders} "
                     f"extruders (the missing one reads as 0)")
    return fails, notes


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gcode")
    ap.add_argument("--accent-stl", required=True,
                    help="the accent insert, ONE copy")
    ap.add_argument("--copies", type=int, default=1,
                    help="how many of it are on the plate")
    ap.add_argument("--accent-slot", type=int, default=2,
                    help="1-based filament slot the accent is assigned to")
    ap.add_argument("--project", help="the 3MF, to check its settings")
    a = ap.parse_args(argv)

    fails, notes = [], []
    totals, first_h, runs = scan(a.gcode)
    slots = len(totals)
    accent = a.accent_slot - 1
    init, per, residual = initial_slot(totals, runs)

    if residual > 0.05:
        fails.append(f"cannot account for the G-code: best assumption is off "
                     f"the header by {residual:.2f}mm ({[round(v, 1) for v in per]} "
                     f"vs {totals}) — every verdict below is unsafe")
    else:
        notes.append(f"initial filament is slot {init + 1}, derived from the "
                     f"header ({residual:.2f}mm residual); the run before "
                     "toolchange #1 has no M1020 of its own")

    vol = stl_volume(a.accent_stl) * a.copies
    want = vol / AREA
    layers = accent_layers(runs, init, accent)
    got = sum(layers.values())
    notes.append(f"accent geometry {vol:.1f}mm3 over {a.copies} copies "
                 f"= {want:.1f}mm of {FILAMENT_D}mm filament; slot "
                 f"{accent + 1} lays down {got:.1f}mm of object "
                 f"({got / want:.2f}x) plus {per[accent] - got:.1f}mm of purge")
    if not VOL_LO <= got / want <= VOL_HI:
        fails.append(f"slot {accent + 1} object extrusion is {got / want:.2f}x "
                     f"the accent geometry — part of the mark is printing in "
                     "another colour (or another colour is printing the mark)")

    zs = sorted(layers)
    notes.append(f"accent lands on {len(zs)} layers: "
                 + ", ".join(f"z{z:g}={layers[z]:.1f}mm" for z in zs[:8]))
    if not zs or zs[0] > first_h + 1e-6:
        fails.append(f"accent never reaches the FIRST layer (starts at "
                     f"{zs[0] if zs else None}, first layer is z{first_h:g}) — "
                     "the bed-facing face is the visible one")
    gaps = [(zs[i], zs[i + 1]) for i in range(len(zs) - 1)
            if zs[i + 1] - zs[i] > 0.1201]
    if gaps:
        fails.append(f"accent skips layers between {gaps} — a black band "
                     "through the inlay")

    if a.project:
        f2, n2 = check_project(a.project, slots)
        fails += f2
        notes += n2

    for n in notes:
        print(f"  ok   {n}")
    for f in fails:
        print(f"  FAIL {f}")
    print("SLICE CHECKS PASS" if not fails else f"{len(fails)} FAILURE(S)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
