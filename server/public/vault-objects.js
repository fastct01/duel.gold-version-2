/* The floating gold objects of the sign-in background, drawn into the ribbons' scene (ribbons.js owns the renderer and the loop):
   a vault door, a play tile, star coins, small cubes and smoked-glass shards, after the brand artwork.
   - Every object is built once from three's stock geometry (extruded shapes, cylinders, tori), in two materials: polished gold
     and a dark lacquer, both lit only by the scene's studio environment.
   - layout(w, h, band, ...) places them from a table in screen terms (fractions of the canvas width and of the art band's
     height), so the composition holds at every size: to the right of the text on wide screens, in the band above the headline
     on narrow ones.
   - update(t, intro, scroll, px, py) poses them each frame: a slow float and tilt, depth parallax for pointer and scroll, and the
     intro (0 → 1 per object, driven by a GSAP timeline in ribbons.js) that brings each one forward out of the dark. */
import {
  Group, Mesh, Color, CylinderGeometry, TorusGeometry, SphereGeometry, ExtrudeGeometry, ShapeGeometry, EdgesGeometry, Shape, Path,
  LineSegments, LineBasicMaterial, MeshPhysicalMaterial, DoubleSide,
} from "/play/lib/three.min.js";

const PI = Math.PI;
const Z0 = 3; // every object sits this far in front of the ribbons' nearest band, so no band ever cuts through one

/* ------------------------------------------------------------ shapes */

function roundRect(target, w, h, r) {
  const x = -w / 2, y = -h / 2;
  target.moveTo(x + r, y);
  target.lineTo(x + w - r, y); target.quadraticCurveTo(x + w, y, x + w, y + r);
  target.lineTo(x + w, y + h - r); target.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  target.lineTo(x + r, y + h); target.quadraticCurveTo(x, y + h, x, y + h - r);
  target.lineTo(x, y + r); target.quadraticCurveTo(x, y, x + r, y);
  return target;
}

/* a four-point star with softly concave sides */
function star(s) {
  const p = new Shape(), k = 0.16 * s;
  p.moveTo(0, s);
  p.quadraticCurveTo(k, k, s, 0);
  p.quadraticCurveTo(k, -k, 0, -s);
  p.quadraticCurveTo(-k, -k, -s, 0);
  p.quadraticCurveTo(-k, k, 0, s);
  return p;
}

/* a play triangle with rounded corners, centred on its visual middle */
function playTriangle(s) {
  const pts = [[-0.42, 0.62], [0.66, 0], [-0.42, -0.62]].map(([x, y]) => [x * s, y * s]), r = 0.16 * s, p = new Shape();
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (let i = 0; i < 3; i++) {
    const a = pts[(i + 2) % 3], b = pts[i], c = pts[(i + 1) % 3];
    const p1 = lerp(b, a, r / len(a, b)), p2 = lerp(b, c, r / len(b, c));
    if (i === 0) p.moveTo(...p1); else p.lineTo(...p1);
    p.quadraticCurveTo(b[0], b[1], ...p2);
  }
  p.closePath();
  return p;
}

/* a leaning parallelogram with soft corners: the smoked-glass shards */
function shard(w, h, lean) {
  const p = new Shape(), r = Math.min(w, h) * 0.12;
  const c = [[-w / 2 - lean, -h / 2], [w / 2 - lean, -h / 2], [w / 2 + lean, h / 2], [-w / 2 + lean, h / 2]];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let i = 0; i < 4; i++) {
    const a = c[(i + 3) % 4], b = c[i], d = c[(i + 1) % 4];
    const la = Math.hypot(b[0] - a[0], b[1] - a[1]), ld = Math.hypot(d[0] - b[0], d[1] - b[1]);
    const p1 = lerp(b, a, r / la), p2 = lerp(b, d, r / ld);
    if (i === 0) p.moveTo(...p1); else p.lineTo(...p1);
    p.quadraticCurveTo(b[0], b[1], ...p2);
  }
  p.closePath();
  return p;
}

