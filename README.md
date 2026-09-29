# Model Router (OpenClaw plugin)

Classify each incoming turn with a small, fast local model, then:

1. **Route** the turn to the best specialist model for that category
   (`before_model_resolve` → `modelOverride`).
2. **Narrow** the tool surface for that turn to only the tools the category
   needs (`before_prompt_build` → `toolsAllow`).

The classification result is cached per run, so both hooks share a single
classifier call. If classification fails or times out, the turn falls back to
the session's default model and the default tool surface (fail-open).

## Why this shape

- **One small classifier, many specialists.** A 2B model is cheap and fast;
  it only has to pick a label, not do the work.
- **Per-turn tool narrowing** shrinks the prompt for weaker models (e.g. a
  local coder) without permanently stripping tools from any agent — this is
  more precise than the `localModelLean` flag, which is all-or-nothing per
  agent.
- **Fail-open.** A classifier hiccup never blocks a turn; you just get the
  default model.

## Install (local dev)

```bash
cd openclaw-plugin-model-router
npm install
npm run build
openclaw plugins install --link . --force
openclaw plugins enable model-router
```

Then grant conversation-hook access (required for non-bundled plugins using
`before_model_resolve` / `before_prompt_build`), grant LLM model-override trust
(required for the classifier call), and add your routing config — see the config
block below.

## Config block (paste into `openclaw.json`)

```json5
{
  "plugins": {
    "entries": {
      "model-router": {
        "enabled": true,
        "hooks": {
          // Required for non-bundled plugins to use conversation hooks.
          "allowConversationAccess": true
        },
        "llm": {
          // REQUIRED: the classifier calls api.runtime.llm.complete with an
          // explicit model. Without this, every classification throws
          // LLM_COMPLETION_NOT_AUTHORIZED and the plugin fails open to the
          // default category on every turn.
          "allowModelOverride": true,
          // RECOMMENDED: scope the classifier to the exact model(s) you intend
          // to use. Omit or set ["*"] only if you intentionally want any model.
          // Keep this list tight — it is the trust boundary for where prompts go.
          "allowedModels": ["ollama/qwen3.5:2b"]
        },
        "config": {
          "enabled": true,
          // Optional: verbose per-turn diagnostics (classifier completion
          // snapshot + raw classifier output). These can contain prompt-derived
          // text, so they are OFF by default — enable only while troubleshooting.
          // "debug": true,
          // Optional: only run this router for these OpenClaw agent ids.
          // Omit or leave empty to apply to every agent.
          "agents": ["main", "johnny"],
          // Small, fast classifier (local Ollama 2B).
          "classifierModel": "ollama/qwen3.5:2b",
          "classifierTimeoutMs": 3000,
          // Optional: model to use when classification fails/times out.
          // Omit to keep the session's default model.
          // "fallbackModel": "ollama/qwen3.8:27b",

          // category -> { model, toolsAllow? }
          "categories": {
            "chat": {
              "model": "ollama/qwen3.5:4b",
              // NOTE: on hosts where web search is a deferred tool (discovered
              // via tool_search, invoked via tool_call), include those two as
              // well — otherwise current-info turns lose working web search.
              "toolsAllow": ["read", "web_search", "tool_search", "tool_call", "message"]
            },
            "code": {
              "model": "ollama/qwen3-coder:30b",
              "toolsAllow": ["read", "write", "edit", "exec", "apply_patch", "ls"]
            },
            "reasoning": {
              "model": "ollama/qwen3.8:27b"
              // no toolsAllow -> full default surface
            },
            "general": {
              "model": "ollama/qwen3.8:27b"
            }
          },
          "defaultCategory": "general"
        }
      }
    }
  }
}
```

> **Note:** `toolsAllow` *caps* the tool surface for a turn; it cannot grant
> tools that policy already denies. Omitting `toolsAllow` for a category leaves
> the default surface unchanged. Multiple hooks' restrictions are intersected.

### Deferred tools (web search, etc.)

On hosts where a capability is exposed as a **deferred** tool — discovered with
`tool_search` and invoked through `tool_call` rather than as a directly
callable name — a `toolsAllow` list that names only the bare capability (e.g.
`web_search`) will *cap* the surface and drop the discovery/invocation pair.
The turn then loses working web search even though the model "has" it.

