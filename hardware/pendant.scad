// tiny necklace — PRINTABLE two-part split of the slim squircle body.
// The engineering base every catalog face bolts onto: snap-fit door + tray,
// mechanics ported from tiny_necklace_case.scad v1 (ledge, snaps, reliefs).
//
//   part = "tray"      cavity, PCB ledge, USB mouth, bail — prints open-side up
//   part = "door"      1.4 face plate + snap skirt, camera cone, mic — prints
//                      face-down on smooth PEI (texture variants engrave here)
//   part = "cover"     bat=true only: the cell bay + snap-on back — prints
//                      logo-face-down at the origin
//   part = "exploded"  assembly view for review
//   part = "print"     both parts laid out for one plate
//
// Envelope: cavity 23.5² x 10 @ z1.3, depth 12.5 slim, USB -Y below-PCB,
// camera (+2.54,+7.70) mirrored on the door, mic (-8,-6), no battery.
// bat=true stretches the body (mostly in Y) and adds a third part underneath — see
// the BATTERY block below. Everything with bat=false is untouched by that mode.

part = "exploded"; // ["tray", "door", "exploded", "print"]
col  = "#0078BF";
col2 = "#ffffff";  // accent color for the back mark (white/red/blue renders)
face = "plain";    // ["plain", "halo", "halo2", "mark2", "voice"] — voice:
                   // NICLA VOICE case (no camera/ToF/fence, mic grille,
                   // thinner: render with -D depth=10). ⚠ CONCEPT until the
                   // Voice board is measured: mic/LED/reset positions TBD,
                   // USB assumed same as Vision (Nicla family layout) — mark2: plain door,
                   // backmark deboss in the tray, white insert exported via
                   // part="markskin" (two-color: black case, white tiny logo) — halo2: THROUGH ring void,
                   // white skin exported separately (part="ringskin") for a
                   // two-color AMS door (black body, white glow ring) — halo: inside-cut glow ring around the
                   // lens (0.6 skin, LED ring-light through white PLA) +
                   // "tiny 💎" backmark debossed in the tray floor (prints as
                   // crisp first-layer text). Both stay face-down printable.

/* [Envelope — DIGITAL-CALIPER MEASURED from ABX00051 STEP, 2026-07-31.
   Board coords: PCB center origin, PCB TOP = board z0, USB edge = -Y.
   PCB 22.86 x 22.86 x 0.946. Deepest bottom part 2.95 below PCB bottom
   (ESLOV, see the note on the -Y notch); USB shell x -8.81..-0.01,
   z 0.75..3.70 below PCB top,
   protrudes 1.31 past the -Y edge. Camera lens (-2.55,+7.84) top z+5.08;
   mic (top-port) (-7.63,+8.03); ToF VL53L1X (-3.20,+3.17) 4.9x2.5;
   reset button (+2.40,+8.67). */
// v2 (2026-08-01, USER FIT FEEDBACK from printed white halo case):
//  - cavity +2mm ("couple mm bigger so I can put the chip without breaking")
//  - USB mouth wider + taller ("bottom of the port entry a bit bigger")
//  - ledge widened to keep a seat under the larger cavity, and its -Y notch
//    now clears BOTH the USB shell AND the 5-pin ESLOV connector (x 1.3..8.3,
//    hangs 2.95 below PCB — it was fouling the v1 ledge: likely THE tightness)
//    ⚠ 2026-08-02: this notch was documented for six days as clearing the
//    "battery connector". It does not — measure_step.py identifies the solid on
//    that edge as SM05B-SRSS-TB, the ESLOV. The real battery connector J4 is a
//    BM03B-ACHSS at (+6.02,+5.87), MID-BOARD, only 1.45 below the PCB. The
//    notch geometry was right for the wrong reason; the battery wire route in
//    the BATTERY block below is built on the corrected position.
//  - float tolerance: cavity gives the board ±1.3mm side play, so ToF/mic/
//    reset holes are enlarged to stay clear at any position
pcb_xy   = 22.86;   // MEASURED PCB footprint — identical on Vision and Voice
cav      = 25.5;

/* [BATTERY — v2.7, 2026-08-02.  bat=true turns the pendant into a locket:
   the same tray and door, on a stretched body, with a snap-on back that
   carries the cell.

   THE CELL, read off its own label (photo ~/Desktop/battery-size-nicla.jpeg):
   JULi 402535, 3.7V 350mAh 1.295Wh, date code 20250423. The part number IS
   the size: 40 -> 4.0mm thick, 25 -> 25mm wide, 35 -> 35mm long. Two wires
   (red/black) leave one 25mm short edge under an orange kapton fold. Sanity
   check on the decode: 1.295Wh in 3.5cm3 is ~370Wh/L, right for a LiPo pouch,
   so the numbers are self-consistent rather than just plausible.

   WHY THE BAY IS IN THE COVER AND NOT THE TRAY. As a pocket in the tray's
   back it would print as a ceiling over the below-PCB zone: supports, on the
   one face that is jewelry. As its own part the bay prints as an open dish,
   visible face on the plate — which is also where the two-color logo wants to
   be, so the mark moves here from the tray.

   WHY THERE IS NO PLUG WELL. J4 is a BM03B-ACHSS at (+6.02,+5.87) and hangs
   1.45mm below the PCB — mid-board, and less than half the 3.4mm below-PCB
   budget the ESLOV already forces. A mated ACHR-03V-S adds nothing vertical.
   So the connector costs zero depth; what it costs is a WIRE ROUTE, because
   it is nowhere near an edge.

   THE WIRE ROUTE COSTS NO LENGTH EITHER, which is the one non-obvious move
   here. The obvious design gives the tab its own well past the end of the cell
   plus a dam to stop the cell entering it — 3.4mm of extra pendant. But the
   cavity is only 25.5 long while the bay is 36.0, so above the bay's +Y end
   sits 9mm of SOLID tray wall, and a channel carved up into that costs
   nothing but its own void. So: cell tab -> up into a channel in the bay's
   ceiling -> -Y along it -> through the partition where the channel crosses
   into the cavity -> under the PCB to J4, 5mm away.
   Plug the cell in BEFORE the board goes on the ledge. J4 pin 2 is an optional
   NTC; a 2-wire cell leaves it open. J4 has NO reverse-polarity protection —
   check red/black against the silkscreen. */
bat      = false;   // ["false", "true"] — battery locket
cell_x   = 25.0;    // \ 402535, off the label. NOT a guess and NOT a caliper
cell_y   = 35.0;    // | reading of one sample: the pouch's own part number.
cell_t   =  4.0;    // /
bat_swell = 0.6;    // pouch cells gain thickness with cycles — this is the one
                    // clearance that must not be tight, or the cover bows
bat_clr  = 1.2;     // XY slack, total (0.6/side): pouches are cut, not moulded
bay_x    = cell_x + bat_clr;        // 26.2
bay_y    = cell_y + 1.0;            // 36.0
bay_z    = cell_t + bat_swell;      // 4.6
// Bay corner radius, and the reason this file grew a bat_wall below it.
// The first pass set r=3.0 because that measured 1.25mm of wall to the squircle
// against 0.86 at r=2 — and it was measuring the wrong pair of shapes. A bigger
// radius pulls the POCKET's corner in, and the cell's corner is square: at r=3
// a 25x35 pouch overlapped the bay by 0.607mm radially per corner. Boolean:
// 6mm^3 of interference, i.e. the cell could not be seated at all, while every
// bounding-box clearance check read fine. So r is bounded ABOVE, by the cell:
//   clearance = r - hypot(r - (bay_x-cell_x)/2, r - (bay_y-cell_y)/2) >= 0
// which at these slacks caps r at ~1.75. Wall then has to come from the shell
// instead of from the pocket, hence bat_wall — 3.3mm of material around the bay
// puts 1.13mm (2.7 extrusions) at the thinnest point, and costs 1.2mm of pendant.
bay_r    = 1.6;
bat_wall = 3.3;     // shell around the bay. NOT the wall you get: the squircle's
                    // corner is nearly square, so 3.3 of shell reads 1.13 at the
                    // corner. check_fit sweeps it numerically; do not eyeball it.
