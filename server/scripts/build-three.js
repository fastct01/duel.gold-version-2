/* Bundles the few three.js classes the sign-in background (public/ribbons.js) uses into one tree-shaken, minified ES module at
   public/lib/three.min.js. The page's CSP allows same-origin scripts only, so three is served from here, not a CDN.
   Run after upgrading three: npm run build:three */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = [
  "WebGLRenderer", "Scene", "PerspectiveCamera", "Mesh", "Color", "BufferGeometry", "BufferAttribute", "InstancedBufferGeometry",
  "InstancedBufferAttribute", "SphereGeometry", "PlaneGeometry", "MeshPhysicalMaterial", "MeshBasicMaterial", "NeutralToneMapping",
  "PMREMGenerator", "DoubleSide", "BackSide",
];
await build({
  stdin: { contents: `export { ${names.join(", ")} } from "three";`, resolveDir: root, loader: "js" },
  bundle: true, format: "esm", minify: true, target: "es2020", legalComments: "eof",
  outfile: path.join(root, "public", "lib", "three.min.js"),
  logLevel: "info",
});
