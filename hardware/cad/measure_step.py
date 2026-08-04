#!/usr/bin/env python3
"""Measure NAMED solids out of a vendor STEP assembly, in board coordinates.

Why this exists. Every case bug in this project has come from a number that was
guessed, and every fix has come from a number that was measured — see the
README's measured-board tables. Those tables were built by hand once, and one
row was wrong in a way that mattered: the ledge notch is documented as clearing
the "battery connector" at x 1.3..8.3, 2.95 below the PCB, but the Nicla Vision's
battery connector (J4) is a BM03B-ACHSS, and JST's own drawing puts that part at
5.4 x 4.3 x **1.4** mm. A 7mm-wide, 2.95-tall solid on that edge is the 5-pin
ESLOV (SM05B-SRSS-TB). Designing a battery bay around the wrong connector would
have put the wire slot in the wrong place, so the identification is checked here
rather than remembered.

Usage:
    python3 measure_step.py NiclaVision.step                 # every named solid
    python3 measure_step.py NiclaVision.step ACHSS SM05B ZX62

Output is in BOARD coordinates, matching the convention the .scad files use:
PCB centre = origin in XY, PCB **top** face = z0, so a part on the bottom side
has negative z. The PCB solid is found automatically and used as the datum.

No dependencies: a targeted STEP reader, not a CAD kernel. It resolves only what
it needs — product -> shape representation -> points, plus the assembly's
transform chain — which is enough for an axis-aligned bounding box per part.
"""
from __future__ import annotations

import re
import sys

# ---- STEP tokenising ----------------------------------------------------------


def parse_entities(path):
    """id -> (TYPE, raw_arg_string). Complex entities keep their whole body."""
    with open(path, "r", errors="replace") as fh:
        text = fh.read()
    start = text.find("DATA;")
    if start >= 0:
        text = text[start + 5:]

    ents, i, n = {}, 0, len(text)
    while True:
        h = text.find("#", i)
        if h < 0:
            break
        m = re.match(r"#(\d+)\s*=\s*", text[h:h + 40])
        if not m:
            i = h + 1
            continue
        eid = int(m.group(1))
        j = h + m.end()
        # scan to the terminating ';', skipping quoted strings
        k, quoted = j, False
        while k < n:
            c = text[k]
            if c == "'":
                # '' inside a string is an escaped quote
                if quoted and k + 1 < n and text[k + 1] == "'":
                    k += 2
                    continue
                quoted = not quoted
            elif c == ";" and not quoted:
                break
            k += 1
        body = text[j:k].strip()
        tm = re.match(r"([A-Z_0-9]+)\s*\(", body)
        ents[eid] = (tm.group(1) if tm else "", body)
        i = k + 1
    return ents


def refs(body):
    return [int(x) for x in re.findall(r"#(\d+)", body)]


def args_of(body, typename=None):
    """Split the top-level argument list of `TYPE( ... )` into raw strings."""
    if typename:
        m = re.search(typename + r"\s*\(", body)
        if not m:
            return []
        start = m.end()
    else:
        start = body.index("(") + 1
    depth, out, cur, quoted = 1, [], "", False
    for c in body[start:]:
        if quoted:
            cur += c
            if c == "'":
                quoted = False
            continue
        if c == "'":
            quoted = True
            cur += c
        elif c == "(":
            depth += 1
            cur += c
        elif c == ")":
            depth -= 1
            if depth == 0:
                break
            cur += c
        elif c == "," and depth == 1:
            out.append(cur.strip())
            cur = ""
        else:
            cur += c
    out.append(cur.strip())
    return out


# ---- rigid transforms (4x4 row-major, last row implicit) ----------------------


def ident():
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]


def mat_mul(a, b):
    out = []
    for r in range(3):
        row = []
        for c in range(3):
            row.append(sum(a[r][k] * b[k][c] for k in range(3)))
        row.append(sum(a[r][k] * b[k][3] for k in range(3)) + a[r][3])
        out.append(row)
    return out