cover_t  = 1.2;     // cover floor = the visible back face (carries the logo)
part_t   = 1.2;     // partition: the tray's floor, all that is between the
                    // cell and the board's bottom-side components
cover_h  = cover_t + bay_z;         // 5.8 — the cover owns z 0..cover_h
cover_lip = 2.0;    // the cover's rim wraps UP over a rabbet in the tray, so
                    // the seam is a flush butt joint, not a visible step
rab_t    = 1.0;     // lip thickness = how much the tray is inset to take it
rab_c    = 0.15;    // per-side slip fit, same value the door skirt uses
// The wire route, in board coords. wire_x is J4's MEASURED centre.
wire_x   = 6.02;
wire_w   = 7.0;     // 2 x 26AWG is ~2.2mm of wire; the rest is fingers
chan_y0  = 10.0;    // the channel runs 2.75 PAST the cavity wall so it breaks
                    // through the partition, under the PCB's +Y edge
chan_y1  = bay_y/2 + 0.1;   // 18.1 — just past the cell's +Y edge, so the tab
                            // fold has somewhere to sit as well
chan_h   = 2.2;     // above the bay's ceiling. Stops 1.6 below the ledge ring's
                    // underside, and its roof is a 7mm bridge — no supports

cav_z0   = bat ? cover_h + part_t : 1.3;
// The Voice has no camera tower (tallest top part +1.50 vs the Vision's
// +5.08), so its case is 3mm slimmer — 9.5mm total. Same cavity floor and
// below-PCB budget; only the headroom above the PCB shrinks.
cav_h    = (face == "voice") ?  7.0 : 10.0;
// 18.2 = cover 1.2 + bay 4.6 + partition 1.2 + below 3.4 + PCB 0.946
//      + camera 5.08 + door 1.4, with the remaining 0.374 as lid clearance.
// The cell adds 5.7mm to the pendant, not the ~7 a plug well would have cost.
depth    = bat ? 18.2 : (face == "voice") ?  9.5 : 12.5;
below    = 3.4;     // bottom parts reach 2.95 below PCB bottom, +0.45
                    // (that 2.95 is the ESLOV; J4's mated plug needs only 1.45)
lens_x   = -2.55;   // MEASURED (sign was flipped before — not 1:1)
lens_y   = 7.84;
// v2.5: every face hole shrinks to part + 0.15 float + 0.25 print, because the
// v2.4 ribs removed the +/-1.32mm board float the old oversized holes existed
// to absorb. Oversizing was not free: at d6.8 + 1.0 cone the lens opening read
// 10.6mm at the face and swallowed the mic, ToF and reset holes (see visor).
// THE BINDING CONSTRAINT, measured: the camera barrel's -Y edge is at y 5.19
// and the ToF package's +Y edge at y 4.42 — the two parts are 0.77mm apart.
// So NO pair of holes that each cover a whole part can leave 2 extrusions of
// wall between them; the v2.4 face had them fused into one ragged blob. The
// resolution is that the ToF does not need its whole 2.5mm-tall package
// exposed, only its two ~1.0mm optical apertures, which sit centred on that
// dimension. A 1.5-tall slot clears them (0.25 margin after rib float) and
// buys 0.87mm of wall to the lens. Every number below is solved against that.
lens_d   = 5.8;    // barrel 5.3 + 0.25/side, now that ribs locate the board
cone     = 0.15;   // deburr chamfer only — 1.0 of flare was what ate the wall
mic_x    = -7.63;   // MEASURED (was wrong quadrant)
mic_y    = 8.03;
mic_d    = 1.6;    // top port is ~1.0 square; 0.3/side after ribs
tof_w    = 5.5;    // aperture pair span 4.0 + margin, inside the 4.9 package
tof_h    = 1.5;    // APERTURES only, not the package — see the note above
rst_d    = 1.6;    // pinhole: a paperclip is 0.9, pad is 2.6 x 3.05
usb_cx   = -4.41;   // MEASURED: USB is OFF-CENTER (shell x -8.81..-0.01)
usb_w    = 14.0;    // shell 8.8 + generous plug overmold clearance (v2)
usb_h    = 5.2;
tof_x    = -3.20;   // MEASURED: ToF needs a window or it ranges the door
tof_y    = 3.17;
rst_x    = 2.40;    // MEASURED: reset button service pinhole
rst_y    = 8.67;

/* [NICLA VOICE — DIGITAL-CALIPER MEASURED from ABX00061 STEP, 2026-08-01.
   Same convention: PCB centre origin, PCB TOP = z0, USB edge = -Y.
   PCB 22.86 x 22.86 x 0.95 — IDENTICAL footprint to the Vision, so the
   tray/bail/snap/ledge geometry is shared verbatim. What differs:

     NO camera, NO ToF -> those ports must not be cut.
     Vertical envelope is FLATTER: highest top part +1.50 (the Vision's
     camera tower reached +5.08); deepest bottom part -3.90.
     -> the Voice case loses 3mm of depth (voice_depth below).

   Measured parts (board coords):
     USB micro-B  ZX62-AB-5PA  x -8.81..-0.01  y -12.74..-7.14  z -3.70..-0.75
                  => cx -4.41: the SAME off-centre x as the Vision, so the
                     existing USB mouth carries over unchanged.
     RGB LED      SMLP34RGB    cx -9.89  cy 9.89  z 0..0.20  (1.0 x 1.08)
                  => far +Y/-X CORNER. A centred glow window would have
                     missed it completely.
     Reset button PTS830GM140  x -8.88..-6.28  y 6.51..9.56  z 0.05..0.90
                  => cx -7.58 cy 8.03 — which is where the VISION's mic sits.
     Battery conn SM05B-SRSS   x 1.30..8.30  y -11.10..-6.15  z -3.90..-0.94
                  => same -Y ledge-fouling risk as the Vision; notch applies.
     3-pin conn   BM03B-ACHSS  cx 6.12 cy 5.87  z -2.40..-0.95 (bottom)
     BLE module   ANNA-B112    6.5 x 6.5 x 1.15, cx -2.81 cy 6.99 (top) —
                  the radio+antenna can; keep the shell thin over it.
     Flex conn    FH33-4S      cx 6.55 cy -9.79  z -0.02..1.20 (top)
   MIC: the IM69D130 is a bottom-port MEMS part with no separately named
   solid in the STEP, so the grille stays a small hole cluster rather than
   one aimed port — sound reaches it through the cavity either way. */
voice_led_x  = -9.89;   // MEASURED RGB LED — corner, not centre
voice_led_y  =  9.89;
voice_rst_x  = -7.58;   // MEASURED reset button
voice_rst_y  =  8.03;

/* [Split mechanics — from v1 case] */
door_t   = 1.4;     // face plate
// The snap skirt hangs off the door underside INTO the tray, so it must stop
// above the seated PCB (top face 5.646 = cav_z0 + below + 0.946). At the
// Vision's 12.5mm depth a 4.0 skirt clears by 1.45mm — but on the 9.5mm Voice
// case that same skirt reaches 1.55mm INTO the board: the lid could never
// close, and forcing it would crack the PCB. So it is derived, not fixed.
skirt_h  = min(4.0, depth - door_t - (cav_z0 + below + 0.946) - 0.35);
skirt_c  = 0.15;    // per-side skirt clearance
ledge    = 2.5;     // PCB ledge ring width (seat = ledge - 1.32 float)
snap_h   = 0.4;     // snap bump radius
snap_len = 7.0;

