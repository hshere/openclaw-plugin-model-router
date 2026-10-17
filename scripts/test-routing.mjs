import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Fixture file for the file:// promptText case.
const fixtureDir = fs.mkdtempSync(path.join(process.cwd(), "prompt-text-fixtures-"));
const fixturePath = path.join(fixtureDir, "code-instructions.md");
fs.writeFileSync(fixturePath, "# Code guidance\nAlways run the test suite before finishing.");
const fixtureUrl = pathToFileURL(fixturePath).href;

const entryPath = path.resolve("dist/index.js");
const imported = await import(pathToFileURL(entryPath).href);
const entry = imported.default;

const handlers = new Map();
const completionPrompts = [];
let completionText = '{"category":"Chat"}';

const api = {
  pluginConfig: {
    agents: {
      main: {
        categories: {
          Chat: {
            model: "ollama/chat",
            toolsAllow: ["message"],
            promptText: "Keep replies short and friendly.",
          },
          General: {
            model: "ollama/general",
            promptText: fixtureUrl,
          },
          Web: {
            model: "ollama/web",
            promptText: "https://example.com/instructions.md",
          },
        },
        categoryDescriptions: {
          Chat: "Casual conversation.",
          General: "Default work.",
        },
        defaultCategory: "General",
      },
    },
  },
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
  runtime: {
    llm: {
      async complete(request) {
        completionPrompts.push(request.messages[0].content);
        return { text: completionText };
      },
    },
  },
  on(name, handler) {
    handlers.set(name, handler);
  },
};

entry.register(api);

const beforeModelResolve = handlers.get("before_model_resolve");
const beforePromptBuild = handlers.get("before_prompt_build");
assert(typeof beforeModelResolve === "function", "before_model_resolve handler missing");
assert(typeof beforePromptBuild === "function", "before_prompt_build handler missing");

const chatModel = await beforeModelResolve(
  { prompt: "say hello" },
  { agentId: "main", runId: "case-chat" },
);
assert(chatModel?.modelOverride === "ollama/chat", "mixed-case classifier label should route to Chat model");
assert(
  completionPrompts[0].includes("- Chat: Casual conversation."),
  "mixed-case categoryDescriptions key should appear in classifier prompt",
);

const chatTools = await beforePromptBuild(
  { prompt: "say hello" },
  { agentId: "main", runId: "case-chat" },
);
assert(
  Array.isArray(chatTools?.toolsAllow) && chatTools.toolsAllow.includes("message"),
  "cached mixed-case category should reuse Chat toolsAllow",
);
assert(
  chatTools?.appendSystemContext === "Keep replies short and friendly.",
  "inline promptText should be appended to the system context",
);

completionText = '{"category":"General"}';
const generalPrompt = await beforePromptBuild(
  { prompt: "do general work" },
  { agentId: "main", runId: "case-general" },
);
assert(
  generalPrompt?.appendSystemContext ===
    "# Code guidance\nAlways run the test suite before finishing.",
  "file:// promptText should be loaded once at registration and appended",
);
assert(generalPrompt?.toolsAllow === undefined, "category without toolsAllow should not set one");

completionText = '{"category":"Web"}';
const webPrompt = await beforePromptBuild(
  { prompt: "look something up" },
  { agentId: "main", runId: "case-web" },
);
assert(
  webPrompt?.appendSystemContext === undefined,
  "http(s) promptText URLs must be rejected, not fetched or inlined",
);

completionText = "not json";
const fallbackModel = await beforeModelResolve(
  { prompt: "unknown request" },
  { agentId: "main", runId: "case-default" },
);
assert(
  fallbackModel?.modelOverride === "ollama/general",
  "mixed-case defaultCategory should fall back to General model",
);

const skipped = await beforeModelResolve(
  { prompt: "say hello" },
  { agentId: "unconfigured", runId: "case-skip" },
);
assert(skipped === undefined, "unconfigured agent should be skipped");

fs.rmSync(fixtureDir, { recursive: true, force: true });
assert(skipped === undefined, "unconfigured agent should be skipped");

console.log("Routing behavior test passed.");
