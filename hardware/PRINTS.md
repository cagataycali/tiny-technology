# tiny necklace — print files quick reference

Everything below v2.6 was sliced **PLA 0.20mm Standard, textured PEI, no
supports**. v2.6 moves to the **0.12mm jewelry profile** described at the
bottom of this file. Bambu X2D throughout.
On the printer SD (tap on the touchscreen) and in `hardware/cad/`.

## v2.9 — the cord it hangs from, 0.12mm (2026-08-02)

v2.8 opened a window in the crown and left the thing that goes through it
undesigned. v2.9 designs that: a **3mm cord wrapped once around the bar**, a
**groove across the crown** that keeps the wrap on the centre line, and a
**printed bead** that replaces the clasp. No metal, nothing bought but cord.

| file | what | status | weight | time |
|------|------|--------|--------|------|
| `cad/tiny_v29_vision_x1.3mf` | **v2.9 CURRENT** — 1 Vision case with the crown seat: tray + white 7-ring insert + door, two-color | open → `Slice plate` → `Print plate` | 7.63 g | 59m 54s |
| `cad/tiny_v29_vision_x2.3mf` | the same plate ×2 — one print for both new boards | open → `Slice plate` → `Print plate` | 14.91 g | 1h 57m 0s |
| `cad/tiny_v29_cordkit.3mf` | the cord kit: 3 sliding beads at 2.8 / 2.9 / 3.0mm bore, one colour | open → `Slice plate` → `Print plate` | 1.03 g | 15m 9s |
| `cad/tiny_v29_voice_x1.3mf` | 1 **Nicla Voice** case, same cord system, 9.5mm deep (`face="voice"`) | open → `Slice plate` → `Print plate` | 6.26 g | 48m 20s |
| `cad/tiny_v29_locket.3mf` | the **battery locket** (`bat=true`): tray + white mark + snap-on cell cover + door, 4 parts | open → `Slice plate` → `Print plate` | 14.67 g | 1h 36m 7s |

Every time in this file is the slice header's `model printing time`, and every
weight is the sum of its `total filament weight [g]` fields. Named, because the
same header also carries `total estimated time` 2 seconds longer, and this table
had one row quoted from each — a 2-second error that does not matter and a
mixed-provenance column that does, since the **+71s** seat cost below is a
difference between two of these numbers.

**Buy 60cm of 3mm cord** (waxed cotton or leather). That number is measured off
the hero render, not chosen: `tiny_full_necklace.scad` builds the loop as two
cubic Béziers and echoes its own arc length, and `check_fit.py hero` gates both
ends of it — **44.3cm worn** (collarbone) and **60.1cm of cord**, which has to
clear a ~57cm head *because a clasp-free necklace's longest setting is its whole
length*. Slide the bead up and every millimetre of the tails joins the loop; that
is the whole adjustment mechanism, and it is why the tails are 7cm and not trim.

- **THE CHAIN CANNOT ATTACH, and the old hero render lied about it.** The
  print-in-place chain from v2.1 has a 7.6mm inner link; to slip onto this bar it
  has to clear `hypot(bar_t, depth)` = **12.59mm**. Intersected as solids it is
  **22.0mm³ of interference in 5 places** — the render had been drawing an
  assembly nobody could assemble for two versions. A printed link that *would*
  fit needs OD ≥ 17.0mm (1.42× the current one), which is the argument for the cord
  rather than a bigger chain. `check_fit.py` now measures this instead of
  asserting it, on all three depths (Vision 12.59 / Voice 9.62 / locket 18.26).
- **The crown seat** (`cord_seat`, `seat_r 1.60`, `seat_d 0.9`, mouth **2.8775mm**)
  is a round-bottomed groove, cut in `body_slab()` so the tray's band and the
  door's band line up to the micron. Its mouth is **0.12mm narrower than the
  cord**, which stops the cord dropping into a slot and keeps the pendant hanging
  on the cord's own line instead of resting on a 10mm flat where it can wander and
  cant the pendant. It **locates the cord, it does not capture it** — this file
  said "snaps in and is captured" for three versions and that was never true.
  `seat_r = cord_d/2 + 0.1` puts the arc's centre **0.7mm outside** the crown, so
  the void is *widest at the mouth* and narrows all the way to the bottom: there
  is no undercut anywhere, and a cord never has to pass its whole diameter through
  the mouth, only the width of its own section at that height. It drops in
  clearing both corners by **0.059mm** and lifts straight out. The bead is what
  closes the loop. It runs **along Z — the print axis** — so it is a vertical groove in a
  vertical wall: no bridge, no overhang, nothing added to the plate. Cost: 0.9mm
  of the bar's 2.4, leaving 1.50mm (3.6 extrusions), 30.0 → **18.8mm²** of
  section at the groove's centre line. Measured against v2.8 by re-slicing both
  in the same session (**+71s**, 58m43s → 59m54s), because comparing against a
  figure recorded in an earlier session is how this repo has been fooled before.