/* an extrusion centred on z = 0, its front face (bevel included) at +depth/2 + bevel */
function extrude(shape, depth, bevel, segs = 3) {
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: segs, curveSegments: 18 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/* ------------------------------------------------------------ objects (each about 2 units across, before layout scaling) */

function coin(M) {
  const g = new Group();
  g.add(new Mesh(new CylinderGeometry(1, 1, 0.34, 72, 1).rotateX(PI / 2), M.gold));
  g.add(new Mesh(new CylinderGeometry(0.72, 0.72, 0.352, 72, 1).rotateX(PI / 2), M.dark));
  for (const side of [1, -1]) {
    const rim = new Mesh(new TorusGeometry(0.8, 0.075, 14, 72), M.gold);
    rim.position.z = side * 0.17;
    g.add(rim);
    const s = new Mesh(extrude(star(0.4), 0.04, 0.025), M.gold);
    s.position.z = side * 0.2;
    if (side < 0) s.rotation.y = PI;
    g.add(s);
  }
  return g;
}

function playTile(M) {
  const g = new Group();
  g.add(new Mesh(extrude(roundRect(new Shape(), 2, 2, 0.5), 0.3, 0.07), M.gold));
  const face = new Mesh(extrude(roundRect(new Shape(), 1.7, 1.7, 0.36), 0.04, 0.012, 2), M.dark);
  face.position.z = 0.215;
  g.add(face);
  const tri = new Mesh(extrude(playTriangle(0.62), 0.05, 0.03), M.gold);
  tri.position.set(0.05, 0, 0.26);
  g.add(tri);
  return g;
}

function vault(M) {
  const g = new Group();
  /* the frame: a thick gold rounded square with a square opening */
  const frame = roundRect(new Shape(), 3, 3, 0.62);
  frame.holes.push(roundRect(new Path(), 2.36, 2.36, 0.34));
  g.add(new Mesh(extrude(frame, 0.5, 0.09), M.gold));
  /* the recess behind the door, then the door, set in with a dark gap all round */
  const back = new Mesh(extrude(roundRect(new Shape(), 2.5, 2.5, 0.4), 0.2, 0), M.void);
  back.position.z = -0.12;
  g.add(back);
  const door = new Mesh(extrude(roundRect(new Shape(), 2.12, 2.12, 0.26), 0.12, 0.04), M.dark);
  door.position.z = 0.08;
  g.add(door);
  /* the dial: a hub, a ring and eight spokes with round knobs. It turns on its own (update) */
  const dial = new Group();
  dial.position.z = 0.27;
  dial.add(new Mesh(new CylinderGeometry(0.24, 0.24, 0.16, 48).rotateX(PI / 2), M.gold));
  dial.add(new Mesh(new TorusGeometry(0.4, 0.075, 14, 56), M.gold));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2;
    const spoke = new Mesh(new CylinderGeometry(0.055, 0.055, 0.42, 12), M.gold);
    spoke.position.set(Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0);
    spoke.rotation.z = a - PI / 2;
    dial.add(spoke);
    const knob = new Mesh(new SphereGeometry(0.085, 16, 12), M.gold);
    knob.position.set(Math.cos(a) * 0.88, Math.sin(a) * 0.88, 0);
    dial.add(knob);
  }
  g.add(dial);
  g.userData.dial = dial;
  /* two hinges on the right-hand side */
  for (const y of [0.62, -0.62]) {
    const h = new Mesh(extrude(roundRect(new Shape(), 0.3, 0.48, 0.07), 0.36, 0.04), M.gold);
    h.position.set(1.6, y, 0.02);
    g.add(h);
  }
  return g;
}

function cube(M) {
  const s = 0.5, g = new Group();
  g.add(new Mesh(extrude(roundRect(new Shape(), s, s, 0.04), s, 0.07), M.gold));
  return g;
}

