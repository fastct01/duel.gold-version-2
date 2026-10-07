/* The sign-in background, drawn live with three.js: a fan of thin gold bands with rolled edges, nested like the folds of a
   metal ribbon sculpture. They sway slowly on their own, and unfurl and spread in depth as the page scrolls.
   - Every band is the same flat strip, shaped on the GPU: the vertex shader bends it along an arc, twists it between face-on
     and edge-on, curls its two long edges (the bright rim lines) and works out its normals by finite differences.
   - One renderer for the whole session, in a <canvas class="bg-ribbons"> on <body>, under #main. app.js rebuilds #main on
     every render, so the canvas lives outside it; attach() shows it on the sign-in page, detach() hides it elsewhere.
   - It renders only while on screen, the tab is visible and the sign-in page is showing.
   - prefers-reduced-motion: one still frame, redrawn on resize.
   - attach() returns false when WebGL is unavailable; the page is then simply dark. */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Mesh, Color, BufferGeometry, BufferAttribute, InstancedBufferGeometry,
  InstancedBufferAttribute, SphereGeometry, PlaneGeometry, MeshPhysicalMaterial, MeshBasicMaterial, NeutralToneMapping,
  PMREMGenerator, DoubleSide, BackSide,
} from "/play/lib/three.min.js";

const FOV = 35, CAM_Z = 14;
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const fine = matchMedia("(pointer: fine)");
let R = null;

/* position.xy of the base strip is (u, w): u runs along the band (−1..1), w across it (−1..1).
   aRib per band: x its place in the fan (0 inside .. 1 outside), y a random seed, z half its width, w its arc radius. */
const GLSL = /* glsl */ `
uniform float uTime;
uniform float uScroll;
uniform vec2 uPivot;
uniform float uSpread;
attribute vec4 aRib;

/* Each band runs from straight up to straight right round the pivot (just off the top-right corner), so both of its ends always
   leave the frame: past the top and past the right-hand edge, at every size, sway and scroll. Only the stretch from pointing left
   to pointing down (ARC_SHOWN) is ever in view; the shape is a function of the angle, so the extra length changes nothing you see. */
#define ARC_FROM 1.5708
#define ARC_TO 6.2832
#define ARC_SHOWN vec2(2.95, 4.8)
float ribAngle(float u) { return mix(ARC_FROM, ARC_TO, u * 0.5 + 0.5); }

vec3 ribCentre(float u) {
  float i = aRib.x, t = uTime;
  /* Neighbouring bands share one wave with a small phase step, so the fan moves as nested layers, never as loose strands.
     Scrolling sweeps the outer bands further round. */
  float a = ribAngle(u) + uScroll * (0.1 + 0.28 * i);
  float wave = sin(a * 2.6 + t * 0.32 - i * 1.9) * (0.35 + 0.45 * i) + 0.12 * sin(a * 5.0 - t * 0.21 + aRib.y);
  vec3 p = vec3(uPivot + vec2(cos(a), sin(a)) * uSpread * (aRib.w + wave), 0.0);
  p.z = -i * (2.2 + uScroll * 2.4) + 0.9 * sin(a * 1.7 + t * 0.2 - i * 2.4);
  return p;
}

vec3 ribPos(float u, float w) {
  vec3 c = ribCentre(u);
  vec3 T = normalize(ribCentre(u + 0.004) - ribCentre(u - 0.004));
  /* the band turns between lying in the picture plane (a wide face) and standing on edge (a thin bright line). The twist is set
     along the shown stretch (us: −1..1 across it), as it was before the bands were lengthened. */
  float us = (ribAngle(u) - ARC_SHOWN.x) / (ARC_SHOWN.y - ARC_SHOWN.x) * 2.0 - 1.0;
  float tw = 0.5 + 0.5 * sin(us * 2.2 + uTime * 0.18 - aRib.x * 2.2 + uScroll * 1.6);
  vec3 flat_ = normalize(cross(T, vec3(0.0, 0.0, 1.0)));
  vec3 side = normalize(mix(flat_, vec3(0.0, 0.0, 1.0), 0.15 + tw * 0.7));
  side = normalize(side - T * dot(side, T));
  vec3 N = cross(T, side);
  float e = smoothstep(0.72, 1.0, abs(w));
  return c + side * (w * aRib.z) + N * (e * e * aRib.z * 0.3); // the rolled lip along each edge
}

vec3 ribNormal(float u, float w) {
  vec3 du = ribPos(u + 0.0025, w) - ribPos(u - 0.0025, w);
  vec3 dw = ribPos(u, w + 0.04) - ribPos(u, w - 0.04);
  return normalize(cross(du, dw));
}
`;