- **The bead is the clasp.** `part="slider"` — 10.9 × 6.4 × 6mm, two bores on Z
  so it prints flat with no overhang, 1.7mm wall, 1.5mm web. Both cord halves
  pass through it *the same way*: pull the tails and the loop shrinks, push the
  bead down and it grows. Friction against a compressible cord is the one number
  arithmetic cannot settle, so the kit prints **three** at 0.1mm intervals and
  you keep the one that feels right — 0.2g and eight minutes against a reprint.
  `renders/v29_cordkit.png`, `renders/v29_seat_detail.png` (empty groove | cord
  seated in it), `renders/hero_full_necklace.png` (the whole 44.3cm necklace).
- **The Nicla Voice board wears the same necklace.** `tiny_v29_voice_x1.3mf` is
  `face="voice"` at depth **9.5** instead of 12.5 — a case for the board that is
  already on the desk, not the two in the post. The cord, the bead and the seat
  are *identical* because the seat is cut in `body_slab()` and sized off `cord_d`,
  not off the depth: one 60cm cord and one bead fit either pendant. What the
  shallower body costs is section, and `check_fit.py` gates that separately —
  22.8 → **14.2mm²** at the groove's centre line, still 1.50mm (3.6 extrusions)
  of bar under the cord. `check_seat.py` finds the groove on **58 of its 67
  layers** at full depth (the other 9 are the 1.2mm chamfer band, where it is
  meant to fade), free radius 1.567mm, taper 1.001mm/mm — the same numbers as the
  Vision plate, which is the point: the feature does not depend on the face.
- **The locket wears it too, and needed two parts to carry it.**
  `tiny_v29_locket.3mf` is `bat=true`: the same tray and door on a body
  stretched to 32.8 × 46.5, plus the snap-on cover that holds the JULi 402535
  cell (350mAh, 25 × 35 × 4.0). 4 parts on one plate — cover and white mark at
  the origin, tray at x −40 **dropped 5.8mm to the bed** (the locket tray's
  lowest z is 5.8 in the model: it is the *middle* slice of the body, and
  `mf3_pack` has to put it on the bed), door at +40. **14.67 g, 1h 36m 7s, 91
  layers.** The cord's groove runs down the tray *and continues onto the cover's
  rim*, because the seat is cut in `body_slab()` before either part is carved out
  of it — so the join is invisible to the cord. The one place it is not
  continuous is the tray's bottom 1.3mm, which the rabbet insets by 1.15mm so the
  cover's rim can grip it: there the *cover* carries the groove and the tray's
  crown is not even on the outside of the pendant. `check_seat.py --bat --part
  tray,cover` gates both stretches (75 of the tray's 91 layers, 39 of the cover's
  64, and 43.7 → **27.3mm²** of section at the groove's centre line — the locket
  is the thickest bar of the three, so the seat costs it the least).
  `renders/v29_locket_exploded.png` (door | tray | cover with the cell in its bay,
  the cord on the seat's own axis through all three) and
  `renders/v29_locket_back.png` (worn: the mark, the crown pocket, both tails).
  Both are composed from the baked STLs, and the cord in the back shot is drawn
  the way the seat actually works — **in one face and out the other**. Drawing one
  stub instead read as a pin stuck through the logo, which is a picture of a
  design the part does not have.

**Two new gates and three questions, because "the model has a hole" is not "the
print has a hole".** All of them read the sliced toolpath, and each was confirmed
to FAIL on a negative control before being trusted:

| gate | asks | passes at | fails on |
|---|---|---|---|
| `check_kit.py` | is each bead's bore open, and walled on every layer? | 2.75 / 2.85 / 2.95mm open vs 2.8 / 2.9 / 3.0 modelled, 49 of 49 layers | the case plate checked against the kit's bore coordinates: −0.40mm "open", 10 of 92 layers walled |
| `check_seat.py` | is the crown groove really cut, layer by layer? | free radius **1.567mm** (a 3mm cord needs 1.5); printed depth within **0.070mm** of the mesh's own cross-section on 87 layers; the printed crown 0.204–0.270mm under it (= lw/2) | the v2.8 plate, which has no seat: the mesh is 0.005mm deep on 0 of 91 layers, and offers 1.5mm of room on 3 |
| `check_seat.py` **E** | and does a 3mm **cord** actually reach the bottom of it? | the cord's underside seats **0.874–1.121mm** below the crown on 91 layers, against 0.892–1.095 for the mesh's sharp edges and 0.566–0.885 for the same mesh drawn in 0.42 beads | the same v2.8 plate (a cord reaches 0.9mm on 2 of 91 layers, so there is nothing to compare); a mouth pinched 0.5mm (seats **0.361mm** — the cord rides on the pinch); the groove cut 0.4mm past the mesh (seats 1.276 where the void ends at 1.095, i.e. the bar under it is thinner than `check_fit` gated) |

`check_seat.py` does not compare the toolpath to a formula. It slices the **mesh
inside the .3mf that was sliced** at each layer's own mid-layer height and
compares the two outlines, because the model takes the groove away in more than
one way and a checker that thinks it knows them all is wrong on the next version.
Two ways are already in the file: `body_ch = 1.2` tapers each face 1mm of Y per
1mm of Z, and the locket tray's rabbet band has no crown at all. The first draft
hard-coded the taper and **reported the rabbet as six failures on a good plate**.

Everything else is derived too: the crown's bed position and *which end* it is on
(a flipped `doorprint` has its crown at minimum Y), the crown's own height rather
than the part's (a door is 5.4mm of rim and 1.4mm of head — using the bbox
claimed 44 layers of crown and shouted about the 11 that are real), and **every**
part matching `--part`, since a two-case plate has two trays and `[0]` would have
halved the coverage. Five toolpath mutations of a passing plate, each caught by
the gate that names it: a filled groove (free radius 0.700, depth off by 0.898), a
**half**-depth groove (1.129, off by 0.408), a crown printed 0.3mm short
(crest 0.506–0.572 where half a line width is 0.21), a mouth pinched 0.5mm, and
the groove cut 0.4mm deeper than the mesh.

