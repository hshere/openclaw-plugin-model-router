import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Model Router
 * ------------
 * A small, fast local model classifies each incoming turn into a category.
 * The plugin then:
 *   1. routes the turn to the best specialist model for that category
 *      (via `before_model_resolve` -> modelOverride), and
 *   2. narrows the tool surface for that turn to the tools the category needs
 *      (via `before_prompt_build` -> toolsAllow).
 *
 * Routing is configured per agent under config.agents.<agentId>; each section
 * carries its own categories and categoryDescriptions, so different agents can
 * route differently. Agents without a section are skipped entirely: no
 * classifier call, no model override, no tool cap.
 *
 * Classification uses STRUCTURED JSON output (a single "category" field with an
 * enum of valid labels) rather than free-text token parsing - this is more
 * robust against small models that add prose. The classifier runs with
 * thinking disabled so the label is emitted directly into content.
 *
 * The classification result is cached per run so both hooks share one call.
 * If classification fails or times out, the turn falls back to the session's
 * default model (or an explicit fallbackModel) and the default tool surface.
 */

type CategoryConfig = {
  /** Original configured key, used for logging and prompt labels. */
  name: string;
  model: string;
  toolsAllow?: string[];
};

type CategoryEntry = Record<string, unknown>;

/** Per-agent routing section under config.agents.<agentId>. */
type AgentSection = {
  categories?: Record<string, CategoryEntry>;
  /**
   * Optional per-category descriptions shown to the classifier. Use this to
   * disambiguate categories that a small model might confuse - e.g. explain
   * that "current" (news/prices/availability/releases) needs live lookup while
   * "reasoning" is timeless logic. Keys must match category names.
   */
  categoryDescriptions?: Record<string, string>;
  /**
   * Category used when the classifier output does not match a known key.
   * Defaults to "general" when omitted.
   */
  defaultCategory?: string;
};

type PluginConfig = {
  enabled?: boolean;
  /**
   * Enable verbose per-turn diagnostics (classifier completion snapshot and
   * raw classifier output). These can contain prompt-derived text, so they are
   * OFF by default. Enable only while troubleshooting routing.
   */
  debug?: boolean;
  /**
   * Map of OpenClaw agent id -> routing section for that agent. Only agents
   * with a section are routed; every other agent is skipped entirely (no
   * classifier call, no model override, no tool cap).
   */
  agents?: Record<string, AgentSection>;
  classifierModel?: string;
  classifierTimeoutMs?: number;
  fallbackModel?: string;
};

const DEFAULT_CLASSIFIER_MODEL = "ollama/qwen3.5:2b";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CATEGORY = "general";

/** Per-agent routing state resolved once at registration. */
type AgentRouting = {
  agentId: string;
  /** Categories keyed by lower-case name (the canonical routing key). */
  categories: Record<string, CategoryConfig>;
  descriptions: Record<string, string>;
  defaultCategory: string;
};

/**
 * Normalize one config.agents.<agentId> section into routing state. Returns
 * null when the section is not a usable object.
 */
function normalizeAgentSection(agentId: string, section: unknown): AgentRouting | null {
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  const s = section as AgentSection;
  const rawCategories =
    s.categories && typeof s.categories === "object" && !Array.isArray(s.categories)
      ? (s.categories as Record<string, CategoryEntry>)
      : {};
  const descriptions =
    s.categoryDescriptions && typeof s.categoryDescriptions === "object" && !Array.isArray(s.categoryDescriptions)
      ? (s.categoryDescriptions as Record<string, string>)
      : {};

  // Normalize category keys into a lower-case map once. All routing lookups
  // (classifier prompt, parse, decisions, default fallback) go through this
  // map so "General" and "general" are the same routing target.
  const categories: Record<string, CategoryConfig> = {};
  for (const [name, entry] of Object.entries(rawCategories)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const model = (entry as CategoryEntry).model;
    if (typeof model !== "string" || model.length === 0) continue;
    const toolsAllow = (entry as CategoryEntry).toolsAllow;
    categories[name.toLowerCase()] = {
      name,
      model,
      ...(Array.isArray(toolsAllow) && toolsAllow.every((t) => typeof t === "string")
        ? { toolsAllow }
        : {}),
    };
  }

  const rawDefault = s.defaultCategory;
  const defaultCategory =
    typeof rawDefault === "string" && rawDefault.trim().length > 0
      ? rawDefault.trim()
      : DEFAULT_CATEGORY;

  return { agentId, categories, descriptions, defaultCategory };
}