$fn = 48;

// The outer form. The slim case is unchanged from every printed version. The
// locket is sized OUTWARD FROM THE BAY in both axes — bat_wall all round —
// because the cell is 25 wide against the board's 22.86, so X is no longer set
// by the cavity either. 32.8 x 42.6 against the slim 31.6 x 31.6: the extra
// millimetre of width is what buys a printable wall at the bay's corners.
body_ax  = bat ? bay_x/2 + bat_wall : 15.8;  // 16.4 -> 32.8 wide
body_ay  = bat ? bay_y/2 + bat_wall : 15.8;  // 21.3 -> 42.6 tall

/* [BAIL — v2.8, 2026-08-02, USER: "instead of using the top circle, we can
   leave a space on the top of the case so we can eliminate the extra part".

   The torus is gone. In its place the body grows a HEAD and the cord passes
   through a slot cut in it — one form, no bolted-on ring. Three reasons this is
   the better part and not just the better-looking one:

     * IT IS SHORTER. The ring stood 5.1mm of radius off a 3.0mm neck at
       y 17.6, so the slim pendant measured 38.5mm tip to tip. The head tops out
       at 20.0 -> 35.8mm, and the locket goes 50.7 -> 46.6. Nothing protrudes.
     * IT IS STRONGER. The load used to run through the torus's 3.0mm cord
       (~7mm^2 at the neck). It now runs through a bar the FULL DEPTH of the
       case: 2.4 x 12.5 = 30mm^2, in the direction the layers are stacked
       flat rather than across a printed overhang.
     * IT PRINTS WITH NO OVERHANG AT ALL. The pendant lies face-down, so a slot
       whose axis is Z is just a hole the layers walk around — while the ring
       was the one feature that made Studio warn about floating regions on
       every plate since v2.1.

   WHY THE HEAD IS NEEDED, i.e. why the slot cannot go in the case we have: at
   +Y there is exactly body_ay - cav/2 = 3.05mm of wall between the cavity and
   the outside. A 3.4 slot in it would leave two 0.8mm skins — under 2
   extrusions, so the slicer would drop one. So the slot is placed in material
   that is added ABOVE the internal void instead of taken from around it, and
   every dimension below is measured off that void's top edge (the cavity at
   12.75, or the cell bay at 18.0 on the locket).

   The head is part of body_2d(), so tray, door and cover all inherit it and the
   silhouette has no step and no new seam — the parting line stays where it has
   always been, on the rim, invisible from the front. The slot is cut in
   body_slab(), which is what every part is carved from, so tray and door share
   one bore to the micron and the cord cannot catch on a step. */
bail_style = "slot";  // ["slot", "ring"] — "ring" restores the v2.x torus
slot_w   = 12.0;    // cord opening, X, including its rounded ends
slot_t   = 3.4;     // cord opening, Y: a 3.0 cord or a 3.4 chain link, loose
slot_wall = 1.45;   // material between the slot and the top of the inner void
bar_t    = 2.4;     // material above the slot — 5.7 extrusions of bail
slot_ch  = 0.4;     // the bore flares this much at both faces, so the cord
                    // bears on a 45 chamfer instead of a printed edge
void_top = bat ? bay_y/2 : cav/2;      // 12.75 slim / 18.0 over the cell bay
slot_y0  = void_top + slot_wall;       // 14.20 / 19.45
slot_y1  = slot_y0 + slot_t;           // 17.60 / 22.85
head_top = slot_y1 + bar_t;            // 20.00 / 25.25
// HOW THE HEAD IS MADE, after two rejected attempts that are worth the four
// lines it takes to record them. The slot needs material above the cavity, so
// the outline has to reach head_top instead of body_ay — and the obvious ways to
// get there both look wrong on the bench:
//   hull(body, small squircle on top)      -> the bridge is a straight tangent
//                                             on an already-flat flank: two
//                                             creases, and the silhouette reads
//                                             as a jerrycan handle.
//   union then a morphological closing     -> a fillet, but at any radius big
//     (offset(+f) then offset(-f))            enough to see it has swallowed the
//                                             neck and is a hull again.
// So there is no head as a separate feature at all: the body is the SAME
// superellipse, stretched to reach head_top and shifted up by exactly the amount
// that leaves its -Y edge where it already is. One curve, no junction, nothing
// to crease — and the -Y half is untouched, which matters because the USB mouth
// is a tunnel through it and every millimetre added there is plug reach lost.
body_ay2 = (head_top + body_ay)/2;     // 17.90 slim / 23.28 locket
body_cy  = head_top - body_ay2;        // 2.10 / 1.98 — the shift, +Y only
// scratch bounds for intersections/differences: outside the form, nothing more
out_x    = body_ax + 3.2;
out_y    = max(body_ay, bail_style == "slot" ? head_top : body_ay) + 5.2;
module bound(z0, z1){
    translate([-out_x, -out_y, z0]) cube([2*out_x, 2*out_y, z1-z0]);
}

module squircle_2d(ax=15.8, ay=15.8, n=4){
    polygon([for (t=[0:3:357])
        [ax*sign(cos(t))*pow(abs(cos(t)), 2/n),
         ay*sign(sin(t))*pow(abs(sin(t)), 2/n)]]);
}

// The outline. One superellipse either way — the slot case just uses the taller,
// shifted one (see body_ay2/body_cy), so 31.6mm wide, the corner curvature and
// the whole -Y half are bit-for-bit what has printed since v2.1.
module body_2d(){
    if (bail_style == "slot")
        translate([0, body_cy]) squircle_2d(body_ax, body_ay2);
    else squircle_2d(body_ax, body_ay);
}

// The cord opening: a stadium, slot_w long including its rounded ends.
module slot_2d(){
    hull() for (i=[-1,1])
        translate([i*(slot_w - slot_t)/2, (slot_y0 + slot_y1)/2]) circle(d=slot_t);
}

module cord_slot(){
    // Flared slot_ch at both faces. Going up the bore narrows over 0.4mm (a 45
    // overhang, which prints), and past depth-0.4 it opens again (no overhang at
    // all) — so the chamfer that saves the cord costs the print nothing.
    hull(){
        translate([0,0,-0.01]) linear_extrude(0.01) offset(slot_ch) slot_2d();
        translate([0,0,slot_ch]) linear_extrude(depth-2*slot_ch) slot_2d();
        translate([0,0,depth-0.01]) linear_extrude(0.01) offset(slot_ch) slot_2d();
    }
}

// The face chamfer, hoisted out of body_slab()'s signature because it is not a
// styling detail any more: it tapers the crown by 1mm of Y per 1mm of Z, so it
// is what makes the cord seat FADE OUT near the faces instead of notching the
// silhouette — and check_seat.py has to know where that taper ends before it
// can say which sliced layers are supposed to show a full-depth groove. A
// default argument is invisible to part="values", so it lives here instead.
body_ch = 1.2;
module body_slab(ch=body_ch){      // full outer form (both parts carved from it)
    difference(){
        hull(){
            linear_extrude(0.01) offset(-ch) body_2d();
            translate([0,0,ch]) linear_extrude(depth-2*ch) body_2d();
            translate([0,0,depth-0.01]) linear_extrude(0.01) offset(-ch) body_2d();
        }
        // one bore for every part carved out of this slab: the tray's head, the
        // door's plate over it and (on the locket) the cover all line up
        if (bail_style == "slot") cord_slot();
        // v2.9: and one seat, cut here for the same reason — the cord crosses
        // the crown over both the tray's Z band and the door's, so a groove cut
        // per part could not line up. Defined after this module (crown_seat is
        // a module, so OpenSCAD's whole-file scope makes the forward use legal).
        if (bail_style == "slot" && cord_seat) crown_seat();
    }
}

