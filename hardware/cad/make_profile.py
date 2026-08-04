#!/usr/bin/env python3
"""Generate the tiny-necklace slicing presets, FULLY RESOLVED.

Why resolved: the Bambu Studio 02.08 CLI does **not** follow `inherits` in a
user preset. A preset that says `inherits: 0.12mm High Quality @BBL X2D` and
overrides a few keys slices at **layer_height 0.20** — the program default —
because only the keys written in the file are applied. Nothing warns you; the
G-code header is the only place the truth shows up. So this script walks the
inherits chain inside Bambu's own bundle, flattens it, applies our overrides,
and writes presets that stand alone.

    python3 make_profile.py            # write profiles/*.json, print the diff

The overrides are the whole point of the file — every one of them is a quality
choice for a 32mm two-color pendant printed face-down, and the reasoning is
inline. Verify a change in the sliced G-code header, never in this file.
"""
import json
import os
import sys
from pathlib import Path

BUNDLE = Path(os.environ.get(
    "BAMBU_PROFILES",
    "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL"))
OUT = Path(__file__).resolve().parent / "profiles"

PRINTER = "Bambu Lab X2D 0.4 nozzle"
PROCESS_BASE = "0.12mm High Quality @BBL X2D"     # was 0.20mm Standard
FILAMENT_BASE = "Bambu PLA Basic @BBL X2D"
PROCESS_NAME = "tiny 0.12 jewelry @BBL X2D"

# ── the quality pass ────────────────────────────────────────────────────────
# Baseline for every number here is the 2026-08-01 print: 0.20mm Standard,
# 2 walls, 20% infill, outer wall 200mm/s, first layer 50mm/s.
#
# The part is a 31.6mm squircle that prints FACE-DOWN, so the two surfaces the
# wearer sees are both bed-facing: the door's front and the tray's back with the
# inlaid logo. That is what picks these settings — the finish comes off the
# plate and out of the first layers, not off the top solid.
PROCESS = {
    # 0.12 (from the base preset) over 0.20: 5 layers across the 0.6mm bail
    # fillet instead of 3, and the squircle's curvature stops reading as steps.
    # It also makes the accent inlay land on a layer boundary — see mark_z in
    # tiny_necklace_split.scad, which is solved against 0.20 + k*0.12.

    # 3 walls, not 2. There is 3.05mm of shell between the outer form and the
    # cavity, so 3 loops (1.26mm) fit without touching the cavity — the snap
    # sockets and the bail root stop being 2-wall-thin.
    "wall_loops": "3",
    # arachne, not classic: the logo ring is 1.4mm and the camera fence 0.95mm.
    # Classic quantises those to whole 0.42 extrusions and leaves a gap;
    # arachne varies the width and fills them solid.
    "wall_generator": "arachne",
    "sparse_infill_density": "25%",
    "top_shell_layers": "6",
    "bottom_shell_layers": "6",
    "top_surface_pattern": "monotonic",
    # travel that crosses a wall leaves a scar on a part this small
    "reduce_crossing_wall": "1",

    # Scarf (sloped) seam. On a round pendant the seam is the one defect you
    # cannot polish out, so the outer wall ramps in and out of it instead of
    # butting. This pair of PROCESS keys is what actually works: setting
    # `filament_scarf_seam_type: contour` in a filament preset is silently
    # reset to `none` by this CLI (measured: filament_scarf_length 42 and
    # nozzle_temperature 217 both took from the same file, scarf type did not).
    # override_filament_scarf_seam_setting = 1 hands control to the process.
    # Verify it took: the G-code header must read `has_scarf_joint_seam = 1`.
    "override_filament_scarf_seam_setting": "1",
    "seam_slope_type": "external",

    # THE INLAY SETTING. Elephant-foot compensation shrinks every first-layer
    # contour — including the white insert's, while the black pocket around it
    # grows by the same amount. At the stock 0.15 that opens a ~0.3mm white/black
    # gap on layer 1, which on this part is the visible face. 0 keeps the colour
    # boundary tight; a 31x38mm flat footprint on textured PEI does not need it.
    "elefant_foot_compensation": "0",
    # arc fitting + finer resolution: G2/G3 curves instead of 0.012mm chords,
    # which is visible on a 6mm lens bore and a 4mm bail.
    "enable_arc_fitting": "1",
    "resolution": "0.008",

    # Speeds. The first layer IS the logo face, so it gets the biggest cut
    # (50 -> 30). Outer wall 60 -> 50; the rest stay quick because they are
    # interior and this is already a 2h plate.
    "initial_layer_speed": ["30", "30", "30", "30"],
    "initial_layer_infill_speed": ["70", "70", "70", "70"],
    "outer_wall_speed": ["50", "50", "50", "50"],
    "inner_wall_speed": ["120", "120", "100", "100"],
    "internal_solid_infill_speed": ["150", "150", "100", "100"],
    "sparse_infill_speed": ["120", "100", "100", "100"],
    "top_surface_speed": ["100", "100", "100", "100"],
    "gap_infill_speed": ["60", "60", "60", "60"],
}

