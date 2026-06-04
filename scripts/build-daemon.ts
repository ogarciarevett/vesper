#!/usr/bin/env bun
// Build the standalone Vesper daemon binary for the Tauri desktop sidecar (DEV-112 Slice 2).
//
// Steps:
//   1. Build the raw client assets (index.html shell + bundled app.js) from @vesper/ui.
//   2. Write them where compiled-entry.ts embeds them at compile time (`with { type: "text" }`).
//   3. Resolve the Rust host target triple (Tauri's externalBin requires a `-<triple>` suffix).
//   4. `bun build --compile` the compiled entry -> src-tauri/binaries/vesper-daemon-<triple>.
//
// Run from anywhere: `bun run build:daemon` (see root package.json) or `bun scripts/build-daemon.ts`.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildClientAssets } from "@vesper/ui";

const repoRoot = join(import.meta.dir, "..");
const genDir = join(repoRoot, "packages", "vesper-cli", "src", "generated");
const entry = join(repoRoot, "packages", "vesper-cli", "src", "compiled-entry.ts");
const binDir = join(repoRoot, "packages", "vesper-desktop", "src-tauri", "binaries");

console.log("building client assets…");
const assets = await buildClientAssets();
await mkdir(genDir, { recursive: true });
await writeFile(join(genDir, "index-html.txt"), assets.indexHtml);
await writeFile(join(genDir, "app-js.txt"), assets.appJs);
console.log(`  client: ${assets.indexHtml.length}B html, ${assets.appJs.length}B js`);

// Tauri appends the build target triple to externalBin names; match it to rustc's host.
const rustc = Bun.spawnSync(["rustc", "-Vv"]);
const triple = new TextDecoder().decode(rustc.stdout).match(/host:\s*(\S+)/)?.[1];
if (rustc.exitCode !== 0 || triple === undefined) {
  throw new Error("could not resolve the Rust host target triple — is rustc installed?");
}

await mkdir(binDir, { recursive: true });
const outFile = join(binDir, `vesper-daemon-${triple}`);
console.log(`compiling daemon -> ${outFile}`);
const build = Bun.spawnSync(["bun", "build", "--compile", "--outfile", outFile, entry], {
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  throw new Error("bun build --compile failed");
}
console.log("done.");