def mat_inv(m):
    inv = [[m[c][r] for c in range(3)] for r in range(3)]        # R^T
    t = [-sum(inv[r][k] * m[k][3] for k in range(3)) for r in range(3)]
    return [inv[r] + [t[r]] for r in range(3)]


def apply(m, p):
    return [sum(m[r][c] * p[c] for c in range(3)) + m[r][3] for r in range(3)]


def norm(v):
    L = sum(x * x for x in v) ** 0.5
    return [x / L for x in v] if L else [0, 0, 1]


class Reader:
    def __init__(self, path):
        self.e = parse_entities(path)
        self.by_type = {}
        for eid, (t, body) in self.e.items():
            self.by_type.setdefault(t, []).append(eid)
        # Only B-rep VERTEX points bound the solid. Collecting every
        # CARTESIAN_POINT instead inflates the box, because a cylinder's axis
        # point and a B-spline's control points sit OUTSIDE the material —
        # measured: it made the 1.4mm-tall ACH connector read 10.25mm tall.
        self.vertex_pts = set()
        for eid in self.by_type.get("VERTEX_POINT", []):
            self.vertex_pts.update(refs(self.e[eid][1]))

    # -- geometry ------------------------------------------------------------
    def point(self, eid):
        vals = re.findall(r"-?\d+\.?\d*(?:[Ee][-+]?\d+)?", args_of(self.e[eid][1])[-1])
        return [float(v) for v in vals[:3]]

    def direction(self, eid):
        return self.point(eid)

    def placement(self, eid):
        """AXIS2_PLACEMENT_3D -> 4x3 matrix taking local coords to parent."""
        a = args_of(self.e[eid][1])
        loc = apply_default(a, 1)
        origin = self.point(loc) if loc else [0, 0, 0]
        z = norm(self.direction(apply_default(a, 2)) if apply_default(a, 2) else [0, 0, 1])
        xr = self.direction(apply_default(a, 3)) if apply_default(a, 3) else [1, 0, 0]
        d = sum(xr[i] * z[i] for i in range(3))
        x = norm([xr[i] - d * z[i] for i in range(3)])
        y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
        return [[x[0], y[0], z[0], origin[0]],
                [x[1], y[1], z[1], origin[1]],
                [x[2], y[2], z[2], origin[2]]]

    # -- products ------------------------------------------------------------
    def products(self):
        """name -> shape representation id."""
        # PRODUCT -> PRODUCT_DEFINITION_FORMATION -> PRODUCT_DEFINITION
        form_of, def_of = {}, {}
        for eid in self.by_type.get("PRODUCT_DEFINITION_FORMATION", []):
            r = refs(self.e[eid][1])
            if r:
                form_of[eid] = r[-1]
        for eid in self.by_type.get("PRODUCT_DEFINITION", []):
            r = refs(self.e[eid][1])
            if r:
                def_of[eid] = r[0]
        # PRODUCT_DEFINITION_SHAPE -> SHAPE_DEFINITION_REPRESENTATION -> rep
        shape_of = {}
        for eid in self.by_type.get("PRODUCT_DEFINITION_SHAPE", []):
            r = refs(self.e[eid][1])
            if r:
                shape_of[eid] = r[-1]
        rep_of_pd = {}
        for eid in self.by_type.get("SHAPE_DEFINITION_REPRESENTATION", []):
            r = refs(self.e[eid][1])
            if len(r) >= 2 and r[0] in shape_of:
                rep_of_pd[shape_of[r[0]]] = r[1]

        out = {}
        for eid in self.by_type.get("PRODUCT", []):
            name = (args_of(self.e[eid][1])[0] or "").strip("'")
            for pd, formation in def_of.items():
                if form_of.get(formation) == eid and pd in rep_of_pd:
                    out.setdefault(name, []).append((pd, rep_of_pd[pd]))
        return out

    # -- assembly ------------------------------------------------------------
    def transform_graph(self):
        """child_rep -> [(parent_rep, matrix)] from the assembly relationships."""
        graph = {}
        for eid, (t, body) in self.e.items():
            if "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION" not in body:
                continue
            rel = args_of(body, "REPRESENTATION_RELATIONSHIP")
            if len(rel) < 4:
                continue
            child, parent = refs(rel[2])[0], refs(rel[3])[0]
            itd = refs(args_of(body, "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION")[0])
            if not itd:
                continue
            ia = refs(self.e[itd[0]][1])
            if len(ia) < 2:
                continue
            m = mat_mul(self.placement(ia[1]), mat_inv(self.placement(ia[0])))
            graph.setdefault(child, []).append((parent, m))
        return graph

    def to_root(self, rep, graph, depth=0):
        """Compose transforms from `rep` up to the assembly root."""
        if depth > 24 or rep not in graph:
            return ident()
        parent, m = graph[rep][0]
        return mat_mul(self.to_root(parent, graph, depth + 1), m)

    # -- points --------------------------------------------------------------
    def rep_points(self, rep):
        """The solid's VERTEX points, reachable from a shape representation."""
        seen, stack, pts = set(), [rep], []
        while stack:
            eid = stack.pop()
            if eid in seen or eid not in self.e:
                continue
            seen.add(eid)
            t, body = self.e[eid]
            if t == "CARTESIAN_POINT":
                if eid in self.vertex_pts:
                    p = self.point(eid)
                    if len(p) == 3:
                        pts.append(p)
                continue
            stack.extend(refs(body))
        return pts