**Check E measures the cord, not the groove, and it changed what we believe about
this feature.** A and B say how much room the groove has and how deep it is cut;
neither is a number a 3mm cord can use, because the groove is widest at its mouth
(above) and what stops the cord is whichever it touches first — the arc's bottom
or the two mouth corners. Measured on the emitted toolpath, **the cord rests on
the mouth corners on 85 of 91 layers** and reaches 0.874mm rather than the 0.9 the
model draws: the seat is a two-line cradle, not a nest, on every plate in this
version (Vision ×1 and both copies of ×2, Voice, and the locket's tray and cover
all report the same 0.874–1.121). The bound is two-sided and both sides come off
the same mesh — too shallow is measured against the mesh drawn in beads (a pinched
mouth: the cord rides proud and can be pulled off the crown), too deep against the
mesh's sharp edges (the modelled void is as far as a cord can go if every modelled
bead is there; past that the groove ate bar that `check_fit` gated). Deriving the
cord's depth from the *fattened* probe radius instead of its true one read every
print 0.21mm deep — a 0.21 error against a 0.15 tolerance, which failed four
plates that are fine. E is not independently falsifiable by an intrusion: pinching
the mouth trips A as well, because A's inscribed circle is centred only 0.7mm
above the crown and almost anything that narrows the mouth also narrows that. What
E adds is the functional number and the one hazard nothing else names — a groove
printed deeper than it was modelled.

```sh
cd hardware/cad
python3 check_fit.py && python3 check_fit.py hero   # model + the render's geometry
for part in tray markskin doorprint; do
  openscad -o v29_vision_$part.stl --export-format binstl \
    -D "part=\"$part\"" -D 'face="mark2"' tiny_necklace_split.scad
done
# mf3_pack the 3 parts into ONE group, then:
python3 finish_3mf.py tiny_v29_vision_x1.3mf 128 124.5 --centre
python3 patch_project.py profiles/tiny_export_2slot.json tiny_v29_vision_x1.3mf \
        --colours "#000000,#FFFFFF"
/Applications/BambuStudio.app/Contents/MacOS/BambuStudio \
        --slice 1 --outputdir /tmp/s29case tiny_v29_vision_x1.3mf
python3 check_slice.py /tmp/s29case/plate_1.gcode --accent-stl v29_vision_markskin.stl \
        --copies 1 --project tiny_v29_vision_x1.3mf     # SLICE CHECKS PASS
python3 check_seat.py  /tmp/s29case/plate_1.gcode \
        --project tiny_v29_vision_x1.3mf                # SEAT CHECKS PASS
# and the kit (3 beads, one group, bore in each part NAME — check_kit reads it):
python3 check_kit.py /tmp/s29kit/plate_1.gcode --project tiny_v29_cordkit.3mf
# the locket is the same recipe with -D bat=true, part=cover for the 4th part,
# the tray packed at z -5.8, and the two flags check_seat needs to know it:
python3 check_seat.py /tmp/s29locket/plate_1.gcode \
        --project tiny_v29_locket.3mf --bat --part tray,cover
```

