#!/usr/bin/env node
// Rebuilds backend/node-llama-cpp-src from scratch: clones the upstream repo at the
// pinned tag, applies our patches, then builds it.
//
// We vendor a patched copy of node-llama-cpp instead of using the npm release because
// this app needs native bindings and sampler options that upstream doesn't expose:
//  - loadStateFromBuffer/saveStateToBuffer - see node-llama-cpp-patches/kv-cache-in-memory-buffer.patch.
//  - mirostat sampling (v1/v2) - see node-llama-cpp-patches/mirostat-sampling.patch.
//
// Requires: git, cmake, and a C++ toolchain (Xcode Command Line Tools on macOS) already
// installed - this script only handles the node-llama-cpp side of the build.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetDir = path.join(backendRoot, "node-llama-cpp-src");
const patchFiles = [
    path.join(backendRoot, "node-llama-cpp-patches", "kv-cache-in-memory-buffer.patch"),
    path.join(backendRoot, "node-llama-cpp-patches", "mirostat-sampling.patch"),
];

const NODE_LLAMA_CPP_REPO = "https://github.com/withcatai/node-llama-cpp.git";
const NODE_LLAMA_CPP_TAG = "v3.22.2";
// Pinned to the exact llama.cpp release that node-llama-cpp@3.22.2 ships prebuilt
// binaries for (see bins/*/_nlcBuildMetadata.json in its @node-llama-cpp/* binary
// packages). "latest" will drift and can break the addon build (llama.cpp's C API
// shifts between releases) - this bit us once already, keep it pinned. llama.cpp moved
// from bNNNNN build tags to semver tags (v0.x.y) around this release.
const LLAMA_CPP_RELEASE = "v0.7.0";
const GPU_OPTION = process.env.NLC_GPU || "auto";

function run(command, args, options = {}) {
    console.log(`> ${command} ${args.join(" ")}`);
    execFileSync(command, args, { stdio: "inherit", ...options });
}

if (fs.existsSync(targetDir)) {
    console.error(
        `${targetDir} already exists. Remove it first if you want to rebuild from scratch:\n` +
        `  rm -rf "${targetDir}"`
    );
    process.exit(1);
}

for (const patchFile of patchFiles) {
    if (!fs.existsSync(patchFile)) {
        console.error(`Patch file not found: ${patchFile}`);
        process.exit(1);
    }
}

run("git", [
    "clone", "--branch", NODE_LLAMA_CPP_TAG, "--depth", "1",
    "--recurse-submodules", "--shallow-submodules",
    NODE_LLAMA_CPP_REPO, targetDir,
]);

// Applied in order: mirostat-sampling.patch was captured as an incremental diff on top
// of kv-cache-in-memory-buffer.patch, so it must be applied second.
for (const patchFile of patchFiles) {
    console.log(`> git apply ${patchFile}`);
    run("git", ["apply", patchFile], { cwd: targetDir });
}

run("npm", ["install"], { cwd: targetDir });
run("npm", ["run", "build"], { cwd: targetDir });
run("node", [
    "./dist/cli/cli.js", "source", "download",
    "--release", LLAMA_CPP_RELEASE,
    "--gpu", GPU_OPTION,
    "--noUsageExample",
], { cwd: targetDir });

// dist/ and the native addon are built - the devDependencies (typescript, eslint,
// vitepress, electron, etc.) needed to get here are dead weight from here on. Drop them
// so backend's own `npm install` doesn't pull node-llama-cpp-src's whole dev toolchain
// into backend/package-lock.json.
const pkgJsonPath = path.join(targetDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
delete pkg.devDependencies;
delete pkg.scripts.prepare; // runs husky, which is a devDependency we just dropped
fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
run("npm", ["prune"], { cwd: targetDir });

console.log(
    "\nDone. node-llama-cpp-src is built with the in-memory KV-cache and mirostat-sampling patches applied.\n" +
    "Next: run `npm install` in backend/ so node-llama-cpp resolves to this local build."
);