def apply_default(a, i):
    if i >= len(a) or a[i].strip() in ("$", "*"):
        return None
    r = refs(a[i])
    return r[0] if r else None


def bbox(pts):
    return ([min(p[i] for p in pts) for i in range(3)],
            [max(p[i] for p in pts) for i in range(3)])


PCB_NAMES = ("board", "pcb")


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    path, wanted = argv[0], [w.upper() for w in argv[1:]]
    r = Reader(path)
    graph = r.transform_graph()
    prods = r.products()

    # Measure everything once: the datum has to be found whatever the filter is.
    measured, pcb = [], None
    for name, instances in prods.items():
        for idx, (_pd, rep) in enumerate(instances):
            pts = r.rep_points(rep)
            if not pts:
                continue
            lo, hi = bbox([apply(r.to_root(rep, graph), p) for p in pts])
            measured.append((name, idx, lo, hi))
            # The PCB is identified by SHAPE, not by name: this vendor exports it
            # under the translator's own name, which the root assembly shares.
            span = [hi[i] - lo[i] for i in range(3)]
            if pcb is None and 20 < span[0] < 26 and 20 < span[1] < 26 and span[2] < 2:
                pcb = (lo, hi)

    parts = [p for p in measured
             if not wanted or any(w in p[0].upper() for w in wanted)]
    if not parts:
        print("no named solids matched")
        return 1

    if pcb is None:
        print("!! PCB datum not found — coordinates are RAW STEP, not board coords\n")
        ox = oy = oz = 0.0
    else:
        (plo, phi) = pcb
        ox, oy, oz = (plo[0] + phi[0]) / 2, (plo[1] + phi[1]) / 2, phi[2]
        print(f"datum: PCB {phi[0]-plo[0]:.2f} x {phi[1]-plo[1]:.2f} x "
              f"{phi[2]-plo[2]:.3f}, centre ({ox:.3f}, {oy:.3f}), top z {oz:.3f}\n")

    print(f"{'part':38} {'x range':>16} {'y range':>16} {'z range':>16}   size")
    for name, idx, lo, hi in sorted(parts, key=lambda p: p[0]):
        x0, y0, z0 = lo[0] - ox, lo[1] - oy, lo[2] - oz
        x1, y1, z1 = hi[0] - ox, hi[1] - oy, hi[2] - oz
        tag = f"{name}" + (f"#{idx}" if len(prods.get(name, [])) > 1 else "")
        print(f"{tag[:38]:38} {x0:7.2f}..{x1:6.2f} {y0:7.2f}..{y1:6.2f} "
              f"{z0:7.2f}..{z1:6.2f}   {x1-x0:5.2f} x {y1-y0:5.2f} x {z1-z0:5.2f}")
        print(f"{'':38} centre ({(x0+x1)/2:+6.2f}, {(y0+y1)/2:+6.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