function glass(M, w, h, lean) {
  const g = new Group(), geo = new ShapeGeometry(shard(w, h, lean), 12);
  g.add(new Mesh(geo, M.glass));
  g.add(new LineSegments(new EdgesGeometry(geo), M.edge));
  return g;
}

/* ------------------------------------------------------------ the composition

   Each entry: kind, where it sits on wide (x, y) and narrow (mx, my) screens, its depth z, its size, its resting turn (rx, ry, rz)
   and a phase for its float. x is a fraction of the canvas width; y a fraction of the art band (the first screen on wide layouts,
   the open band above the headline on narrow ones). Size is in px at 1440 × 900 (wide) or 390 wide (narrow); m: 0 hides it there. */
const PLAN = [
  { kind: "vault", x: 0.83, y: 0.38, mx: 0.72, my: 0.47, z: 0.6, size: 290, m: 150, rx: 0.12, ry: -0.5, rz: 0.12, ph: 0.2 },
  { kind: "play", x: 0.625, y: 0.63, mx: 0.27, my: 0.66, z: 0.2, size: 172, m: 84, rx: -0.12, ry: 0.42, rz: -0.12, ph: 1.4 },
  { kind: "coin", x: 0.63, y: 0.25, mx: 0.17, my: 0.2, z: -0.4, size: 128, m: 60, rx: 0.5, ry: 0.55, rz: -0.25, ph: 2.6 },
  { kind: "coin", x: 0.55, y: 0.84, mx: 0, my: 0, z: 0.4, size: 104, m: 0, rx: -0.45, ry: 0.65, rz: 0.2, ph: 3.3 },
  { kind: "coin", x: 0.94, y: 0.85, mx: 0.96, my: 0.93, z: 1.4, size: 190, m: 78, rx: -0.3, ry: -0.6, rz: 0.15, ph: 4.1 },
  { kind: "cube", x: 0.53, y: 0.13, mx: 0.47, my: 0.16, z: -0.8, size: 52, m: 30, rx: 0.6, ry: 0.7, rz: 0.2, ph: 0.9 },
  { kind: "cube", x: 0.735, y: 0.8, mx: 0.53, my: 0.9, z: 0.9, size: 46, m: 24, rx: 0.4, ry: -0.6, rz: 0.5, ph: 5.2 },
  { kind: "glass", w: 1.5, h: 0.9, lean: 0.35, x: 0.56, y: 0.46, mx: 0.06, my: 0.5, z: -1.6, size: 120, m: 64, rx: 0, ry: 0.3, rz: 0.55, ph: 0.5 },
  { kind: "glass", w: 1.8, h: 0.8, lean: 0.4, x: 0.74, y: 0.12, mx: 0.9, my: 0.1, z: -2.2, size: 150, m: 70, rx: 0.1, ry: -0.2, rz: 0.45, ph: 1.9 },
  { kind: "glass", w: 1.3, h: 0.9, lean: 0.3, x: 0.75, y: 0.66, mx: 0, my: 0, z: -1.2, size: 110, m: 0, rx: -0.1, ry: 0.25, rz: 0.6, ph: 2.8 },
  { kind: "glass", w: 1.6, h: 0.75, lean: 0.4, x: 0.62, y: 0.99, mx: 0, my: 0, z: -1.8, size: 140, m: 0, rx: 0.2, ry: 0.1, rz: 0.5, ph: 3.7 },
  { kind: "glass", w: 1.2, h: 0.7, lean: 0.3, x: 0.985, y: 0.2, mx: 0, my: 0, z: -2.6, size: 110, m: 0, rx: 0, ry: -0.3, rz: 0.7, ph: 4.6 },
];