# There are deliberately NO custom filament presets. Two reasons, both measured:
#   * a user filament preset carrying `filament_colour` segfaults this CLI
#     (bare preset rc=0, +filament_colour rc=139), and loading two flattened
#     filament presets at once aborts it (rc=133);
#   * nothing we want from a filament preset survives anyway — the scarf keys
#     are ignored there (see the process block above).
# Colour is a project/AMS-slot property, so it lives in the 3MF's
# project_settings.config instead — see patch_project.py.
FILAMENT_SYSTEM = FILAMENT_BASE

# Keys that identify a preset rather than configure it.
META = ("type", "name", "from", "inherits", "setting_id", "instantiation",
        "description", "compatible_printers", "compatible_printers_condition",
        "compatible_prints", "compatible_prints_condition", "renamed_from")


def index_bundle():
    """{preset name: raw dict} across the whole BBL bundle."""
    if not BUNDLE.exists():
        raise SystemExit(f"Bambu profile bundle not found: {BUNDLE}\n"
                         "set $BAMBU_PROFILES to the BBL directory")
    presets = {}
    for path in BUNDLE.rglob("*.json"):
        try:
            d = json.loads(path.read_text())
        except (ValueError, OSError):
            continue
        if isinstance(d, dict) and d.get("name") and d.get("type") in (
                "process", "filament", "machine"):
            presets[d["name"]] = d
    return presets


def resolve(presets, name, chain=()):
    """Flatten a preset and everything it inherits, child last."""
    if name in chain:
        raise SystemExit(f"inherits cycle: {' -> '.join(chain + (name,))}")
    d = presets.get(name)
    if d is None:
        raise SystemExit(f"preset not found in bundle: {name!r}")
    flat = resolve(presets, d["inherits"], chain + (name,)) if d.get("inherits") else {}
    flat.update({k: v for k, v in d.items() if k not in META})
    return flat


def write(path, body):
    path.write_text(json.dumps(body, indent=2) + "\n")
    return path


def main():
    presets = index_bundle()
    OUT.mkdir(exist_ok=True)
    written = []

    base = resolve(presets, PROCESS_BASE)
    proc = dict(base)
    proc.update(PROCESS)
    # identity keys go LAST: the resolved base carries its own (empty)
    # print_settings_id, which would otherwise overwrite ours
    written.append(write(OUT / "tiny_fine_0.12.json", {
        "type": "process", **proc, "name": PROCESS_NAME, "from": "User",
        "print_settings_id": PROCESS_NAME, "compatible_printers": [PRINTER]}))

    # Old runs of this script wrote user filament presets; they crash the CLI
    # and are not needed. Remove them so a stale pair cannot get loaded.
    for stale in ("tiny_pla_black.json", "tiny_pla_white.json"):
        if (OUT / stale).exists():
            (OUT / stale).unlink()
            print(f"removed stale {stale} (see FILAMENT_SYSTEM comment)")

    # What actually changed, against the preset that printed the last case.
    was = resolve(presets, "0.20mm Standard @BBL X2D")
    print(f"process: {PROCESS_BASE} + {len(PROCESS)} overrides")
    for k in sorted(set(PROCESS) | {"layer_height"}):
        print(f"  {k:34} 0.20 Standard: {str(was.get(k, '-')):22} -> {proc[k]}")
    print("filament: stock", FILAMENT_SYSTEM, "x2 (colour lives in the project)")
    for p in written:
        print(f"wrote {p.relative_to(Path.cwd()) if str(p).startswith(str(Path.cwd())) else p}"
              f" ({len(json.loads(p.read_text()))} keys)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
