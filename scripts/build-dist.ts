#!/usr/bin/env bun
// Build the publishable npm artifact for `@ogarciarevett/vesper`.
//
// The monorepo workspace deps (@vesper/core, @vesper/ui, @vesper/pipelines) are
// resolved by BUNDLING into one ESM file rather than publishing four interdependent
// packages. The opt-in WhatsApp-Web channel is lazy-loaded by variable-specifier
// dynamic import, so it never enters this static bundle (and is not a dependency of
// the published package).
//
// Steps:
//   1. Build the client assets (index.html + app.js) from @vesper/ui.
//   2. Write them where `dist-entry.ts` embeds them at build time (`with type: "text"`).
//   3. `bun build` dist-entry.ts -> dist/vesper.js (single Bun-target ESM file).
//   4. Guarantee the shebang + exec bit, then emit dist/package.json + README + LICENSE.
//
// Run from anywhere: `bun run build:dist` (root package.json) or `bun scripts/build-dist.ts`.
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildClientAssets } from "@vesper/ui";

const PACKAGE_NAME = "@ogarciarevett/vesper";
const SHEBANG = "#!/usr/bin/env bun\n";

const repoRoot = join(import.meta.dir, "..");
const cliSrc = join(repoRoot, "packages", "vesper-cli", "src");
const genDir = join(cliSrc, "generated");
const entry = join(cliSrc, "dist-entry.ts");
const distDir = join(repoRoot, "dist");
const outFile = join(distDir, "vesper.js");

// 1-2. Client assets, embedded by dist-entry so `vesper ui` works from the bundle.
console.log("building client assets…");
const assets = await buildClientAssets();
await mkdir(genDir, { recursive: true });
await writeFile(join(genDir, "index-html.txt"), assets.indexHtml);
await writeFile(join(genDir, "app-js.txt"), assets.appJs);
console.log(`  client: ${assets.indexHtml.length}B html, ${assets.appJs.length}B js`);

// 3. Bundle the CLI into one Bun-targeted ESM file.
await mkdir(distDir, { recursive: true });
console.log(`bundling ${PACKAGE_NAME} -> ${outFile}`);
const build = await Bun.build({
  entrypoints: [entry],
  outdir: distDir,
  target: "bun",
  naming: "vesper.js",
});
if (!build.success) {
  for (const message of build.logs) console.error(message);
  throw new Error("bun build failed");
}

// 4. bun build can drop a source shebang — guarantee it, plus the exec bit.
let code = await readFile(outFile, "utf8");
if (!code.startsWith("#!")) code = SHEBANG + code;
await writeFile(outFile, code);
await chmod(outFile, 0o755);

// The root package.json is `private`; this generated manifest is the only published
// surface. Version tracks the root so a release tag and the package agree.
const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  description: string;
};
const manifest = {
  name: PACKAGE_NAME,
  version: rootPkg.version,
  type: "module",
  description: rootPkg.description,
  bin: { vesper: "vesper.js" },
  engines: { bun: ">=1.1.0" },
  os: ["darwin"],
  files: ["vesper.js", "README.md", "LICENSE"],
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/ogarciarevett/vesper.git" },
  homepage: "https://github.com/ogarciarevett/vesper#readme",
  keywords: ["agent", "automation", "local-first", "cli", "bun"],
  publishConfig: { access: "public" },
};
await writeFile(join(distDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(join(repoRoot, "README.md"), join(distDir, "README.md"));
await copyFile(join(repoRoot, "LICENSE"), join(distDir, "LICENSE"));

console.log(`done: ${(code.length / 1024).toFixed(0)} KB bundle + package.json + README + LICENSE`);
console.log("publish with: (cd dist && npm publish --provenance)");