/**
 * Validate the resolved plugin config at registration and return a list of
 * human-readable problems. The host already rejects shape/type errors via the
 * manifest configSchema (unknown keys, missing `model`, bad types), so this
 * focuses on SEMANTIC issues the schema cannot express, per agent:
 *   - no agent sections configured while enabled (plugin is a global no-op)
 *   - an agent section with no categories (silent per-agent no-op)
 *   - defaultCategory pointing at a category that does not exist
 *   - categoryDescriptions keys that match no configured category (ignored)
 * Keys are compared case-insensitively because the classifier output is
 * lowercased before lookup, so "Chat" and "chat" are the same routing target.
 */
function validateConfig(
  cfg: PluginConfig,
  routingByAgent: Map<string, AgentRouting>,
): string[] {
  const problems: string[] = [];

  if (cfg.enabled !== false && routingByAgent.size === 0) {
    problems.push("no agent sections configured; the plugin is a no-op for every agent");
    return problems;
  }

  for (const routing of routingByAgent.values()) {
    const categoryNames = Object.keys(routing.categories);
    if (categoryNames.length === 0) {
      problems.push(
        `agent "${routing.agentId}": no categories configured; every turn for this agent will fall back to the default model and tool surface`,
      );
      continue;
    }
    if (!categoryNames.some((n) => n.toLowerCase() === routing.defaultCategory.toLowerCase())) {
      problems.push(
        `agent "${routing.agentId}": defaultCategory "${routing.defaultCategory}" does not match any configured category (${categoryNames.join(", ")}); classification failures and unknown labels will be silently dropped`,
      );
    }
    for (const key of Object.keys(routing.descriptions)) {
      if (!categoryNames.some((n) => n.toLowerCase() === key.toLowerCase())) {
        problems.push(
          `agent "${routing.agentId}": categoryDescriptions key "${key}" matches no configured category and is ignored`,
        );
      }
    }
  }

  return problems;
}

/**
 * Build the classification prompt. We ask for a single JSON object with one
 * "category" field constrained to the valid labels, plus any operator-supplied
 * descriptions that disambiguate the categories.
 *
 * `categories` is keyed by lower-case name (the canonical routing key); each
 * entry's `name` is the original configured label shown in the prompt.
 */
function buildClassifierPrompt(
  prompt: string,
  categories: Record<string, { name: string }>,
  descriptions?: Record<string, string>,
): string {
  const names = Object.values(categories).map((c) => c.name);
  const lines: string[] = [
    "You are a routing classifier. Read the user request and choose EXACTLY ONE category.",
    'Reply with a single JSON object of the form {"category": "<label>"} and nothing else.',
    `Valid labels: ${names.join(", ")}.`,
  ];
  if (descriptions) {
    const entries = Object.entries(categories).filter(([key]) => key in descriptions);
    if (entries.length > 0) {
      lines.push("", "Category meanings:");
      for (const [key, c] of entries) lines.push(`- ${c.name}: ${descriptions[key]}`);
    }
  }
  lines.push("", "User request:", prompt);
  return lines.join("\n");
}

/**
 * Extract the category from classifier output. Strict JSON only: the entire
 * response must be a single JSON object whose "category" field is one of the
 * known labels. A stray code fence or surrounding prose is rejected (the
 * caller falls back to the default category) rather than scanned for a label,
 * because substring matching would let user prompt text steer routing.
 */