export function createObjects(scene, gold) {
  const M = {
    gold: new MeshPhysicalMaterial({ color: gold, metalness: 1, roughness: 0.24, envMapIntensity: 1.35 }),
    dark: new MeshPhysicalMaterial({ color: new Color(0.035, 0.026, 0.016), metalness: 0.55, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3, envMapIntensity: 0.9 }),
    void: new MeshPhysicalMaterial({ color: new Color(0.006, 0.005, 0.004), metalness: 0.2, roughness: 0.8 }),
    glass: new MeshPhysicalMaterial({ color: new Color(0.06, 0.045, 0.025), metalness: 0.4, roughness: 0.3, transparent: true, opacity: 0.5, depthWrite: false, side: DoubleSide, envMapIntensity: 0.8 }),
    edge: new LineBasicMaterial({ color: gold, transparent: true, opacity: 0.4, depthWrite: false }),
  };
  const make = { vault, play: playTile, coin, cube, glass: (m, p) => glass(m, p.w, p.h, p.lean) };
  const native = { vault: 3.3, play: 2.1, coin: 2, cube: 0.62 }; // the width the size in PLAN refers to
  const items = PLAN.map((p) => {
    const obj = make[p.kind](M, p);
    obj.visible = false;
    scene.add(obj);
    return { p, obj, native: native[p.kind] || p.w + 2 * p.lean, base: [0, 0, 0], s: 1, intro: 0 };
  });
  return { items, materials: M };
}

/* place every object for a canvas of w × h px whose art band is `band` px tall; worldAt(z) gives the half height of the view at
   depth z (in world units), so the screen-space plan lands where it should whatever its depth */
export function layout(O, w, h, band, halfAt) {
  const narrow = w < 900;
  const k = narrow ? Math.min(1.6, Math.max(0.85, w / 390)) : Math.min(1.35, Math.max(0.62, Math.min(w / 1440, band / 900)));
  for (const it of O.items) {
    const { p } = it;
    const size = narrow ? p.m : p.size;
    it.obj.userData.on = size > 0;
    if (!size) { it.obj.visible = false; continue; }
    const fx = narrow ? p.mx : p.x, fy = narrow ? p.my : p.y;
    const halfH = halfAt(Z0 + p.z), perPx = (2 * halfH) / h;
    it.base = [(fx * 2 - 1) * halfH * (w / h), halfH - fy * band * perPx, Z0 + p.z];
    it.s = (size * k * perPx) / it.native;
  }
}

const easeOut = (x) => 1 - Math.pow(1 - x, 3);

/* pose every object for time t (seconds of sway), page scroll 0..1 and pointer -1..1 */
export function update(O, t, scroll, px, py) {
  for (const it of O.items) {
    const { p, obj } = it;
    if (!obj.userData.on) continue;
    const e = easeOut(Math.min(1, Math.max(0, it.intro)));
    obj.visible = e > 0.001;
    if (!obj.visible) continue;
    const depth = 1 + p.z * 0.35; // nearer objects move more
    const fl = Math.sin(t * 0.8 + p.ph);
    obj.position.set(
      it.base[0] + px * 0.12 * depth,
      it.base[1] + fl * 0.27 * it.s - py * 0.08 * depth + scroll * (0.5 + p.z * 0.4),
      it.base[2] - (1 - e) * 5,
    );
    obj.scale.setScalar(it.s * (0.55 + 0.45 * e));
    const spin = (1 - e) * 1.4;
    obj.rotation.set(
      p.rx + Math.sin(t * 0.5 + p.ph) * 0.07 + py * 0.08 + spin * 0.4,
      p.ry + Math.sin(t * 0.42 + p.ph * 1.3) * (p.kind === "coin" ? 0.28 : 0.1) + px * 0.12 - spin + scroll * 0.4,
      p.rz + Math.sin(t * 0.37 + p.ph) * 0.05,
    );
    if (obj.userData.dial) obj.userData.dial.rotation.z = Math.sin(t * 0.35) * 1.1 + (1 - e) * 2.4;
  }
}