module cavity(){
    translate([0,0,cav_z0]) hull() for(i=[-1,1], j=[-1,1])
        translate([i*(cav/2-2), j*(cav/2-2), 0]) cylinder(r=2, h=cav_h+2);
}

// ---- the old torus, kept for bail_style="ring" --------------------------------
// Everything from here to module bail() is dead unless bail_style is switched
// back. It is kept because it is the only record of what the ring cost: three
// derived numbers and two asserts, all of them about a part that hangs in air
// outboard of the body. The slot needs none of them.
//
// Chain bail. The section scales with the case: cord 3.0 / ID 4.2 at 12.5mm
// depth, cord 2.4 / ID 4.0 at 9.5mm (still a 4mm hole — any chain fits).
bail_cord = (depth < 11) ? 2.4 : 3.0;
bail_id   = (depth < 11) ? 4.0 : 4.2;
// The ring is UNIONED onto the tray unclipped, so where it crosses the body
// outline its material has to fit the z band the TRAY owns: bail_lo (0, or the
// top of the cover's rim once there is a battery under it) up to the door plane.
// Two things make that band the real constraint rather than the case depth:
//   - the torus is only 2*sqrt(bail_r^2 - dy^2) tall AT the body edge, not 2*r
//   - the door is a separate part, so anything above depth-door_t is a collision,
//     not just thin wall
// The old rule (bail_r <= depth/2) got both wrong and passed a Voice case whose
// ring overlapped its own door by 0.3765mm^3 — measured by boolean, not renders.
// Standing the ring off further is what buys clearance; thinning it is not:
//   vision  12.5 deep, band 0..11.1, centre 6.25: dy 1.8 -> 9.54 tall, fits 11.1
//   voice    9.5 deep, band 0..8.10, centre 4.75: dy 1.8 -> 8.03 tall, needs 6.7
//                                                  dy 3.0 -> 6.44 tall, fits
//   battery 18.2 deep, band 7.8..16.8, centre 12.3: dy 3.0 -> 8.25 tall, fits 9.0
// The battery case is the one where the ring cannot be centred on the pendant:
// centring it at 9.1 would need dy≈5.0 to clear the cover, i.e. a 5mm neck on a
// thin stalk. 12.3 sits the ring in the tray, which is also what carries the load.
bail_r  = (bail_id + bail_cord)/2 + bail_cord/2;      // torus outer radius, 5.1
bail_lo = bat ? cover_h + cover_lip : 0;              // lowest z the tray owns
bail_dy = (bat || depth < 11) ? 3.0 : 1.8;            // stand-off from the body
bail_y  = body_ay + bail_dy;    // 17.6 on the slim Vision case, unchanged
bail_z  = bat ? (bail_lo + depth - door_t)/2 : depth/2;
bail_hy = sqrt(bail_r*bail_r - bail_dy*bail_dy);      // half-height at the body
if (bail_style == "ring") {
    assert(bail_z - bail_hy >= bail_lo - 1e-6,
           "bail's lower limb hangs below the tray — it would fight the cover/face");
    assert(bail_z + bail_hy <= depth - door_t + 1e-6,
           "bail's upper limb breaches the door plane — the door will not seat");
}
// The slot's own invariants. These are the ring's two asserts replaced, not
// dropped: same job (a feature that carries the chain must not eat a part it
// does not own), different geometry. check_fit.py measures the walls the arc
// makes against the real hull; these two are the ones pure arithmetic can see.
// The outline's half-width at a height y — the superellipse solved for x, which
// is what says how much wall the slot's upper corners have.
function body_x_at(y) = body_ax *
    pow(max(0, 1 - pow(abs(y - body_cy)/body_ay2, 4)), 0.25);
if (bail_style == "slot") {
    assert(slot_y0 >= void_top + 3*0.42 - 1e-6,
           "cord slot cuts into the wall over the cavity/bay — under 3 extrusions");
    assert(bar_t >= 3*0.42 - 1e-6,
           "the bar above the cord slot is under 3 extrusions — it carries the pendant");
    assert(body_x_at(slot_y1) - slot_w/2 >= 2*0.42,
           "cord slot is too wide where the outline has already curved in");
}
module bail(){
    translate([0, bail_y, bail_z]) rotate([0,90,0]) rotate_extrude($fn=48)
        translate([(bail_id+bail_cord)/2, 0]) circle(d=bail_cord, $fn=24);
}

/* [WHAT THE WINDOW IS WORN ON — v2.9, 2026-08-02.

   The slot is a WINDOW, not a tube: 12 x 3.4, bounded on all four sides, bored
   front to back. So nothing runs left-right through it. The cord goes DOWN
   THROUGH the window, UP OVER THE CROWN and away — it wraps the bar, and the
   bar is what carries the pendant. Two things follow, and both were measured
   rather than reasoned about:

     * THE PRINT-IN-PLACE CHAIN CANNOT ATTACH. A rigid closed link has to slip
       over a bar of bar_t x depth = 2.4 x 12.5 section, so its INNER diameter
       has to clear that rectangle's 12.73mm diagonal. The lab chain's link is
       ID 7.6 (OD 12, 2.2 section). It was drawn threaded through this window in
       the hero render for a day; a boolean of link against case measured
       22.0mm^3 of solid-on-solid interference in 5 places. check_fit.py now
       derives the minimum link from the bar instead of anyone eyeballing a
       render. A bought chain is unaffected — you thread it by its end, or hang
       it from the cord wrap.
     * A WRAPPED CORD NEEDS NO CLASP, only a way to change length. Hence
       part="slider" below, which with a cord is the entire rest of the
       necklace.

   THE CROWN SEAT (cord_seat) is what makes the wrap behave. Without it the cord
   crosses a 10mm-wide flat crown and can wander to either side, which cants the
   pendant; a round-bottomed groove the cord's own radius nests it on the centre
   line. It LOCATES the cord and does not catch it: seat_r = cord_d/2 + 0.1 puts
   the arc's centre 0.7mm outside the crown, so the void is widest at the mouth
   and narrows all the way down — no undercut, nothing to snap past, and the cord
   clears both mouth corners by 0.059mm on its way in (check_fit measures that).
   Deepening seat_d does not buy retention either, it only moves the mouth wider
   until it stops locating anything; the bead is what closes the loop.
   It runs along Z — the print axis — so it is a vertical groove in a
   vertical wall: no bridge, no overhang, nothing added to the plate. It costs
   0.9mm of the bar's 2.4 over 2.88mm of width, and leaves 1.5mm (3.6
   extrusions) at the thinnest — which on the Vision's 12.5mm depth is
   check_fit()'s 30.0 -> 18.8mm^2, quoted here in the SAME terms the gate uses
   (thickness at the groove's centre line x depth) because an earlier draft of
   this comment quoted 27.1 instead, and a number that no check computes is a
   number nobody can catch drifting. The body_slab
   chamfer pulls the outline in 1.2mm at each face, so the groove fades out
   before the edges instead of notching the silhouette. */
cord_d    = 3.0;    // the cord this bail and this kit are dimensioned for
cord_seat = true;   // v2.9: round-bottom groove across the crown, on Z
seat_r    = cord_d/2 + 0.1;              // 1.60 — the cord nests, not wedges
seat_d    = 0.9;                         // how deep it bites into the crown
seat_w    = 2*sqrt(max(0, seat_r*seat_r - pow(seat_r-seat_d, 2)));  // 2.88
if (cord_seat) {
    assert(bar_t - seat_d >= 3*0.42 - 1e-6,
           "the crown seat has eaten the bar it is cut into — under 3 extrusions");
    assert(slot_t >= cord_d + 0.3 - 1e-6,
           "the window cannot pass the cord the seat is cut for");
}
module crown_seat(){
    translate([0, head_top - seat_d + seat_r, -0.5]) cylinder(r=seat_r, h=depth+1);
}

