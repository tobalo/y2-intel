#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const outputDir = resolve(process.argv[2] || resolve(repoRoot, "sdk/dist/term-demo"));
const htmlPath = resolve(repoRoot, "sdk/term-demo.html");
const browserPath = resolve(repoRoot, "sdk/browser.js");
const sdkPath = resolve(repoRoot, "sdk/y2-sdk.js");
const wasmPath = resolve(repoRoot, "zig-out/bin/y2-term.wasm");

const [htmlSource, browserBytes, sdkBytes, wasmBytes] = await Promise.all([
  readFile(htmlPath, "utf8"),
  readFile(browserPath),
  readFile(sdkPath),
  readFile(wasmPath),
]);

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes) => `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
const sdkHash = digest(sdkBytes);
const wasmHash = digest(wasmBytes);
const sdkName = `y2-sdk.${sdkHash}.js`;
const wasmName = `y2-term.${wasmHash}.wasm`;
const packagedBrowser = Buffer.from(
  browserBytes.toString().replace('from "./y2-sdk.js";', `from "./${sdkName}";`),
);
const browserHash = digest(packagedBrowser);
const browserName = `browser.${browserHash}.js`;

const replacements = [
  ['const y2WasmAsset = "./y2-term.wasm";', `const y2WasmAsset = "./${wasmName}";`],
  ['const y2WasmIntegrity = "";', `const y2WasmIntegrity = "${integrity(wasmBytes)}";`],
  ['from "./browser.js";', `from "./${browserName}";`],
];
let html = htmlSource;
for (const [source, replacement] of replacements) {
  const first = html.indexOf(source);
  if (first < 0 || html.indexOf(source, first + source.length) >= 0) {
    throw new Error(`expected exactly one packaging placeholder: ${source}`);
  }
  html = html.replace(source, replacement);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, "index.html"), html),
  writeFile(resolve(outputDir, browserName), packagedBrowser),
  writeFile(resolve(outputDir, sdkName), sdkBytes),
  writeFile(resolve(outputDir, wasmName), wasmBytes),
]);

const manifest = {
  html: "index.html",
  browser: { file: browserName, sha256: digest(packagedBrowser), bytes: packagedBrowser.byteLength },
  sdk: { file: sdkName, sha256: sdkHash, bytes: sdkBytes.byteLength },
  wasm: { file: wasmName, sha256: wasmHash, integrity: integrity(wasmBytes), bytes: wasmBytes.byteLength },
};
await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`packaged ${basename(outputDir)}`);
console.log(`  ${browserName}`);
console.log(`  ${sdkName}`);
console.log(`  ${wasmName}`);
