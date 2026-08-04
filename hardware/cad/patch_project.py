#!/usr/bin/env python3
"""Embed the quality settings and the two filament slots INTO a model 3MF.

Why this exists: presets on disk only reach a CLI slice. When you double-click
the 3MF, Bambu Studio configures the plate from `Metadata/project_settings.config`
inside the file — so that is where the 0.12mm jewelry profile has to live if
"open it in Bambu" is supposed to open with the right settings already on.

The config is a 560-key FLAT dict (no `inherits`, see make_profile.py) with one
entry per filament slot in every per-filament key. Rather than hand-write it,
this takes the config Bambu itself exports from a successful slice
(`--export-settings`), so every key that matters is already in the exact form
Studio wrote it:

    python3 patch_project.py exported.json tiny_v26_vision_x2.3mf \\
        --colours "#000000,#FFFFFF"

What it changes on top of the export:
  * every per-filament key padded to the slot count (the exporter leaves keys it
    did not touch at length 1, which Studio reads as "slot 2 unset")
  * filament_colour / filament_ids per slot — colour is a project property, it
    cannot be carried by a filament preset (that segfaults the CLI)

Verify it took by slicing the patched 3MF with NO --load-settings at all: the
G-code header must still read layer_height = 0.12.
"""
import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

PROJECT = "Metadata/project_settings.config"
MODEL = "3D/3dmodel.model"
PLA_DENSITY = "1.24"          # Bambu PLA Basic, g/cm^3, from its own preset
# Studio decides whether a 3MF is a PROJECT (adopt its settings) or just
# geometry (import into whatever presets are open) from this metadata in
# 3dmodel.model. Without it the embedded project_settings.config is silently
# ignored — measured: the plate opened at 0.20mm Standard with one filament
# slot while the file said 0.12mm and two. mf3_pack does not write it.
APP = "BambuStudio-02.08.00.50"
BBL_NS = 'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"'
STAMP = (f'<metadata name="Application">{APP}</metadata>'
         '<metadata name="BambuStudio:3mfVersion">1</metadata>')
# Keys that are per-filament-slot but that Bambu's exporter can leave at length
# 1 even for a 2-slot plate. Everything starting with `filament` is per-slot
# except these, which are per-extruder or scalar.
NOT_PER_SLOT = {
    "filament_extruder_variant",   # per extruder of the machine
    "filament_map_mode",           # scalar
    "filament_notes",              # scalar
}


def pad(value, n):
    """A per-slot list, extended to n slots by repeating its last entry."""
    if not isinstance(value, list) or not value or len(value) >= n:
        return value
    return value + [value[-1]] * (n - len(value))


def resize_flush(cfg, n):
    """Resize the flush tables to this plate's slot count, PER EXTRUDER.

    Bambu exports these at the editor's default 4 slots: a 4x4
    `flush_volumes_matrix` (16) and a per-extruder `flush_volumes_vector`
    (extruders x 4 = 8). A project that declares 2 filaments must carry an
    n x n matrix, or the CLI slice dies on "Flush volumes matrix do not match
    to the correct size!" — which only shows up once the 3MF is stamped as a
    Studio project, because before that the whole config is ignored.

    But the matrix is n x n **for every extruder of the machine**, concatenated
    — on the X2D that is 2 blocks, 8 entries for a 2-slot plate. A single 2x2
    block passes the CLI and then makes Studio warn *"Partial flushing volume
    set to 0. Multi-color printing may cause color mixing in models"*: it
    zero-fills the missing second block. Measured in Studio's own
    `BambuStudio.conf` after opening such a plate —
    `flush_volumes_matrix: 0|280|280|0|0|0|0|0`, the second block all zeros.
    Zero flush on a black->white change is exactly the defect that would land
    on the visible face of the inlay, so both blocks get filled here.
    `flush_multiplier` is per extruder too (Studio's conf: "1.0|1.0").
    """
    extruders = len(cfg.get("nozzle_diameter") or ["0.4"])
    matrix = cfg.get("flush_volumes_matrix")
    if isinstance(matrix, list) and matrix:
        # one square block per extruder; the export may carry 1 block or all.
        per = len(matrix) // extruders if len(matrix) % extruders == 0 else len(matrix)
        side = round(per ** 0.5)
        if side * side != per:            # not blocked per extruder after all
            per, side = len(matrix), round(len(matrix) ** 0.5)
        if side * side == per and side >= n:
            block = [matrix[r * side + c] for r in range(n) for c in range(n)]
            cfg["flush_volumes_matrix"] = block * extruders
    vector = cfg.get("flush_volumes_vector")
    if isinstance(vector, list) and vector and len(vector) % extruders == 0:
        per = len(vector) // extruders
        if per > n:
            cfg["flush_volumes_vector"] = [
                v for e in range(extruders) for v in vector[e * per:e * per + n]]
    mult = cfg.get("flush_multiplier")
    if isinstance(mult, list) and len(mult) == 1 and extruders > 1:
        cfg["flush_multiplier"] = mult * extruders
    return cfg