/* THE SLIDER — the clasp replacement. Both cord ends pass through it in
   opposite directions, so pulling them cinches the loop and friction holds the
   length; there is no metal and nothing to unclip.

   Friction is the one number here that arithmetic cannot settle: it is a
   printed bore against a compressible cord, and a 0.1mm change in the bore is
   the difference between "slides on its own" and "cannot be threaded". So the
   plate prints THREE of these, at 0.1mm intervals, and the one that feels right
   is the one you keep — which costs 0.2g and eight minutes, against a reprint.

   Every wall here is bounded by the same thing the pendant's are (2 extrusions
   = 0.84), and the binding one is not the obvious one: the bore's lead-in
   chamfer and the body's end chamfer both eat the SAME wall at z=0, where they
   meet. That pair is why the wall is 1.5 and not 1.2 — at 1.2 the mouth broke
   out through the side of the bead. check_fit.py measures it at that section. */
slider_bore = 2.9;   // -D slider_bore=2.8 / 3.0 for the other two on the plate
slider_bmax = 3.0;   // THE OUTLINE IS SIZED FROM THE WIDEST BORE ON THE PLATE,
                     // not from slider_bore. Sizing it from the default is the
                     // same bug shape as sizing a plate transform from one
                     // variant: the 2.9 bead passed at 0.87mm of wall and the
                     // 3.0 bead — same outline, wider hole — failed at 0.80.
slider_wall = 1.7;   // widest bore to the outside
slider_web  = 1.5;   // bore to bore
slider_len  = 6.0;   // along the cord: the grip's lever arm
slider_ch   = 0.3;   // bore lead-in, so a melted cord end finds the hole
slider_ech  = 0.3;   // the bead's own end chamfer — no sharp edge on the neck
slider_ax   = slider_bmax + slider_web/2 + slider_wall;    // 5.45 -> 10.9 wide
slider_ay   = slider_bmax/2 + slider_wall;                 // 3.20 ->  6.4 tall
module slider(bore=slider_bore){
    difference(){
        hull(){                          // same chamfered-squircle language as
            linear_extrude(0.01)         // body_slab, at bead scale
                offset(-slider_ech) squircle_2d(slider_ax, slider_ay);
            translate([0,0,slider_ech])
                linear_extrude(slider_len-2*slider_ech) squircle_2d(slider_ax, slider_ay);
            translate([0,0,slider_len-0.01]) linear_extrude(0.01)
                offset(-slider_ech) squircle_2d(slider_ax, slider_ay);
        }
        for (i=[-1,1]) translate([i*(bore+slider_web)/2, 0, 0]){
            translate([0,0,-0.01]) cylinder(d=bore, h=slider_len+0.02);
            translate([0,0,-0.01])
                cylinder(d1=bore+2*slider_ch, d2=bore, h=slider_ch+0.01);
            translate([0,0,slider_len-slider_ch])
                cylinder(d1=bore, d2=bore+2*slider_ch, h=slider_ch+0.01);
        }
    }
}

// ---- tray ---------------------------------------------------------------------
module tray(){
    difference(){
        union(){
            intersection(){       // body up to the door plane
                body_slab();
                bound(bat ? cover_h : -0.5, depth-door_t);
            }
            if (bail_style == "ring") bail();
        }
        cavity();
        // NO CORNER RELIEFS — removed v2.8, 2026-08-02 (user: "there are some
        // corners of the case, they must be closed smooth surface").
        //
        // Four r0.5 cylinders used to stand at (+/-cav/2, +/-cav/2), inherited
        // from the v1 case whose cavity was a SQUARE and needed somewhere for a
        // square PCB corner to go. This cavity is a hull of r2 cylinders, so it
        // is already round there: the PCB's corner clears that arc by 1.038mm,
        // and the relief sat entirely OUTSIDE the cavity — 0.328mm of material
        // away from it. A sealed 1mm void, connected to nothing, with 0.258mm
        // (0.6 extrusions) of skin between it and the outside world at each of
        // the four corners. That is what made the corners print open and
        // ragged; the slicer cannot draw a 0.26mm wall, so it drew nothing.
        // check_fit.py now measures cavity-to-outside directly (1.585mm, 3.8
        // extrusions) instead of trusting that no one adds a void back.
        // USB mouth — off-center, matches the measured shell
        translate([usb_cx-usb_w/2, -out_y, cav_z0])
            cube([usb_w, out_y-cav/2+0.5, usb_h]);
        // snap sockets on ±X inner walls, near the rim (+Y edge carries the
        // camera module to z10.75 — no skirt/snaps there)
        for(i=[-1,1])
            translate([i*(cav/2+0.1), 0, depth-door_t-1.2])
                rotate([90,0,0]) cylinder(r=snap_h+0.1, h=snap_len+1, center=true);
        if (bat) {
            // RABBET: the bottom cover_lip of the tray is inset all round, so
            // the cover's rim wraps it and the outside stays flush. Cut as
            // "everything outside the inset outline" in that z band.
            translate([0,0,cover_h-0.5]) linear_extrude(cover_lip+0.5) difference(){
                offset(2) body_2d();
                offset(-(rab_t+rab_c)) body_2d();
            }
            // sockets for the cover's snap bumps, in the rabbet face
            for(i=[-1,1])
                translate([i*(body_ax-rab_t-rab_c-0.1), 0, cover_h+cover_lip/2])
                    rotate([90,0,0]) cylinder(r=snap_h+0.1, h=snap_len+1, center=true);
            // WIRE CHANNEL: one prism in the bay's ceiling. Outboard of the
            // cavity it is a groove in 9mm of solid wall; inboard it breaks
            // through the partition, which is the port into the board's space.
            translate([wire_x-wire_w/2, chan_y0, cover_h])
                cube([wire_w, chan_y1-chan_y0, chan_h]);
            // thumbnail scallop above the joint at -Y (away from the bail), so
            // the cover can be lifted off without a tool
            translate([0, -(body_ay-0.2), cover_h+cover_lip+0.9])
                rotate([0,90,0]) cylinder(r=1.6, h=9, center=true);
        }
    }
    // PCB ledge ring (PCB rests `below` above cavity floor), USB edge kept clear
    translate([0,0,cav_z0+below-0.8]) difference(){
        linear_extrude(0.8) offset(-0.01) square(cav, center=true);
        translate([0,0,-0.1]) linear_extrude(1) square(cav-2*ledge, center=true);
        // v2.1 ANTENNA CHANNEL (photo: the u.FL antenna cable was snaking out
        // of the case): a vertical pocket in the -X wall hosts the Molex flex
        // antenna INSIDE (fits ~40x10x1 folded), leaving a 1.2mm outer wall
        // for RF (v1 beacon-case practice). Cable routes from the u.FL up the
        // -X gap into this pocket.
        translate([-14.6, -11.5, cav_z0]) cube([1.9, 6.9, cav_h]);  // south of the snap zone
        // USB plug-guide flare: the mouth widens outward (+1.6/side, +1.2 top)
        hull(){
            translate([usb_cx-usb_w/2, -13.2, cav_z0]) cube([usb_w, 0.1, usb_h]);
            translate([usb_cx-usb_w/2-1.6, -16.4, cav_z0]) cube([usb_w+3.2, 0.1, usb_h+1.2]);
        }
        // -Y notch spans USB (x -11.4..2.6) AND battery conn (x 1.3..8.3)
        translate([-1.2, -cav/2+ledge/2, -0.1])
            linear_extrude(1) square([21.6, ledge+1.4], center=true);
    }
    // v2.4 LOCATING RIBS — the fix for a bug the measurements exposed.
    //
    // The v2 cavity was opened to 25.5 for a 22.86 PCB so the board drops in
    // without force (user: "so I can put the chip without breaking"). But that
    // leaves +/-1.32mm of float, and at the extremes the LENS/LED/reset holes
    // no longer line up with their parts: on the Voice the LED can sit 1.37mm
    // OUTSIDE its window and the reset pinhole misses the button entirely.
    //
    // Four ribs take the slack out WITHOUT making insertion tight: each is
    // chamfered on top (0.9 tall lead-in) so the board self-centres as it
    // drops, and they only touch the PCB EDGE — 0.15/side clearance means it
    // still slides, it just cannot wander. Placed at the corners' straight
    // sections, clear of the USB mouth, ESLOV notch and antenna pocket.
    //
    // ⚠ FIXED 2026-08-02, found while measuring the battery tray: rib_z0 was
    // computed here and never passed to rib(), which builds from z=0. So every
    // rib since v2.4 has stood at z 0..2.6 — INSIDE the solid floor, ending
    // 2.1mm below the PCB's underside at 4.7. They located nothing, and the
    // +/-0.15 float that check_fit.py grants every port alignment (and that the
    // v2.5 hole shrink was justified by) was never actually bought. The v2.6
    // plate on the printer right now still has this; the door's camera fence is
    // what has been centring the lens.
    // The height clamp also has to respect the door skirt, not just the door
    // plane: on the 9.5mm Voice a 2.6 rib reaches 6.50 and the skirt comes down
    // to 5.996, so raising the ribs to where they belong would have made the
    // Voice lid unclosable. Unchanged on the Vision (clamps to 2.6 either way).
    rib_z0   = cav_z0 + below - 0.8;      // flush with the ledge's underside
    rib_h    = min(2.6, depth - door_t - skirt_h - rib_z0 - 0.2);
    for (i=[-1,1]) {
        // +/-X ribs, pushed to +Y clear of the USB mouth and ESLOV notch
        rib(rib_h, [i, 0], 4.6, rib_z0);
        // +Y ribs — the camera/LED/reset edge, where alignment matters most
        rib(rib_h, [0, 1], i*6.4, rib_z0);
    }
}

