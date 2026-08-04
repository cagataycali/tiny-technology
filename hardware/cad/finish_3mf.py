#!/usr/bin/env python3
"""Post-process an mf3_pack 3MF into something Bambu Studio opens correctly.

Two fixes, both learned the hard way:

1. PLACEMENT. mf3_pack writes the build item at transform 0,0,0, which is the
   bed ORIGIN CORNER, not the bed centre. Any geometry at negative X/Y then
   hangs off the plate and Studio throws "Serious Conflict" with half the model
   outside the print area. The item transform is rewritten to the bed centre.

   The item transform places the assembly's ORIGIN, though, not its geometry —
   so a number that centres one plate silently offsets another. `--centre` puts
   the geometry's own bounding box on the target point instead, measured from
   the mesh: the same 128,124.5 that centres the two-case plate leaves a
   one-case plate 18mm off, and an off-centre probe plate is how a colour
   bisection once produced a false negative (an "empty" band that was simply
   somewhere else).

2. COLOR. The per-part extruder assignment lives in Metadata/model_settings.config,
   which mf3_pack does not write. Studio DOES honour it when embedded (verified
   from the GUI), so parts named *_ACCENT get extruder 2 and everything else
   extruder 1. Note the Bambu CLI ignores this file — a CLI slice of this plate
   produces zero toolchanges, so an actual two-color print needs a GUI pass.

    python3 finish_3mf.py plate.3mf [bed_x bed_y] [--centre]
"""
import re
import shutil
import sys
import zipfile

BED = (108.0, 128.0)          # X2D centre-ish; where v2.3 verified good


def geometry_bbox(model):
    """XY bbox of everything the build item will place, in assembly coords.

    Vertices live in each mesh object; the assembly's <component> entries carry
    the translation that puts each one on the plate. Both have to be read or the
    bbox is the bbox of one part.
    """
    verts = {}
    for obj in re.finditer(r'<object id="(\d+)"[^>]*>(.*?)</object>', model, re.S):
        pts = re.findall(r'<vertex x="([-\d.e]+)" y="([-\d.e]+)"', obj.group(2))
        if pts:
            xs = [float(p[0]) for p in pts]
            ys = [float(p[1]) for p in pts]
            verts[obj.group(1)] = (min(xs), max(xs), min(ys), max(ys))
    lo_x = lo_y = float("inf")
    hi_x = hi_y = float("-inf")
    for comp in re.finditer(r'<component[^>]*\bobjectid="(\d+)"'
                            r'(?:[^>]*\btransform="([^"]*)")?', model):
        box = verts.get(comp.group(1))
        if not box:
            continue
        t = (comp.group(2) or "").split()
        dx, dy = (float(t[9]), float(t[10])) if len(t) >= 12 else (0.0, 0.0)
        lo_x, hi_x = min(lo_x, box[0] + dx), max(hi_x, box[1] + dx)
        lo_y, hi_y = min(lo_y, box[2] + dy), max(hi_y, box[3] + dy)
    if lo_x == float("inf"):                    # no assembly: a lone mesh object
        for box in verts.values():
            lo_x, hi_x = min(lo_x, box[0]), max(hi_x, box[1])
            lo_y, hi_y = min(lo_y, box[2]), max(hi_y, box[3])
    return lo_x, hi_x, lo_y, hi_y


def finish(path, bed=BED, centre=False):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        blobs = {n: z.read(n) for n in names}

    model = blobs["3D/3dmodel.model"].decode()

    # --- fix 1: place the build item at the bed centre ---------------------
    at = bed
    if centre:
        lo_x, hi_x, lo_y, hi_y = geometry_bbox(model)
        at = (bed[0] - (lo_x + hi_x) / 2, bed[1] - (lo_y + hi_y) / 2)

    def place(m):
        return f'{m.group(1)}1 0 0 0 1 0 0 0 1 {at[0]:g} {at[1]:g} 0"'
    model, n_placed = re.subn(r'(<item\b[^>]*?\btransform=")[^"]*"', place, model)
    if not n_placed:
        raise SystemExit(f"{path}: no <item transform> found — cannot place")

    # --- fix 2: per-part extruder assignment ------------------------------
    # the ASSEMBLY object is the one holding <components>, which is NOT the
    # first <object> in the file — a non-greedy search from the top matches
    # the first mesh object instead and finds zero parts.
    obj = None
    for cand in re.finditer(r'<object id="(\d+)"[^>]*>(.*?)</object>', model, re.S):
        if "<component" in cand.group(2):
            obj = cand
            break
    if obj is None:
        raise SystemExit(f"{path}: no assembly <object> with components found")
    oid = obj.group(1)
    parts = re.findall(r'<component[^>]*\bobjectid="(\d+)"', obj.group(2))
    names_by_id = dict(re.findall(
        r'<object id="(\d+)"[^>]*\bname="([^"]*)"', model))

    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<config>",
             f'  <object id="{oid}">',
             '    <metadata key="name" value="tiny_necklace"/>',
             '    <metadata key="extruder" value="1"/>']
    for pid in parts:
        pname = names_by_id.get(pid, f"part{pid}")
        ext = 2 if pname.upper().endswith("ACCENT") else 1
        lines += [f'    <part id="{pid}" subtype="normal_part">',
                  f'      <metadata key="name" value="{pname}"/>',
                  f'      <metadata key="extruder" value="{ext}"/>',
                  "    </part>"]
    lines += ["  </object>", "</config>", ""]
    cfg = "\n".join(lines).encode()

    blobs["3D/3dmodel.model"] = model.encode()
    blobs["Metadata/model_settings.config"] = cfg

    shutil.copy(path, path + ".bak")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in blobs.items():
            z.writestr(n, data)
    accents = [names_by_id.get(p, "") for p in parts
               if names_by_id.get(p, "").upper().endswith("ACCENT")]
    how = (f"geometry centred on {bed[0]:g},{bed[1]:g} (item origin {at[0]:g},"
           f"{at[1]:g})" if centre else f"item origin at {bed[0]:g},{bed[1]:g}")
    return f"{path}: {how}; {len(parts)} parts, accent={accents}"


if __name__ == "__main__":
    args = sys.argv[1:]
    centre = "--centre" in args
    args = [a for a in args if a != "--centre"]
    if not args:
        raise SystemExit(__doc__)
    bed = BED
    if len(args) >= 3 and args[-1].replace(".", "").isdigit():
        bed = (float(args[-2]), float(args[-1]))
        args = args[:-2]
    for p in args:
        print(finish(p, bed, centre))
