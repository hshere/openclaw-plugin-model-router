import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "openclaw.plugin.json");
const packagePath = path.join(root, "package.json");
const entryPath = path.join(root, "dist/index.js");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read JSON from ${file}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = readJson(manifestPath);
const pkg = readJson(packagePath);

assert(manifest.id === "model-router", "openclaw.plugin.json id must be model-router");
assert(typeof manifest.name === "string" && manifest.name.length > 0, "manifest name is required");
assert(
  manifest.configSchema && typeof manifest.configSchema === "object",
  "manifest configSchema object is required",
);
assert(
  manifest.configSchema.additionalProperties === false,
  "manifest configSchema should reject unknown top-level config keys",
);
assert(
  manifest.configSchema.properties?.categoryDescriptions?.additionalProperties?.type === "string",
  "manifest configSchema must include categoryDescriptions as string values",
);
assert(manifest.activation?.onStartup === true, "activation.onStartup must be true");
assert(
  Array.isArray(manifest.activation?.onCapabilities) &&
    manifest.activation.onCapabilities.includes("hook"),
  'activation.onCapabilities must include "hook" for hook-only startup intent',
);
assert(
  Array.isArray(pkg.openclaw?.extensions) && pkg.openclaw.extensions.includes("./dist/index.js"),
  'package.json openclaw.extensions must include "./dist/index.js"',
);
assert(fs.existsSync(entryPath), "dist/index.js is missing; run npm run build first");

const imported = await import(pathToFileURL(entryPath).href);
const entry = imported.default ?? imported.entry ?? imported.createEntry?.();

assert(entry && typeof entry === "object", "dist entry must export a plugin entry object");
assert(entry.id === manifest.id, "dist entry id must match manifest id");
assert(typeof entry.register === "function", "dist entry must expose register(api)");

console.log("Hook plugin metadata sanity check passed.");