function parseCategory(
  raw: string,
  categories: Record<string, { name: string }>,
): string | null {
  const cleaned = raw.trim();
  if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) return null;
  try {
    const obj: unknown = JSON.parse(cleaned);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const label = (obj as { category?: unknown }).category;
      if (typeof label === "string") {
        // Accept the canonical lower-case key or any original configured
        // spelling (e.g. "General" when the config key is "General").
        const normalized = label.trim().toLowerCase();
        if (normalized in categories) return normalized;
        for (const [key, c] of Object.entries(categories)) {
          if (c.name.toLowerCase() === normalized) return key;
        }
      }
    }
  } catch {
    // not valid JSON; reject
  }
  return null;
}

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description:
    "Classify each turn with a small local model and route it to the best specialist model, narrowing the tool surface per category.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;
    const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const logger = api.logger ?? noopLogger;
    const runtime = api.runtime;
    if (!runtime) {
      logger.warn("model-router: api.runtime unavailable; plugin is a no-op");
      return;
    }

    // Resolve config once at registration. In hybrid reload mode, editing
    // plugins.entries.model-router.config replaces this instance and re-runs
    // register with the new settings, so this stays fresh.
    const enabled = cfg.enabled !== false;
    const debug = cfg.debug === true;
    const classifierModel = cfg.classifierModel ?? DEFAULT_CLASSIFIER_MODEL;
    const timeoutMs = cfg.classifierTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fallbackModel = cfg.fallbackModel;

    // Resolve per-agent routing once at registration. Only agents with a
    // config section are routed; every other agent is skipped entirely.
    const agentsRaw =
      cfg.agents && typeof cfg.agents === "object" && !Array.isArray(cfg.agents)
        ? (cfg.agents as Record<string, unknown>)
        : {};
    const routingByAgent = new Map<string, AgentRouting>();
    for (const [rawId, section] of Object.entries(agentsRaw)) {
      const agentId = rawId.trim();
      if (!agentId) continue;
      const routing = normalizeAgentSection(agentId, section);
      if (routing) routingByAgent.set(agentId, routing);
    }

    // Startup validation: surface semantic config problems the host schema
    // cannot express (missing agent sections, missing categories, dangling
    // defaultCategory, orphaned descriptions) so a misconfigured plugin is
    // visible in the gateway log instead of silently no-oping or misrouting.
    const problems = validateConfig(cfg, routingByAgent);
    for (const problem of problems) {
      logger.warn(`model-router config: ${problem}`);
    }

    if (!enabled) {
      logger.info("model-router disabled; all turns use the default model");
      return;
    }
    if (routingByAgent.size === 0) {
      // Already warned above via validateConfig(); avoid a duplicate line.
      return;
    }
    logger.info(
      `model-router active for agents: ${[...routingByAgent.keys()].join(", ")}`,
    );

    // Per-run cache so before_model_resolve and before_prompt_build share one
    // classification call. Keyed by agent + runId when available, else agent +
    // sessionKey. If neither is present, the turn is classified but NOT
    // cached: a shared "global" key would let unrelated turns within the TTL
    // reuse each other's classification and misroute model/tools.
    const cache = new Map<string, { category: string; at: number }>();
    const CACHE_TTL_MS = 60_000;

    type RoutingContext = {
      agentId?: string;
      runId?: string;
      sessionKey?: string;
    };

    function contextLabel(ctx: RoutingContext): string {
      return `agent=${ctx.agentId ?? "unknown"} run=${ctx.runId ?? "unknown"} session=${ctx.sessionKey ?? "unknown"}`;
    }

    function diagnosticSnapshot(value: unknown): string {
      try {
        const serialized = JSON.stringify(value, (_key, nested) =>
          typeof nested === "string" && nested.length > 1_000
            ? `${nested.slice(0, 1_000)}...[truncated]`
            : nested,
        );
        return (serialized ?? String(value)).slice(0, 4_000);
      } catch (err) {
        return `[unserializable: ${(err as Error)?.message ?? err}]`;
      }
    }

    async function classify(
      prompt: string,
      ctx: RoutingContext,
      routing: AgentRouting,
    ): Promise<string> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await runtime.llm.complete({
          messages: [
            {
              role: "user",
              content: buildClassifierPrompt(prompt, routing.categories, routing.descriptions),
            },
          ],
          systemPrompt:
            'You are a precise routing classifier. Reply with exactly one JSON object {"category": "<label>"} and nothing else.',
          model: classifierModel,
          maxTokens: 24,
          temperature: 0,
          // Ask the provider transport to disable model thinking so the small
          // output budget is used for the classification JSON itself.
          reasoning: "off",
          purpose: "model-router.classify",
          signal: controller.signal,
        });
        if (debug) {
          const resultKeys =
            result && typeof result === "object" ? Object.keys(result as object) : [];
          logger.info(
            `model-router diagnostic completion-result ${contextLabel(ctx)} type=${typeof result} keys=[${resultKeys.join(", ")}] snapshot=${diagnosticSnapshot(result)}`,
          );
        }
        const raw = (result?.text ?? "").trim();
        const parsed = parseCategory(raw, routing.categories);
        const category = parsed ?? routing.defaultCategory;
        if (debug) {
          logger.info(
            `model-router diagnostic classification ${contextLabel(ctx)} elapsed=${Date.now() - started}ms raw=${JSON.stringify(raw.slice(0, 500))} parsed=${parsed ?? "none"} selected=${category} source=${parsed ? "classifier" : "default-fallback"}`,
          );
        }
        return category;
      } catch (err) {
        const elapsed = Date.now() - started;
        if (controller.signal.aborted) {
          logger.warn(
            `model-router classification timed out after ${elapsed}ms; using default category: ${routing.defaultCategory}`,
          );
        } else {
          logger.warn(
            `model-router classification failed after ${elapsed}ms; using default category: ${routing.defaultCategory}; ${(err as Error)?.message ?? err}`,
          );
        }
        return routing.defaultCategory;
      } finally {
        clearTimeout(timer);
      }
    }

    function cacheKey(ctx: RoutingContext): string | null {
      const key = ctx.runId ?? ctx.sessionKey;
      // No stable identity: refuse to share a cache slot with other turns.
      return key && key.length > 0 ? key : null;
    }

    async function resolveCategory(
      prompt: string,
      ctx: RoutingContext,
      routing: AgentRouting,
    ): Promise<string> {
      // Include the agent in the cache key: different agents can classify
      // the same prompt into different categories.
      const base = cacheKey(ctx);
      const key = base ? `${routing.agentId}:${base}` : null;
      if (key) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
          logger.info(
            `model-router diagnostic cache-hit ${contextLabel(ctx)} category=${hit.category} age=${Date.now() - hit.at}ms`,
          );
          return hit.category;
        }
      }
      const category = await classify(prompt, ctx, routing);
      if (key) {
        cache.set(key, { category, at: Date.now() });
        // Bound the cache.
        if (cache.size > 256) {
          const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) cache.delete(oldest[0]);
        }
      }
      return category;
    }

    function lookupRouting(ctx: RoutingContext): AgentRouting | null {
      const agentId = ctx.agentId?.trim();
      return agentId ? (routingByAgent.get(agentId) ?? null) : null;
    }

    // 1. Route the model.
    api.on(
      "before_model_resolve",
      async (event, ctx) => {
        // No config section for this agent -> the plugin does nothing here.
        const routing = lookupRouting(ctx);
        if (!routing) return;
        const prompt = (event as { prompt?: string }).prompt ?? "";
        if (!prompt) return;
        try {
          const category = await resolveCategory(prompt, ctx, routing);
          const decision = routing.categories[category] ?? routing.categories[routing.defaultCategory];
          if (!decision?.model) return;
          logger.info(
            `model-router diagnostic route ${contextLabel(ctx)} category=${category} model=${decision.model}`,
          );
          return { modelOverride: decision.model };
        } catch (err) {
          logger.warn(
            `model-router before_model_resolve error: ${(err as Error)?.message ?? err}`,
          );
          // Fail open: keep the session's default model.
          if (fallbackModel) return { modelOverride: fallbackModel };
          return;
        }
      },
    );

    // 2. Narrow the tool surface for this turn.
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        // No config section for this agent -> the plugin does nothing here.
        const routing = lookupRouting(ctx);
        if (!routing) return;
        const prompt = (event as { prompt?: string }).prompt ?? "";
        if (!prompt) return;
        try {
          const category = await resolveCategory(prompt, ctx, routing);
          const decision = routing.categories[category] ?? routing.categories[routing.defaultCategory];
          if (!decision?.toolsAllow) return; // leave default surface unchanged
          logger.info(
            `model-router diagnostic tools ${contextLabel(ctx)} category=${category} toolsAllow=[${decision.toolsAllow.join(", ")}]`,
          );
          return { toolsAllow: decision.toolsAllow };
        } catch (err) {
          logger.warn(
            `model-router before_prompt_build error: ${(err as Error)?.message ?? err}`,
          );
          return; // leave default surface unchanged
        }
      },
    );
  },
});
