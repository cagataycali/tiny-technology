// hero: the complete necklace — v2.9 pendant, the cord that wraps its bail,
// and the printed slider that sets the length. No clasp, no metal, no chain.
//
// ⚠ WHAT THIS FILE USED TO SHOW, and why the replacement is not cosmetic. Until
// 2026-08-02 it drew the print-in-place chain threaded through the cord window.
// It cannot be: a rigid link has to slip over a bar of bar_t x depth section,
// and an intersection of that link against tray+door measures 22.0mm^3 of
// solid-on-solid overlap in 5 places. The link's ID is 7.6 and the bar's
// diagonal is 12.59. So the render was drawing an assembly that no one could
// assemble, and `use` imports no variables, so nothing in the file objected.
//
// The cord below is therefore built the way the pendant is actually worn:
//   ONE TURN around the bar — in through the window (resting on the bar's
//   underside), up the front face, over the crown seat, back down behind — then
//   both legs away to the neck. That is why the crown groove exists, and it is
//   the only place on the pendant where the cord shows from the front: a 4.5mm
//   segment across the head.
// Geometry check: `python3 check_fit.py hero` intersects everything drawn here
// against the case and must measure 0mm^3 — and, because an empty intersection
// is also what a hero file that draws NOTHING produces, it measures both halves
// first and fails if either one is empty.
use <tiny_necklace_split.scad>

col   = "#f2f2f2";
ccol  = "#22201e";     // waxed cotton
// `use` imports modules but NO variables, so every number this file needs about
// the pendant is restated here — which is a copy, and copies go stale. All six
// are plain literals rather than expressions for one reason: check_hero_numbers()
// greps them and re-derives each from the model's own values, so a change to
// slot_y1, seat_d, depth or the slider's bore FAILS here instead of quietly
// drawing a cord that misses its own bail.
cord  = 3.0;           // = cord_d
seat_y = 20.6;         // head_top 20.0 - seat_d 0.9 + cord/2: seated on the arc
win_y  = 16.1;         // slot_y1 17.6 - cord/2: hanging off the bar's underside
face_z = 12.5;         // = depth
sl_bore = 2.9;         // = slider_bore
sl_web  = 1.5;         // = slider_web
sl_len  = 6.0;         // = slider_len
out    = cord/2;       // how far clear of a face the cord's centre runs

// A cord as a swept path: spheres hulled pairwise, so a corner is a real radius
// instead of a mitre. 3mm cord at $fn=20 is ~30 facets per bend — plenty for a
// render and cheap enough to boolean against the case.
module cord_path(pts, d=cord){
    for (i=[0:len(pts)-2]) hull(){
        translate(pts[i])   sphere(d=d, $fn=20);
        translate(pts[i+1]) sphere(d=d, $fn=20);
    }
}

// A cubic Bezier, sampled. Two control points instead of one because the END
// TANGENT matters: each leg has to arrive at the slider running along +Y, or it
// would enter a bore it is not parallel to. p2 and p3 therefore share an x.
function bez3(p0, p1, p2, p3, n=12) = [for (i=[0:n]) let(t = i/n, u = 1-t)
    [for (k=[0,1,2]) u*u*u*p0[k] + 3*u*u*t*p1[k] + 3*u*t*t*p2[k] + t*t*t*p3[k]]];

// THE WRAP, in the YZ plane at x=0. Four corners, all of them rounded by the
// sweep: back of the window -> through it -> up the front face -> over the crown
// -> down the back face. The legs pick it up from there.
wrap = [[0, win_y,  -out],
        [0, win_y,  face_z + out],
        [0, seat_y, face_z + out],
        [0, seat_y, -out]];

// THE NECK LOOP. This is how the whole thing is worn, and it is the reason the
// slider exists at all: one cord, the pendant on its middle, both halves up
// around the neck, both ends through the bead in the same direction, and the
// surplus left hanging past it. Pull the two tails and the loop shrinks; push
// the bead down towards the pendant and it grows. No clasp to print, nothing
// metal to buy, and nothing to fail — which is the point, because the one thing
// this bail CANNOT take is a rigid closed link (see the header).
//
// The legs arrive at the slider's bore centres, slider_web/2 + bore/2 either
// side of the middle. That spacing is not eyeballed: it is the same expression
// the bead is built from, so a change to the bore moves the cord with it.
gap    = (sl_bore + sl_web)/2;
neck_h = 215;                  // bead height above the pendant's centre
neck_w = 46;                   // half-width at the widest
tail   = 70;                   // surplus past the bead — this IS the adjustment
curve  = [for (s=[-1,1])
    bez3([0, s < 0 ? win_y : seat_y, -out],       // off the bar, behind the case
         [s*neck_w*1.30, neck_h*0.34, -out],      // out to the widest point
         [s*gap,         neck_h*0.82, -out],      // and in again, ...
         [s*gap,         neck_h - 3,  -out])];    // ...arriving parallel to +Y
// straight on through both bores and out the far side as the tails
legs   = [for (i=[0,1]) concat(curve[i],
    [[curve[i][len(curve[i])-1][0], neck_h + sl_len + tail, -out]])];

// HOW LONG A CORD TO BUY, measured off the path above instead of guessed.
// A clasp-free necklace has one hard constraint a render will not show: at its
// LONGEST setting the loop has to pass over a head (~57cm on an adult), and the
// longest setting is the whole cord, because sliding the bead up puts every
// millimetre of the tails into the loop. So the tails are not trim — they are
// the difference between "44.4cm, sits on the collarbone" and "gets stuck".
// check_fit.py reads these two numbers back out of this echo and gates both.
function plen(p, i=0) = i >= len(p)-1 ? 0 : norm(p[i+1]-p[i]) + plen(p, i+1);
loop_mm  = plen(wrap) + plen(curve[0]) + plen(curve[1]);
cord_mm  = plen(wrap) + plen(legs[0]) + plen(legs[1]);
echo(str("HERO loop=", loop_mm, " cord=", cord_mm, " cord_d=", cord,
         " neck_h=", neck_h, " tail=", tail));

// The two halves are modules, not loose geometry, for one reason: check_fit.py
// intersects them. Top-level geometry is unreachable through `use`, so a render
// built inline is a render nothing can check — which is exactly the state the
// chain version was in.
module hero_case(){ tray_faced(); door(); }
module hero_cord(){
    cord_path(wrap);
    for (l = legs) cord_path(l);
    // the bead, threaded on both legs: bores on Y, so it is the printed part
    // rotated a quarter turn out of its plate orientation. It overlaps each cord
    // by 0.05mm radially — bore 2.9 on a 3.0 cord — and that overlap IS the grip.
    translate([0, neck_h, -out]) rotate([-90, 0, 0]) slider();
}

color(col)  hero_case();
color(ccol) hero_cord();