// One locating rib. It fills the slot between the seated PCB edge and the
// cavity wall, so it cannot be pushed inward past the board: the INNER face
// sits at pcb/2 + 0.15 and the body runs outward to the wall. The top 0.9 is
// chamfered back so a descending board is funnelled in rather than jammed.
// dir = [+/-1,0] for an X-side rib or [0,+/-1] for a Y-side rib; off slides it
// along that wall.
// z0 is where the rib STARTS: it must straddle the seated PCB's edge, so the
// caller passes the ledge's underside and the rib grows up past the board.
module rib(h, dir, off, z0=0){
    len   = 3.4;
    inner = pcb_xy/2 + 0.15;
    outer = cav/2 + 0.2;          // bury 0.2 into the wall: no seam gap
    t     = outer - inner;
    ax    = abs(dir[0]);          // 1 = rib lives on an X wall
    // local box: thickness along the wall normal, len along the wall
    module slab(shrink, za, zb){
        translate([ax ? inner+shrink : off-len/2,
                   ax ? off-len/2    : inner+shrink, za])
            cube([ax ? t-shrink : len, ax ? len : t-shrink, zb-za]);
    }
    scale([dir[0]==0?1:dir[0], dir[1]==0?1:dir[1], 1])
        hull(){ slab(0, z0, z0+h-0.9); slab(0.55, z0+h-0.9, z0+h); }
}

// ---- door ---------------------------------------------------------------------
module door(){
    difference(){
        union(){
            intersection(){       // face plate slice of the body
                body_slab();
                bound(depth-door_t, depth+0.5);
            }
            // U-shaped snap skirt: ±X and -Y sides only — the +Y edge is the
            // camera module's (PCB top 5.75 + module 5.0 = z10.75; a skirt
            // there would crush it)
            translate([0,0,depth-door_t-skirt_h]) linear_extrude(skirt_h) difference(){
                offset(-skirt_c) hull() for(i=[-1,1], j=[-1,1])
                    translate([i*(cav/2-2), j*(cav/2-2)]) circle(r=2);
                hull() for(i=[-1,1], j=[-1,1])
                    translate([i*(cav/2-3.4), j*(cav/2-3.4)]) circle(r=2);
                translate([-cav/2-1, cav/2-3.6]) square([cav+2, 6]);  // open +Y side
            }
            // snap bumps on ±X skirt faces
            for(i=[-1,1])
                translate([i*(cav/2-skirt_c-0.05), 0, depth-door_t-1.2])
                    rotate([90,0,0]) cylinder(r=snap_h, h=snap_len, center=true);
            // v2.1 CAMERA REGISTRATION FENCE (user: "camera not aligned"):
            // a 0.8-tall wall on the door underside wraps the camera module
            // (7.5 wide, center x -2.55) so snapping the door on CENTERS the
            // lens regardless of the roomy v2 cavity's ±1.3mm board float.
            // Open on the south side over the ToF window; a backwards door
            // can't seat (fence lands on the module) — orientation-proof.
            if (face != "voice")
                translate([0,0,depth-door_t-0.8]) linear_extrude(0.8) difference(){
                    translate([lens_x, 8.0]) square([10.6, 9.8], center=true);
                    translate([lens_x, 8.0]) square([8.7, 7.9], center=true);
                    translate([lens_x-2.0, 8.0-5.0]) square([7.0, 2.2], center=true); // ToF gap
                }
        }
        // camera + cone + mic (texture variants engrave this plate)
        if (face != "voice") {
            translate([lens_x, lens_y, depth-door_t-skirt_h-0.5]) cylinder(d=lens_d, h=8);
            translate([lens_x, lens_y, depth-cone])
                cylinder(d1=lens_d, d2=lens_d+2*cone, h=cone+0.02);
            translate([mic_x, mic_y, depth-door_t-1]) cylinder(d=mic_d, h=3);
        } else {
            // voice: mic grille — 7-hole hex cluster in the middle of the
            // plate, clear of the measured LED/reset corner
            for (a=[0:60:359]) translate([2.6*cos(a), -3.0+2.6*sin(a), depth-door_t-1])
                cylinder(d=1.8, h=3);
            translate([0, -3.0, depth-door_t-1]) cylinder(d=1.8, h=3);
            // MEASURED RGB LED glow window — a BLIND pocket that leaves a 0.6
            // skin, so the LED lights the case instead of staring out a hole.
            //
            // The LED (-9.89,+9.89) and the reset button (-7.58,+8.03) are only
            // 2.97mm apart on the real board. A d5.2 window plus a d2.4 pinhole
            // overlap by 0.83mm — the pinhole would punch through the glow skin
            // and leave a ragged shared opening. So the window is d3.4 and it
            // shifts out along the corner diagonal, away from the button.
            translate([voice_led_x-0.35, voice_led_y+0.35, depth-door_t-0.01])
                cylinder(d=3.4, h=door_t-0.6+0.01);
            // MEASURED reset pinhole. v2.5: it sits dead CENTRE on the button
            // pad (x -8.88..-6.28, y 6.51..9.56) at d1.6. The v2.4 version was
            // d2.0 shifted +0.30/-0.50 to win wall from the LED window, but a
            // 2.0 hole offset 0.30 inside a 2.6-wide pad overruns the pad edge
            // once the ribs' +/-0.15 is counted — it would poke the substrate
            // beside the switch, not the switch. Shrinking to 1.6 (a paperclip
            // is 0.9) means no offset is needed: centred, it still keeps 0.96mm
            // of wall to the window and lands with 0.35mm of pad to spare.
            translate([voice_rst_x, voice_rst_y, depth-door_t-1])
                cylinder(d=rst_d, h=4);
        }
        if (face != "voice") {
            // ToF slot — the two optical apertures only (see tof_h note): a
            // stadium tof_w long and tof_h tall, which keeps 0.87mm of wall up
            // to the lens instead of merging with it.
            translate([tof_x, tof_y, depth-door_t-1]) linear_extrude(4)
                hull() for(i=[-1,1])
                    translate([i*(tof_w-tof_h)/2, 0]) circle(d=tof_h);
            // reset button service pinhole
            translate([rst_x, rst_y, depth-door_t-1]) cylinder(d=rst_d, h=4);
        }
        // halo2: ring void goes THROUGH — the skin is a separate color part
        if (face == "halo2")
            translate([lens_x, lens_y, depth-door_t-0.01]) difference(){
                cylinder(d=lens_d+7.4, h=door_t+0.5);
                translate([0,0,-0.5]) cylinder(d=lens_d+4.6, h=3);
            }
        // halo face: glow annulus cut from the INSIDE, 0.6 skin remains
        if (face == "halo")
            translate([lens_x, lens_y, depth-door_t-0.01]) difference(){
                cylinder(d=lens_d+7.4, h=door_t-0.6+0.01);
                translate([0,0,-0.1]) cylinder(d=lens_d+4.6, h=2);
            }
    }
}