Three traps this version walked into, recorded so the next one does not:

1. **An OpenSCAD preview can silently drop a subtraction.** `door()` nests
   `difference(union(intersection(difference(…)))…)` deep enough that the cord
   window vanished in preview (OpenCSG) while `tray_faced()`, built from the same
   `body_slab()`, showed it. Half a session went into a geometry bug that did not
   exist. `--render` (CGAL) is correct — but CGAL PNG export drops `color()`, so
   every beauty shot here is now composed from CGAL-baked STLs pulled in with
   `import()`, which is a CSG leaf and cannot be dropped.
2. **`filament_density: 0`** in the settings Bambu's own `--export-settings`
   writes made the slice header read `total filament weight [g] : 0.00` — and
   `make_printable.py` copies that into the job the printer displays, so a plate
   that weighs a gram was recorded as weighing nothing. `patch_project.py` now
   fills in 1.24 g/cm³ per slot wherever the export left it empty (a real value
   in the export always wins). Every weight in this section is the slicer's, not
   arithmetic; the **v2.6–v2.8 plates predate the fix** and still show 0.00 g.
3. **Two exports of the same `.scad` are not byte-identical.** The tray's
   binary STL differs run to run (triangle order; CGAL is threaded) while its
   volume is identical to four decimals. So `md5` cannot prove a refactor changed
   no geometry — `stl_volume` can, and that is what proved hoisting `body_ch` out
   of `body_slab(ch=1.2)` was a no-op.

## v2.8 — no bail, seven-ring mark, sealed corners, 0.12mm (2026-08-02)

Three changes, all from looking at the printed v2.1 case: *"instead of using the
top circle, we can leave a space on the top of the case… also I want to change
the logo… and I noticed there are some corners of the case, they must be closed
smooth surface"*.

| file | what | status | weight | time |
|------|------|--------|--------|------|
| `cad/tiny_v28_vision_x2.3mf` | **v2.8** — 2× Vision case: tray + white 7-ring insert + door, two-color, own 0.12mm profile and both slots set. *Superseded by v2.9, which is this case plus the crown seat; printed once from this plate on 2026-08-02.* | open → `Slice plate` → `Print plate` | ~15.0 g | 1h 55m |
| `cad/tiny_v28_vision_x1.3mf` | the same, one case | superseded by `tiny_v29_vision_x1.3mf` | 7.65 g † | 58m 43s |

† computed from its 2462.25 + 104.14mm of filament at 1.24 g/cm³: this plate
predates the `filament_density` fix, so its own header says 0.00 g. Re-sliced in
the same session as v2.9 for the +71s comparison below.

- **The torus bail is gone.** The body is the same superellipse stretched to
  reach a head at y 20.0 and shifted +2.10 so its −Y edge does not move, with a
  12.0 × 3.4 stadium slot bored through it. One curve, no junction: 38.5mm tip
  to tip → **35.8mm**, the load path goes from ~7mm² of torus neck to 2.4 ×
  12.5 = **30mm²** of full-depth bar, and the plate finally slices with
  `warning_message: ''` — the ring was the *floating regions* notice on every
  plate since v2.1. `bail_style="ring"` restores it.
- **The mark is the seven-ring logo**, from the supplied SVG (7 × r30.39,
  11px stroke, 248.82 × 231.07 viewBox) scaled to `mark_w = 27` → ms 0.10851,
  so each ring is r 2.70..3.894 with a **1.194mm band** and a 9.60mm pitch.
  Same two-color inlay as before: `mark_z = 0.56`, `mark_clr = 0.12`.
- **The four corner reliefs are deleted.** They were r0.5 cylinders inherited
  from the v1 SQUARE cavity, and against this hulled cavity they sat entirely
  outside it — a sealed 1mm void with **0.258mm (0.6 extrusions)** of skin to
  the outside at each corner. The slicer cannot draw a 0.26mm wall, so it drew
  nothing: that is why the corners printed open and ragged. Cavity-to-outside
  is now 1.585mm (3.8 extrusions) and `check_fit.py` measures it.

**⚠ The colour defect this plate found, and the setting that fixes it.** The
first v2.8 slice printed the mark **black on layer 1** — the one layer that is
the visible face. Nothing was wrong with the model: the 1.194mm band was sliced
correctly into two widened walls, 1.93mm of filament per case, and handed to the
wrong extruder. The cause is that **the first extrusion of a print has no
`M1020` in front of it** — Studio only emits a toolchange when it wants a
different filament, so whichever region it schedules first on layer 1 silently
inherits slot 1. With `first_layer_print_sequence` on auto that scheduling turns
on the shape of the accent; bisected on matched plates:

