/* Bundles what the sign-in background (public/ribbons.js + public/vault-objects.js) uses into tree-shaken, minified ES modules:
     public/lib/three.min.js   the few three.js classes the scene needs
     public/lib/gsap.min.js    GSAP core, which runs the scene's intro timeline
   The page's CSP allows same-origin scripts only, so both are served from here, not a CDN.
   Run after upgrading three or gsap: npm run build:three */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = [
  "WebGLRenderer", "Scene", "PerspectiveCamera", "Mesh", "Group", "Color", "BufferGeometry", "BufferAttribute", "InstancedBufferGeometry",
  "InstancedBufferAttribute", "SphereGeometry", "PlaneGeometry", "CylinderGeometry", "TorusGeometry", "ExtrudeGeometry", "ShapeGeometry",
  "EdgesGeometry", "Shape", "Path", "LineSegments", "LineBasicMaterial", "MeshPhysicalMaterial", "MeshBasicMaterial", "NeutralToneMapping",
  "PMREMGenerator", "DoubleSide", "BackSide",
];
const common = { bundle: true, format: "esm", minify: true, target: "es2020", legalComments: "eof", logLevel: "info" };
await build({
  ...common,
  stdin: { contents: `export { ${names.join(", ")} } from "three";`, resolveDir: root, loader: "js" },
  outfile: path.join(root, "public", "lib", "three.min.js"),
});
await build({
  ...common,
  stdin: { contents: `export { gsap } from "gsap";`, resolveDir: root, loader: "js" },
  outfile: path.join(root, "public", "lib", "gsap.min.js"),
});