// ---- battery cover (bat=true) -------------------------------------------------
// The bottom cover_h of the body, hollowed into a cell bay, with a rim that
// wraps up over the tray's rabbet. Prints exactly as modelled: visible face on
// the plate, bay opening up, no supports and no overhang but the 1.0 lip step.
module bay_2d(){
    hull() for(i=[-1,1], j=[-1,1])
        translate([i*(bay_x/2-bay_r), j*(bay_y/2-bay_r)]) circle(r=bay_r);
}

module cover(){
    difference(){
        union(){
            intersection(){
                body_slab();
                bound(-0.5, cover_h);
            }
            // retaining rim: the ring between the body outline and the inset,
            // rising cover_lip past the joint to grip the tray's rabbet
            translate([0,0,cover_h]) linear_extrude(cover_lip) difference(){
                body_2d();
                offset(-rab_t) body_2d();
            }
            // snap bumps on the rim's inner face, ±X — the door's mechanic,
            // inverted (bump on the outer part, socket on the inner one)
            for(i=[-1,1])
                translate([i*(body_ax-rab_t+0.05), 0, cover_h+cover_lip/2])
                    rotate([90,0,0]) cylinder(r=snap_h, h=snap_len, center=true);
        }
        translate([0,0,cover_t]) linear_extrude(bay_z+0.01) bay_2d();
    }
}

module cover_faced(){
    difference(){
        cover();
        if (face == "halo" || face == "mark2" || face == "voice") tray_backmark();
    }
}

/* [THE MARK — v2.8, 2026-08-02. Replaced wholesale by the new tiny logo the
   user supplied as SVG: seven stroked rings on a hex grid.

       viewBox 248.82 x 231.07, 7 x <circle r="30.39">, stroke-width 11
       centres (80.45,35.89) (168.91,35.89)
               (212.93,115.54) (124.41,115.54) (35.89,115.54)
               (80.45,195.18) (168.91,195.18)

   Taken from the file verbatim, in the file's own units, and scaled by ONE
   number (ms) — so the mark on the pendant is the artwork, not a redraw of it.
   Two facts that fall out of the numbers and matter here:

     * the artwork fills its viewBox exactly once the stroke is counted
       (35.89 - 35.89 = 0, 212.93 + 35.89 = 248.82), so mark_w IS the mark's
       width and no bounding box has to be guessed;
     * the rings do NOT touch. Nearest pair is the top two at 88.46 apart
       against 71.78 of outer diameter — 16.68 units of gap, which is what has
       to survive the scale AND the deboss offset, or the black between two
       white rings disappears. check_fit.py holds that.

   It is also symmetric about its own centre line, so the mirror() that
   tray_backmark/mark_skin_print apply (they draw the back of the case) is a
   no-op on it — this mark cannot come out reversed the way a wordmark could.

   SIZING, the same rule the old logo was fixed by (0.4 nozzle -> 0.42
   extrusion, every accent feature >= 2 extrusions): at mark_w 27 the stroke is
   1.19mm = 2.8 extrusions and the gap 1.81mm. Bigger is better for the stroke
   and worse for the margin — 28.5 would put 3 extrusions in the stroke but hang
   the outer rings over the squircle's shoulder, so 27 is the top of the range,
   not a round number. */
mark_svg_w = 248.82;   // \ the viewBox, and the units every number below is in
mark_svg_h = 231.07;   // /
mark_ring_r = 30.39;   // <circle r>
mark_stroke = 11;      // stroke-width: the ring spans r +/- 5.5
mark_w   = 27.0;       // how wide the mark sits on the 31.6mm back face
ms       = mark_w / mark_svg_w;        // 0.10851 — the ONLY scale factor
mark_rings = [[ 80.45,  35.89], [168.91,  35.89],
              [212.93, 115.54], [124.41, 115.54], [35.89, 115.54],
              [ 80.45, 195.18], [168.91, 195.18]];
// Centred on the FACE, not on the board. The face is no longer symmetric about
// the PCB: it runs from -body_ay up to the cord slot, so a mark at y=0 sits
// 1.66mm off the slot and 3.26 off the bottom edge — visibly high. This is the
// midpoint of the material the mark actually has, and it is inside
// tiny_mark_2d() on purpose: the pocket and the insert are two different modules
// and a shift applied in one of them only is exactly the class of bug mark_z
// exists to prevent.
mark_cy  = bail_style == "slot" ? (slot_y0 - body_ay)/2 : 0;

module tiny_mark_2d(){
    translate([0, mark_cy]) for (c = mark_rings)
        // SVG y runs down the page; the model's runs up it
        translate([(c[0] - mark_svg_w/2)*ms, (mark_svg_h/2 - c[1])*ms])
            difference(){
                circle(r=(mark_ring_r + mark_stroke/2)*ms, $fn=72);
                circle(r=(mark_ring_r - mark_stroke/2)*ms, $fn=72);
            }
}

// TWO-COLOR FIX (2026-08-01, from after-slice.jpg): the deboss and the accent
// insert had IDENTICAL XY footprints, so their vertical walls were coincident
// -> Bambu alternated ownership per layer = green/yellow checkered dashes.
// The pocket is now offset +0.12/side; the insert keeps the exact mark size
// and drops in with a uniform 0.12 gap. Depth 0.66 vs insert 0.6 also breaks
// the top-face tie (insert finishes 0.05 proud of nothing — flush at z0.6,
// pocket floor owns its own layer).
mark_clr = 0.12;   // per-side XY clearance, pocket vs accent insert
// v2.6 (2026-08-02, the 0.12mm quality pass): the pocket is now EXACTLY as deep
// as the insert is tall, and that depth lands on a layer boundary.
//
// The old 0.67-vs-0.60 pair only worked by rounding luck at 0.20mm layers: the
// pocket floor fell mid-layer, so the slice plane (layer MIDDLE) saw tray
// material and the tray printed straight onto the insert. Re-slice the same
// geometry at 0.12 and that same 0.07 becomes its own empty layer — the insert
// would be a loose plug held by nothing but a 0.12 side gap.
// Equal depths cannot do that: whatever the layer height, both surfaces round
// to the SAME plane, so the tray always lands on the insert. The per-layer
// ownership flip that produced checkered dashes came from coincident VERTICAL
// walls, which mark_clr fixes and this does not reintroduce.
// 0.56 = initial layer 0.20 + 3 x 0.12 → 4 solid accent layers (rule: >= 3).
mark_z   = 0.56;
module tray_backmark(){                     // debossed rear brand, mirrored
    translate([0,0,-0.01]) linear_extrude(mark_z+0.01)
        offset(mark_clr) mirror([1,0,0]) tiny_mark_2d();
}