/* a bright, soft studio: a large key overhead, long strips either side, a warm floor and a pale wall behind. Gold reflects
   these as the broad light faces and dark folds of the reference. Light values are linear and may exceed 1. */
function studio(renderer) {
  const env = new Scene();
  env.add(new Mesh(new SphereGeometry(30, 32, 16), new MeshBasicMaterial({ color: new Color(0.09, 0.07, 0.045), side: BackSide })));
  const panel = (w, h, rgb, k, pos) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(...rgb).multiplyScalar(k), side: DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); env.add(m);
  };
  panel(18, 8, [1, 0.93, 0.8], 3.2, [0, 13, 5]);       // key, above and in front
  panel(3, 24, [1, 0.95, 0.85], 2.2, [-13, 1, 4]);     // strip, left
  panel(3, 24, [1, 0.9, 0.78], 1.6, [13, -1, 3]);      // strip, right, warmer
  panel(12, 5, [1, 0.97, 0.92], 1.5, [2, 3, 14]);      // fill from the camera side
  panel(24, 24, [0.62, 0.45, 0.22], 0.55, [0, -14, 0]); // warm floor bounce
  panel(20, 20, [0.8, 0.66, 0.45], 0.35, [0, 0, -14]); // warm wall behind
  const pm = new PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.04).texture;
  pm.dispose();
  env.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return tex;
}

/* the shared strip: a (segs+1) × (across+1) grid of (u, w) points */
function strip(segs, across) {
  const pos = new Float32Array((segs + 1) * (across + 1) * 3), idx = [];
  for (let j = 0, k = 0; j <= across; j++) for (let i = 0; i <= segs; i++, k += 3) {
    pos[k] = (i / segs) * 2 - 1; pos[k + 1] = (j / across) * 2 - 1;
  }
  for (let j = 0; j < across; j++) for (let i = 0; i < segs; i++) {
    const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new InstancedBufferGeometry();
  g.setIndex(idx);
  g.setAttribute("position", new BufferAttribute(pos, 3));
  /* placeholder normals: the shader writes the real ones, but without this attribute three switches to flat shading */
  g.setAttribute("normal", new BufferAttribute(new Float32Array(pos.length), 3));
  return g;
}

/* deterministic, so the fan looks the same on every visit */
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function build() {
  let renderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch { return null; }
  if (!renderer.getContext()) return null;
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  const canvas = renderer.domElement;
  canvas.className = "bg-ribbons";
  canvas.style.removeProperty("display"); // three sets display:block inline, which would beat the stylesheet's [hidden] rule
  canvas.setAttribute("aria-hidden", "true");

  const scene = new Scene();
  scene.environment = studio(renderer);
  const camera = new PerspectiveCamera(FOV, 16 / 9, 1, 60);
  camera.position.set(0, 0, CAM_Z);

  const small = Math.min(screen.width, screen.height) < 700;
  const count = small ? 18 : 26;
  const geo = strip(small ? 510 : 760, 14); // ≈2.55× the old 200/300: the bands are longer, the shown stretch keeps its detail
  const rib = new Float32Array(count * 4), rand = rng(7);
  for (let k = 0; k < count; k++) {
    const i = k / (count - 1);
    rib.set([i, rand() * 6.28, 0.26 + rand() * 0.16, 3.2 + i * 7.4], k * 4);
  }
  geo.setAttribute("aRib", new InstancedBufferAttribute(rib, 4));
  geo.instanceCount = count;

  const U = { uTime: { value: 0 }, uScroll: { value: 0 }, uPivot: { value: [0, 0] }, uSpread: { value: 1 } };
  /* the UI's gold, a touch deeper and less saturated: metal reads richer than the flat swatch */
  const gold = new Color(getComputedStyle(document.documentElement).getPropertyValue("--gold-500").trim() || "#E7B52C").offsetHSL(0, -0.06, -0.04);
  const mat = new MeshPhysicalMaterial({ color: gold, metalness: 1, roughness: 0.2, envMapIntensity: 1.3, side: DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\n" + GLSL)
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = ribNormal(position.x, position.y);")
      .replace("#include <begin_vertex>", "vec3 transformed = ribPos(position.x, position.y);");
  };
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false; // the shader moves every vertex, so the strip's own bounds mean nothing
  scene.add(mesh);

  return {
    renderer, canvas, scene, camera, U,
    on: false, raf: 0, last: 0, t: 0, visible: false,
    scroll: 0, scrollT: 0, px: 0, py: 0, pxT: 0, pyT: 0, size: [0, 0],
  };
}

/* the fan's pivot sits just off the top-right corner; narrow screens get a tighter fan */
function frame3d(w, h) {
  const halfH = CAM_Z * Math.tan((FOV / 2) * Math.PI / 180), halfW = halfH * (w / h);
  R.U.uPivot.value = [halfW * 0.96, halfH * 1.04];
  R.U.uSpread.value = Math.min(1.15, Math.max(0.5, halfW / 7.8));
}

function resize() {
  const r = R.canvas.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  if (!w || !h || (w === R.size[0] && h === R.size[1])) return;
  R.size = [w, h];
  R.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, w * h > 1_200_000 ? 1.25 : 1.75));
  R.renderer.setSize(w, h, false);
  R.camera.aspect = w / h;
  R.camera.updateProjectionMatrix();
  frame3d(w, h);
  if (!R.raf) draw();
}