If you rely on per-turn tool narrowing for categories that need current info,
include the deferred-discovery tools in `toolsAllow` alongside the bare name:

```json5
"toolsAllow": ["read", "web_search", "tool_search", "tool_call", "message"]
```

If you are unsure whether a host uses direct or deferred tool exposure, the
safest option is to **omit `toolsAllow`** for that category (leaves the default
surface unchanged) rather than risk capping away a working capability.

### LLM trust (required)

The classifier is a real model call via `api.runtime.llm.complete` with an
explicit `model`. OpenClaw gates that on host-owned authorization:

- `plugins.entries.model-router.llm.allowModelOverride: true` — **required**,
  or every classification fails with `LLM_COMPLETION_NOT_AUTHORIZED` and the
  plugin silently falls back to `defaultCategory` (fail-open). You will see
  `model-router classification failed ... LLM_COMPLETION_NOT_AUTHORIZED` in the
  gateway log if this is missing.
- `plugins.entries.model-router.llm.allowedModels` — **recommended**. An
  allowlist of canonical `provider/model` refs the classifier may target. Keep
  it to exactly the model(s) you intend (e.g. `["ollama/qwen3.5:2b"]`). Use
  `["*"]` only if you deliberately want any model; that widens where prompts
  can be sent.
- `plugins.entries.model-router.llm.allowedCompletionModels` — optional, stricter
  knob applied to *every* completion (including host-resolved defaults). Set it
  to the same list as `allowedModels` if you want a single trust boundary.

## How it works

- If `config.agents` is omitted or empty, the router applies to every agent.
  If it contains agent ids, hooks first check the current hook context
  `agentId`; non-listed agents are skipped entirely. That means no classifier
  call, no `modelOverride`, and no `toolsAllow` cap - OpenClaw continues with
  the model and tools selected by that agent's normal config.
- `before_model_resolve` runs before model resolution for active agents. It
  classifies the prompt and returns `{ modelOverride }`.
- `before_prompt_build` runs before the prompt is assembled for active agents.
  It reuses the cached classification and returns `{ toolsAllow }` when the
  category defines one.
- The classifier is asked to reply with a single JSON object of the form
  `{"category": "<label>"}`. Parsing is **strict**: the entire response must be
  that one JSON object with a known label — surrounding prose, code fences, or
  extra fields are rejected (the turn falls back to `defaultCategory`). This is
  intentional: tolerant substring matching would let user prompt text steer
  routing by influencing classifier output.

## Config validation

The host validates the config block against the manifest `configSchema` at
plugin load time and **refuses to start** the plugin if shape/type errors are
found (unknown top-level keys, a category missing its required `model`, a
non-string `toolsAllow` entry, a `classifierTimeoutMs` below 1000, etc.).

On top of that, the plugin runs **startup semantic validation** at registration
and logs a `model-router config: ...` warning for each problem it finds. These
are issues the JSON schema cannot express:

- **No categories configured** while the plugin is enabled — every turn will
  silently fall back to the default model and tool surface.
- **`agents` omitted or empty** is intentional and means "all agents." If the
  list is present, values are trimmed before matching the hook context
  `agentId`.
- **`defaultCategory` points at a category that does not exist** —
  classification failures and unknown labels will be silently dropped instead
  of routed. Keys are compared case-insensitively (the classifier output is
  lowercased before lookup, so `Chat` and `chat` are the same routing target).
- **`categoryDescriptions` keys that match no configured category** — those
  descriptions are ignored by the classifier prompt.

These warnings appear in the gateway log at plugin startup (and again on every
hybrid reload after a config edit). Fix them to avoid silent no-ops or
misrouting.

## Notes & limits

- All OpenClaw plugin APIs are **experimental**; pin your host version and test
  each release you deploy against.
- The classifier call is a real model call on every (uncached) turn — keep the
  classifier small and the timeout tight.
- `toolsAllow` is applied by the embedded/CLI/Copilot runtimes. The Codex
  app-server harness rejects restrictive values (its tools are thread-scoped);
  use an embedded or Copilot runtime if you rely on per-turn tool narrowing.