| accent on layer 1 | layer-1 order | result |
|---|---|---|
| 7 solid discs | tray, then `M1020 S1` → accent | white ✅ |
| 7 thin rings | **accent first**, then `M1020 S0` → tray | black ❌ |

Ruled out on the way: ring count, the tray, the cord slot, a 0.12mm first layer
(the accent's own first layer went missing at every layer height) and band width
up to 2.0mm. `patch_project.py` now pins `first_layer_print_sequence` to
`["1","2"]`, which makes the accent a real toolchange instead of an inherited
default; layers above 1 stay on auto because they always have a preceding
change. Re-verified: accent on **all four** layers, z0.20=27.0mm, z0.32=16.4,
z0.44=16.5, z0.56=16.4 (the 0.2/0.12 height ratio, 1.64), against **zero** at
z0.20 before.

`renders/v28_layer1_colours.png` is the sliced layer 1 with slot 2 drawn in red:
seven closed rings per tray, black islands inside them, no accent on the doors.
That image is the whole verification — it is what was empty before.

`check_slice.py` is the gate for exactly this, and it has to derive the opening
slot rather than assume it — assuming cost a full session of contradictory
verdicts. Sum the extrusion under each assumption and keep the one that
reproduces the header's `; total filament length [mm]`; exactly one does, to
0.01mm. Two parser details or the sum will not close: `enable_arc_fitting` puts
extrusion in `G2`/`G3` as well as `G1` (1250mm of it here), and unretraction is
positive E with no X/Y/I/J and must not be counted (+1226mm if it is).

```sh
cd hardware/cad
python3 check_fit.py                      # must say ALL CHECKS PASS
for part in tray markskin doorprint; do
  openscad -o v28_vision_$part.stl --export-format binstl \
    -D "part=\"$part\"" -D 'face="mark2"' tiny_necklace_split.scad
done
# mf3_pack the 6 parts (2 x tray+markskin+doorprint) into ONE group
python3 finish_3mf.py tiny_v28_vision_x2.3mf 128 124.5
python3 patch_project.py profiles/tiny_export_2slot.json tiny_v28_vision_x2.3mf \
        --colours "#000000,#FFFFFF"
BambuStudio --slice 1 --outputdir /tmp/s28 tiny_v28_vision_x2.3mf
python3 check_slice.py /tmp/s28/plate_1.gcode --accent-stl v28_vision_markskin.stl \
        --copies 2 --project tiny_v28_vision_x2.3mf   # must say SLICE CHECKS PASS
```

## v2.7 — battery locket (Nicla Vision + 402535 LiPo), 0.12mm (2026-08-02)

The first case that carries its own power: a 3.7V 350mAh **402535** pouch
(4.0 × 25 × 35mm, measured off the cell's own label) stacked BEHIND the board,
so the pendant grows in Y and Z, not in silhouette-per-mm-of-battery.
**32.8 × 42.6 × 18.2mm**, 50.7mm tip to tip with the bail.

| file | what | status | weight | time |
|------|------|--------|--------|------|
| `cad/tiny_v27_batt.3mf` | **v2.7** — 1 complete battery locket: tray + white logo insert + snap-on battery cover + door, two-color, own 0.12mm profile and both slots set | open → `Slice plate` → `Print plate` | ~13.7 g | 1h 37m |

Four parts, one object group, `tiny_logo_ACCENT` → extruder 2 — same open-and-slice
deal as v2.6. Verified by slicing it headless: `layer_height 0.12`, `wall_loops 3`,
`elefant_foot_compensation 0`, `has_scarf_joint_seam 1`, `; filament: 1,2`,
4 × `M1020` at Z 0.20/0.32/0.44/0.56, **4494.96mm black + 104.05mm white**.
(The CLI prints `total filament weight [g] : 0.00` because the flattened preset
carries `filament_density: 0` — the grams above are computed from those lengths at
1.24 g/cm³. Studio's own number is the one to trust for a spool budget.)

Three things that are new against every earlier plate:

- **The logo moved to the battery cover.** The cover's outer face is now the back
  of the pendant, so the deboss + white insert live there; the tray's back is
  interior and blank. Same `mark_z = 0.56`, same `mark_clr = 0.12`.
- **The tray prints partition-face-down**, dropped 5.8mm in the plate so its
  bay ceiling is the bed-contact layer (`mf3_pack` position `[-38,-4,-5.8]`; the
  STL itself spans z 5.8..17.4 because it sits above the cover in the assembly).
  The wire channel shows up as a 7 × 8.1mm hole in that first layer — that is the
  route from the cell to J4, and its roof is a **7mm unsupported bridge** ~2.2mm
  up. It prints (this profile bridges 10mm), and it is why the slice reports
  ~115s of Bridge and a second *floating regions* notice besides the bail.
- **The cell is never in a printed part**, but `part="exploded"` and
  `part="section"` draw it where it lies (`cell_mock`), so a render can show the
  fit instead of asserting it. `renders/v27_batt_exploded.png`,
  `renders/v27_batt_section.png` (the section plane runs through the wire
  channel, x = 6.02, because that is the only place the route is visible),
  `renders/v27_batt_layer1.png` (the sliced first layer of all four parts).

No plug well: J4 (BM03B-ACHSS) is 1.45mm deep and the ESLOV connector next to it
already forces a 3.4mm gap under the PCB, so the mated plug costs **zero** depth.
The cell adds 5.7mm to the case, and that is all it adds.

```sh
cd hardware/cad
python3 check_fit.py                      # must say ALL CHECKS PASS
for part in tray doorprint cover markskin; do
  openscad -o v27_batt_$part.stl --export-format binstl \
    -D "part=\"$part\"" -D 'face="mark2"' -D 'bat=true' tiny_necklace_split.scad
done
# mf3_pack the four into ONE group: tray [-38,-4,-5.8], cover [0,0,0],
# markskin [0,0,0] (must share the cover's XY), doorprint [38,0,0]
python3 finish_3mf.py tiny_v27_batt.3mf 128 124.5
python3 patch_project.py profiles/tiny_export_2slot.json tiny_v27_batt.3mf \
        --colours "#000000,#FFFFFF"
```

Assembly: leads through the channel from the bay into the board space → plug
into J4 (**pin 1 = VBAT, pin 3 = GND; there is no reverse-polarity protection on
this board**) → board onto the ledge, USB edge over the ESLOV notch → door on
(open skirt edge over the camera edge, +Y) → cell into the bay → cover snaps on
±X, pry it off at the −Y scallop.

## v2.6 — 2 more Nicla Vision cases, 0.12mm (2026-08-02)

Two more boards ordered → one plate with **two complete two-color cases**
(tray + white logo insert + door, ×2):

| file | what | status | weight | time |
|------|------|--------|--------|------|
| `cad/tiny_v26_vision_x2.3mf` | **v2.6** — 2× Vision case, two-color, opens with the 0.12mm profile and both filament slots already set. SUPERSEDED by v2.8 (this one still has the torus bail) | open → `Slice plate` → `Print plate` | 16.2 g | 1h 27m |

Just open it: the file carries its own `project_settings.config`, so Studio
comes up on `tiny 0.12 jewelry @BBL X2D` with slot 1 black / slot 2 white and
the six parts already assigned (`*_ACCENT` → extruder 2). No preset to pick,
nothing to click but Slice/Print.

Regenerating it from scratch:

```sh
cd hardware/cad
python3 check_fit.py                      # gates the slice; must say ALL CHECKS PASS
for part in tray mark door; do
  openscad -o v26_vision_$part.stl --export-format binstl \
    -D "part=\"$part\"" -D 'face="mark2"' tiny_necklace_split.scad
done
# then pack the 6 parts (2x tray+mark+door) into one group with mf3_pack, and:
python3 finish_3mf.py tiny_v26_vision_x2.3mf 128 124.5    # centre + per-part extruders
python3 make_profile.py                   # profiles/tiny_fine_0.12.json
python3 patch_project.py profiles/tiny_export_2slot.json tiny_v26_vision_x2.3mf \
        --colours "#000000,#FFFFFF"       # settings + colours INTO the 3MF
```

`profiles/tiny_export_2slot.json` is just Bambu's own `--export-settings` dump
from a good 2-filament slice; regenerate it with
`BambuStudio --slice 0 --load-settings "<machine>;profiles/tiny_fine_0.12.json"
--load-filaments "<PLA Basic>;<PLA Basic>" --export-settings …` after changing
the profile, then re-run `patch_project.py`.

## earlier plates (0.20mm Standard)

| file | what | status | weight | time |
|------|------|--------|--------|------|
| `tiny_v2_black.gcode.3mf` | **v2.1 CURRENT** — all fit fixes (cavity +2, USB 14×5.2, battery-conn ledge notch, lens 6.8 + registration fence, antenna pocket), logo debossed | on SD — **print this one** | 5.9 g | ~27 min |
| `tiny_necklace_halo_white.gcode.3mf` | halo case v1 geometry — white | ✅ printed 2026-08-01; fit feedback → v2.1 | 5.9 g | ~28 min |
| `tiny_necklace_v1_black.gcode.3mf` | v1 geometry — SUPERSEDED by v2.1 | on SD, don't print | 6.0 g | ~27 min |
| `tiny_chain24_white.gcode.3mf` | 24 print-in-place chain links (~19 cm), brim on | on SD, unprinted | 2.2 g | ~26 min |

**Two-color (black case + white/red/blue "tiny 💎" on the back):** open
`cad/tiny_v2_blackwhite_model.3mf` in Bambu Studio → click `tiny_logo_ACCENT`
part → assign white/red/blue slot → slice. One model file serves all three.

**⚠ Two-color layer fix (2026-08-01):** the first blackwhite slice rendered
the logo as green/yellow checkered dashes (see after-slice.jpg) — the deboss
pocket and accent insert shared identical walls, so the slicer alternated
ownership per layer. Fixed in `tiny_necklace_split.scad`: pocket now offset
+0.12/side (`mark_clr`) from the insert. Re-export markskin/tray from the scad
if you regenerate. **v2.6 amends this:** the extra 0.06mm of pocket DEPTH that
came with that fix left the white plug loose once layers went to 0.12, so pocket
and insert now share one `mark_z = 0.56` and only the XY offset differs.
`check_fit.py --> check_deboss()` reads both modules out of the scad and fails
if either hardcodes its own depth.

**NICLA VOICE two-color:** `cad/tiny_voice_blackwhite_model.3mf` — voice case
(depth 10, mic grille, no camera/ToF/fence) with debossed back logo. Parts:
`voice_tray_BLACK` + `tiny_logo_ACCENT` (extruder 2) + `voice_door_BLACK`
(face-down). Open in Studio → assign accent slot → slice. Sources:
`voice_tray.stl`, `voice_door.stl`, `voice_markskin.stl` (all
`face="voice" depth=10`). Still CONCEPT until the Voice board is measured.

Model-only 3MFs (slice yourself in Bambu Studio):

- `cad/tiny_halo_model.3mf` — halo case print layout (what got printed)
- `cad/tiny_halo2_model.3mf` — **two-color** halo: `body_black` + `ring_white`
  parts. Open in Studio, click `ring_white` → white slot, slice. (These older
  files are not stamped as Studio projects, so the CLI does slice them as one
  filament — see gotcha 4 above for the fix.)
- `cad/tiny_v1_model.3mf`, `cad/tiny_split_plate.3mf`, `cad/tiny_chain_model.3mf`

Sources: `cad/tiny_necklace_split.scad` (printable tray/door; `face=` plain /
halo / halo2), `cad/tiny_necklace_lab.scad` (31 catalog faces, `design=`),
fit proof `cad/tiny_necklace_fitcheck.scad`, viewer `cad/tiny_halo_viewer.html`.

## the 0.12mm jewelry profile (`cad/make_profile.py`)

A pendant is jewelry printed face-down: both faces the wearer sees come off the
plate, so the finish is decided by the first layers and the outer wall, not by
the top solid. Against the 0.20mm Standard that printed v2.1–v2.5:

| | 0.20 Standard | tiny 0.12 jewelry | why |
|---|---|---|---|
| layer height | 0.20 | **0.12** | 5 layers across the 0.6 bail fillet instead of 3; also lands the accent inlay exactly on a layer boundary (0.20 + 3×0.12 = 0.56 = `mark_z`) |
| walls | 2 | **3** | 3.05mm of shell is available; snap sockets and bail root stop being 2-wall-thin |
| wall generator | classic | **arachne** | the logo ring is 1.4mm and the camera fence 0.95mm — classic quantises those and leaves a gap |
| sparse infill | 20% | **25%** gyroid | |
| top/bottom shell | 5 / 3 | **6 / 6** | |
| elephant foot | 0.15 | **0** | THE inlay setting: 0.15 shrinks the white insert's layer-1 contour while growing the black pocket, i.e. a ~0.3mm colour gap on the visible face |
| first layer speed | 50 | **30** | the first layer IS the logo face |
| outer wall | 200 | **50** | |
| seam | aligned | **scarf (`seam_slope_type = external`)** | on a squircle the seam is the one defect you cannot polish out |
| resolution | 0.012 | **0.008** | visible on a 6mm lens bore and a 4mm bail |

(The left column is the stock `0.20mm Standard @BBL X2D`. The plate that
actually printed on 2026-08-01 had already picked up arachne and
elephant-foot 0 from its own project, so those two rows are a change against the
preset, not against that print — its header is the reference: 0.20mm, 2 walls,
20% infill, outer wall 200, first layer 50.)

Cost of the pass, measured on this exact plate in Studio: **1h 27m / 16.2 g**
against **37m 44s / 12.2 g** at 0.20mm Standard (the extra grams are the prime
tower, which the 0.20 slice never built because it only had one slot loaded).
Verified in the sliced
G-code header, not in the preset file — `layer_height = 0.12`, `wall_loops = 3`,
`has_scarf_joint_seam = 1`, `elefant_foot_compensation = 0` — and the layer-1
toolpath re-checked for closed logo loops (`gcode_preview_png` on the first
layer alone, per the checkered-dash lesson above).

Five things this cost a day to learn about Studio 02.08:

1. **The CLI does not follow `inherits` in a preset.** A user preset that says
   `inherits: 0.12mm High Quality` and overrides five keys slices at **0.20mm**
   — only the keys physically in the file are applied, silently. That is why
   `make_profile.py` flattens Bambu's whole chain instead of writing a diff.
2. **`filament_colour` in a user filament preset segfaults it** (rc=139), and
   two flattened filament presets loaded together abort it (rc=133). Colour is
   a project property; it belongs in `project_settings.config`. There are now no
   custom filament presets at all.
3. **Scarf seam cannot be set from the filament preset.** `filament_scarf_*`
   values are accepted and then reset to `none`; the pair that works is process
   `override_filament_scarf_seam_setting = 1` + `seam_slope_type = external`.
4. **Studio ignores an embedded `project_settings.config` unless the 3MF claims
   to be its own.** `3D/3dmodel.model` needs
   `<metadata name="Application">BambuStudio-…</metadata>`; without it the plate
   opens as plain geometry under whatever preset was last used (measured: 0.20mm
   Standard, one filament slot). `patch_project.py` stamps it.
5. **Once stamped, the flush tables have to match the slot count — n×n PER
   EXTRUDER.** Bambu exports them at the editor default of 4 slots (16-entry
   matrix, 8-entry vector); a 2-slot project needs an 8-entry matrix on this
   machine, two 2×2 blocks concatenated, or the slice dies on *"Flush volumes
   matrix do not match to the correct size!"*. One 2×2 block passes the CLI and
   is the worse bug: Studio zero-fills the second block and warns *"Partial
   flushing volume set to 0. Multi-color printing may cause color mixing"* —
   0mm³ of purge on the black→white change, i.e. grey rings on the visible face.
   Measured in Studio's own `BambuStudio.conf` after opening such a plate:
   `flush_volumes_matrix: 0|280|280|0|0|0|0|0`. `flush_multiplier` is per
   extruder too. Same story for `filament_map`: slot 2 on extruder 2 fails on
   this machine (the auxiliary is a Bowden with no matching nozzle-volume
   variant), so every slot maps to the main nozzle — which is what Studio's Auto
   For Flush picks anyway.
6. **The first extrusion of the print has no toolchange, so layer 1 hands
   itself to slot 1.** `first_layer_print_sequence` must be pinned or the accent
   colour is decided by whatever region the slicer happens to schedule first —
   see the v2.8 section, where that cost the mark its visible face.

**And the payoff: the CLI now DOES slice two colors per part.** The old note
below ("the CLI can't assign filaments per part") was true only for unstamped
3MFs — it ignored `model_settings.config` along with everything else. With the
Application stamp in place, `plate_1.gcode` comes out with
`; filament: 1,2`, `filament_colour = #000000;#FFFFFF` and four `M1020`
toolchanges: **4398.35mm black + 142.14mm white** (re-measured 2026-08-02 with
the flush tables and the first-layer order fixed). Four changes is **not** four
accent layers — they land at Z 0.20 →slot 2, 0.32 →slot 1, 0.44 →slot 2,
0.56 →slot 1, so each white run straddles a layer boundary and carries two
layers of inlay. Count extrusion per layer, never toolchanges; `check_slice.py`
does. The GUI is no longer required to get the colours right — only to send the
job, since the printable container's `slice_info.config` still has to carry both
filament entries.

Two Studio notices on this plate are expected: *"arc fitting automatically
disabled"* and *"floating regions"* (the bail overhang, which has printed clean
since v2.1 — and which v2.8 removes: that plate slices with
`warning_message: ''`). The arc-fitting notice is about the *dialog default*,
not about the slice: the header of every plate here says
`enable_arc_fitting = 1` and the G-code carries **27,590 `G2`/`G3` moves** with
1250mm of extrusion in them. Anything that counts filament out of `G1` alone
undercounts by that much — the mistake that first made this plate's colour
accounting disagree with its own header.
Both filaments land on the main nozzle because the auxiliary AMS is not
installed, so there is a ~3g prime tower for the 4 accent layers;
`prime_tower_width` (60) is the knob if that ever matters.

Assembly: board onto the ledge (USB edge over the ledge notch) → USB plug in
through the off-center bottom mouth → door on with the OPEN skirt edge over
the camera edge (+Y), snaps click on ±X. Reset via 1.5 mm pinhole right of
the lens. Remote print-start stays blocked until Developer Mode is enabled on
the printer screen (Settings → General); files are tap-to-print meanwhile.