/* the canvas ends where "How it works" begins (at most a little over one screen), so its fade always finishes above that row */
function fit() {
  const side = document.querySelector(".landing-side");
  const until = side ? side.getBoundingClientRect().top + scrollY : innerHeight;
  R.canvas.style.height = Math.round(Math.max(480, Math.min(until, innerHeight * 1.15))) + "px";
}

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const scrollTarget = () => Math.min(1, Math.max(0, scrollY / Math.max(400, innerHeight * 0.9)));

function draw() {
  const { camera, U, scroll: s, px, py } = R;
  U.uTime.value = R.t;
  U.uScroll.value = s;
  /* the camera drifts up as the page scrolls, so the fan lags behind the content; a little sway follows a mouse */
  camera.position.set(px * 0.35, s * 1.6 - py * 0.2, CAM_Z + s * 1.5);
  camera.lookAt(px * 0.1, s * 1.2, 0);
  R.renderer.render(R.scene, camera);
}

function tick(now) {
  R.raf = 0;
  if (!R.on || !R.visible || document.hidden) return;
  const dt = Math.min(0.05, R.last ? (now - R.last) / 1000 : 0.016);
  R.last = now;
  const prev = R.scroll;
  R.scroll = damp(R.scroll, R.scrollT, 4, dt);
  R.px = damp(R.px, R.pxT, 2.5, dt); R.py = damp(R.py, R.pyT, 2.5, dt);
  R.t += dt * 0.55 + Math.abs(R.scroll - prev) * 2.5; // a slow sway, quickened a little while scrolling
  draw();
  R.raf = requestAnimationFrame(tick);
}

function wake() {
  if (!R || R.raf || !R.on || reduce.matches || !R.visible || document.hidden) return;
  R.last = 0;
  R.raf = requestAnimationFrame(tick);
}

function onScroll() { if (R.on && !reduce.matches) { R.scrollT = scrollTarget(); wake(); } }
function onPointer(e) {
  if (!fine.matches) return;
  R.pxT = (e.clientX / innerWidth) * 2 - 1;
  R.pyT = (e.clientY / innerHeight) * 2 - 1;
}

/* reduced motion: the resting pose, one frame */
function still() {
  if (!R || !R.on) return;
  if (!reduce.matches) { wake(); return; }
  cancelAnimationFrame(R.raf); R.raf = 0;
  Object.assign(R, { scroll: 0, scrollT: 0, px: 0, py: 0, pxT: 0, pyT: 0, t: 6 });
  draw();
}

let io = null, ro = null;
function listen() {
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("pointermove", onPointer, { passive: true });
  addEventListener("resize", () => { if (R.on) fit(); }, { passive: true });
  document.fonts?.ready.then(() => { if (R.on) fit(); }); // web fonts can move the row down once they arrive
  document.addEventListener("visibilitychange", wake);
  reduce.addEventListener("change", still);
  io = new IntersectionObserver(([e]) => { R.visible = e.isIntersecting; wake(); });
  ro = new ResizeObserver(resize);
}

export function attach() {
  if (!R) {
    R = build();
    if (!R) return false;
    listen();
    R.t = 6; // start mid-sway rather than from the symmetric pose
  }
  if (!R.on) {
    if (!R.canvas.isConnected) document.body.prepend(R.canvas);
    R.canvas.hidden = false;
    R.on = true;
    io.observe(R.canvas); ro.observe(R.canvas);
  }
  R.scrollT = reduce.matches ? 0 : scrollTarget();
  fit();
  resize();
  if (reduce.matches) still(); else wake();
  return true;
}

/* left the sign-in page: hide and stop drawing; the scene is kept for the next visit */
export function detach() {
  if (!R || !R.on) return;
  cancelAnimationFrame(R.raf); R.raf = 0;
  io.disconnect(); ro.disconnect();
  R.on = false; R.visible = false; R.size = [0, 0];
  R.canvas.hidden = true;
}