def force_first_layer_order(cfg, n):
    """Pin the first layer's filament order, so slot 1 goes first.

    The first extrusion of a print has NO `M1020` in front of it: the initial
    filament is whatever the start G-code loaded, and Studio only emits a
    toolchange once it wants a DIFFERENT one. So whichever region the slicer
    happens to schedule first on layer 1 silently inherits slot 1 — and layer 1
    is the bed-facing face, the one the inlay exists to decorate.

    With the sequence left on auto (`["0"]`) that scheduling is not ours to
    predict, and it flips on geometry: measured on two plates that differ only
    in the shape of the accent,

        7 solid discs   layer 1 order: tray, then M1020 -> accent   white  OK
        7 thin rings    layer 1 order: accent FIRST, then M1020 S0  BLACK  bad

    The rings' 1.194mm band was sliced perfectly — two widened walls, 1.93mm of
    filament, the exact amount missing from the accent slot's budget — and
    printed in the case colour, so the mark simply did not exist on the visible
    face. Nothing in the model was wrong, which is why every geometry check
    passed. Forcing the order puts slot 1 first and makes the accent a real
    toolchange instead of an inherited default.

    Layers above 1 stay on auto: they always have a preceding toolchange, so
    Studio is free to order them for the fewest changes.
    """
    if n > 1:
        cfg["first_layer_print_sequence"] = [str(i + 1) for i in range(n)]
    return cfg


def build(settings, colours, filament_id="GFA00"):
    cfg = dict(settings)
    n = len(colours)
    for key, val in list(cfg.items()):
        if key.startswith("filament") and key not in NOT_PER_SLOT:
            cfg[key] = pad(val, n)
    cfg["filament_colour"] = list(colours)
    cfg["default_filament_colour"] = list(colours)
    # Bambu's own id for PLA Basic. The exporter leaves this empty, and an empty
    # id is what makes Studio show the slot as "unknown filament" instead of
    # matching it to what is in the AMS.
    cfg["filament_ids"] = [filament_id] * n
    # Every slot on the MAIN nozzle. One filament per nozzle would need no purge
    # at all, and that was the first thing tried here — but the X2D's auxiliary
    # extruder is a Bowden with no matching nozzle-volume variant, so slot 2 on
    # extruder 2 fails the slice outright ("could not found extruder_type Bowden,
    # nozzle_volume_type Standard, filament_index 2"). Studio's own Auto For
    # Flush grouping puts both on the main nozzle for exactly that reason; this
    # just agrees with it up front instead of being silently corrected.
    cfg["filament_map"] = ["1"] * n
    # DENSITY, which Bambu's own --export-settings writes as "0". A zero density
    # is not a cosmetic gap: the slice header's `total filament weight [g]` comes
    # out 0.00, make_printable.py copies that into the job the printer displays,
    # and PRINTS.md quotes it as this plate's weight. So a plate that weighs a
    # gram gets recorded as weighing nothing. Filled in per slot, and only where
    # the export left it empty — a real value in the export always wins.
    cfg["filament_density"] = [d if d not in ("", "0", "0.0", None) else PLA_DENSITY
                               for d in pad(cfg.get("filament_density", ["0"]), n)]
    force_first_layer_order(cfg, n)
    resize_flush(cfg, n)
    # `from: project` is what tells Studio these values ARE the plate's config
    # rather than a preset it should try to look up and fail to find.
    cfg["from"] = "project"
    return cfg


def stamp_model(xml):
    """Mark 3dmodel.model as Bambu Studio's own, so the project config is read."""
    if 'name="Application"' in xml:
        return xml, False
    head = xml.index("<model ") + len("<model")
    tag_end = xml.index(">", head)
    tag = xml[head:tag_end]
    if "xmlns:BambuStudio" not in tag:
        tag += " " + BBL_NS
    return xml[:head] + tag + ">" + STAMP + xml[tag_end + 1:], True


def embed(three_mf, cfg, out=None):
    """Rewrite the 3MF with a new project_settings.config, keeping the rest."""
    src = Path(three_mf)
    dst = Path(out) if out else src
    body = json.dumps(cfg, indent=4)
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    stamped = False
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(
            tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename == PROJECT:
                continue
            data = zin.read(item.filename)
            if item.filename == MODEL:
                xml, stamped = stamp_model(data.decode())
                data = xml.encode()
            zout.writestr(item, data)
        zout.writestr(PROJECT, body)
    shutil.move(tmp, dst)
    return dst, stamped


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("settings", help="settings JSON from --export-settings")
    ap.add_argument("three_mf", help="model 3MF to patch (in place)")
    ap.add_argument("--colours", default="#000000,#FFFFFF",
                    help="one hex colour per filament slot, in order")
    ap.add_argument("--filament-id", default="GFA00",
                    help="Bambu filament id for every slot (GFA00 = PLA Basic)")
    ap.add_argument("--out", help="write here instead of in place")
    a = ap.parse_args(argv)

    colours = [c.strip() for c in a.colours.split(",") if c.strip()]
    settings = json.loads(Path(a.settings).read_text())
    cfg = build(settings, colours, a.filament_id)
    dst, stamped = embed(a.three_mf, cfg, a.out)

    print(f"{dst}: {PROJECT} <- {len(cfg)} keys, {len(colours)} filament slots")
    print(f"  {'3dmodel.model':22} {'stamped ' + APP if stamped else 'already stamped'}")
    for k in ("print_settings_id", "layer_height", "wall_loops",
              "sparse_infill_density", "seam_slope_type", "filament_colour",
              "filament_settings_id", "filament_type", "filament_ids",
              "filament_map", "first_layer_print_sequence",
              "flush_volumes_matrix", "flush_volumes_vector", "curr_bed_type"):
        print(f"  {k:22} {json.dumps(cfg.get(k))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