// Internal stack (z, from back): floor 0..1.3 | below-PCB/USB zone 1.3..4.7
// (ledge ring 3.9..4.7, USB shell 1.8..4.7) | PCB 4.7..5.75 | camera module
// to 10.75 | door underside 11.1 (0.35 clear) | face 11.1..12.5.
// v0 fit-test: board has ~1.35 vertical play (retention nubs come after the
// corner keep-outs are verified on the real board).

// With bat=true the tray has no back face left to brand — the cover is the
// back — so the deboss moves there and the tray gets none. Same module, same
// mark_z, so the white insert exported by part="markskin" is unchanged.
module tray_faced(){
    difference(){ tray(); if (!bat && (face == "halo" || face == "mark2" || face == "voice")) tray_backmark(); }
}

// ---- views ----------------------------------------------------------------------
if (part == "tray") color(col) tray_faced();
if (part == "door") color(col) door();
if (part == "cover") color(col) cover_faced();
// The cell, drawn where it actually lies in the bay. Review aid only — it is in
// no printable part, and it is the one object in this file that is not geometry
// we make, so seeing it seated is the only way a render can show the fit.
module cell_mock(){
    translate([0,0,cover_t]) linear_extrude(cell_t) offset(r=1)
        square([cell_x-2, cell_y-2], center=true);
}
if (part == "exploded") {
    color(col) tray_faced();
    color(col) translate([0,0,12]) door();
    if (bat) translate([0,0,-14]) {
        color(col) cover_faced();
        color("#c0392b") cell_mock();
    }
}
if (part == "print") color(col) {
    tray_faced();
    translate([40, 0, depth]) rotate([180,0,0]) door();   // face-down
    if (bat) translate([-40, 0, 0]) cover_faced();        // already logo-down
}
// white skin ring, exported IN THE DOOR'S PRINT ORIENTATION (face-down at
// x=40) so it lands exactly inside the door's ring void on the plate
module ring_skin_print(){
    translate([40, 0, depth]) rotate([180,0,0])
        translate([lens_x, lens_y, depth-0.6]) difference(){
            cylinder(d=lens_d+7.35, h=0.6);
            translate([0,0,-0.5]) cylinder(d=lens_d+4.65, h=2);
        }
}
if (part == "ringskin") color("#ffffff") ring_skin_print();

// the door alone, face-DOWN at the origin — how it must sit on the plate
// (bed-facing lid face = best surface finish for the camera fence side)
if (part == "doorprint") color(col)
    translate([0,0,depth]) rotate([180,0,0]) door();

// white "tiny 💎" insert filling the tray's back deboss — the tray prints
// back-down at the origin, so this is already in print orientation
module mark_skin_print(){
    linear_extrude(mark_z) mirror([1,0,0]) tiny_mark_2d();
}
if (part == "markskin") color("#ffffff") mark_skin_print();

// the cord slider, flat on the plate with its bores on Z (no overhang). The
// three grips are one part with one number changed:
//   for b in 2.8 2.9 3.0; do openscad -D slider_bore=$b -D part='"slider"' ...
if (part == "slider") color(col) slider();
// all three, in the order the cord-kit plate packs them: -X is the tightest.
// Printed side by side they are indistinguishable by eye (0.1mm of bore), so
// position IS the label — which is why the plate's part names carry the number.
if (part == "sliderkit") color(col) for (i=[0:2])
    translate([i*(2*slider_ax + 4), 0, 0]) slider(slider_bmax - 0.2 + i*0.1);

// review view: the BACK of the assembled v2 in two colors
if (part == "back2") rotate([0,180,0]) {
    color(col) tray_faced();
    color(col2) mark_skin_print();
}

// Machine-readable dump of every derived number check_fit.py has to agree with.
// The checker runs this instead of restating the arithmetic, so a mirrored
// constant cannot drift from the geometry it claims to describe:
//   openscad -o out.echo --export-format echo -D part="values" ... this file
if (part == "values") echo(str("VALS",
    " bat=", bat ? 1 : 0, " depth=", depth, " cav=", cav, " cav_z0=", cav_z0,
    " cav_h=", cav_h, " below=", below, " door_t=", door_t, " skirt_h=", skirt_h,
    " ledge=", ledge, " pcb_xy=", pcb_xy, " snap_h=", snap_h,
    " snap_len=", snap_len, " body_ax=", body_ax, " body_ay=", body_ay,
    " bail_cord=", bail_cord, " bail_id=", bail_id, " bail_r=", bail_r,
    " bail_lo=", bail_lo, " bail_dy=", bail_dy, " bail_hy=", bail_hy,
    " bail_y=", bail_y, " bail_z=", bail_z,
    " slot=", bail_style == "slot" ? 1 : 0, " slot_w=", slot_w,
    " slot_t=", slot_t, " slot_wall=", slot_wall, " slot_y0=", slot_y0,
    " slot_y1=", slot_y1, " slot_ch=", slot_ch, " bar_t=", bar_t,
    " head_top=", head_top, " void_top=", void_top, " body_ch=", body_ch,
    " cord_d=", cord_d, " cord_seat=", cord_seat ? 1 : 0, " seat_r=", seat_r,
    " seat_d=", seat_d, " seat_w=", seat_w,
    " slider_bore=", slider_bore, " slider_bmax=", slider_bmax,
    " slider_wall=", slider_wall,
    " slider_web=", slider_web, " slider_len=", slider_len,
    " slider_ch=", slider_ch, " slider_ech=", slider_ech,
    " slider_ax=", slider_ax, " slider_ay=", slider_ay,
    " body_ay2=", body_ay2, " body_cy=", body_cy,
    " mark_w=", mark_w, " mark_cy=", mark_cy, " mark_ring_r=", mark_ring_r,
    " mark_stroke=", mark_stroke, " mark_svg_w=", mark_svg_w,
    " mark_svg_h=", mark_svg_h, " mark_z=", mark_z,
    " mark_clr=", mark_clr, " cell_x=", cell_x, " cell_y=", cell_y,
    " cell_t=", cell_t, " bay_x=", bay_x, " bay_y=", bay_y, " bay_z=", bay_z,
    " bay_r=", bay_r, " bat_wall=", bat_wall, " cover_t=", cover_t, " cover_h=", cover_h,
    " cover_lip=", cover_lip, " part_t=", part_t, " rab_t=", rab_t,
    " rab_c=", rab_c, " wire_x=", wire_x, " wire_w=", wire_w,
    " chan_y0=", chan_y0, " chan_y1=", chan_y1, " chan_h=", chan_h));

// Cutaway. The plane is chosen per variant: through the lens on the slim case,
// through J4/the wire channel (x = wire_x) on the battery case, because that is
// the only place the route from the cell to the connector is visible at all.
sect_x = bat ? wire_x : lens_x;
if (part == "section") difference(){
    union(){
        color(col) tray();
        color(col) translate([0,0,3]) door();            // door hovering 3mm
        if (bat) { color(col) translate([0,0,-6]) cover();
                   color("#c0392b") translate([0,0,-6]) cell_mock(); }
    }
    translate([-40, -40, -20]) cube([40+sect_x, 80, 60]);
}
