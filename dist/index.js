import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
const DEFAULT_CLASSIFIER_MODEL = "ollama/qwen3.5:2b";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CATEGORY = "general";
/**
 * Validate the resolved plugin config at registration and return a list of
 * human-readable problems. The host already rejects shape/type errors via the
 * manifest configSchema (unknown keys, missing `model`, bad types), so this
 * focuses on SEMANTIC issues the schema cannot express:
 *   - categories omitted/empty while the plugin is enabled (silent no-op)
   - defaultCategory pointing at a category that does not exist
   - categoryDescriptions keys that match no configured category (ignored)
 * Keys are compared case-insensitively because the classifier output is
 * lowercased before lookup, so "Chat" and "chat" are the same routing target.
 */
function validateConfig(cfg) {
    const problems = [];
    const categories = cfg.categories && typeof cfg.categories === "object" && !Array.isArray(cfg.categories)
        ? cfg.categories
        : {};
    const descriptions = cfg.categoryDescriptions && typeof cfg.categoryDescriptions === "object" && !Array.isArray(cfg.categoryDescriptions)
        ? cfg.categoryDescriptions
        : {};
    const categoryNames = Object.keys(categories);
    if (cfg.enabled !== false && categoryNames.length === 0) {
        problems.push("no categories configured; every turn will fall back to the default model and tool surface");
    }
    const defaultCategory = cfg.defaultCategory ?? DEFAULT_CATEGORY;
    if (categoryNames.length > 0 && !categoryNames.some((n) => n.toLowerCase() === defaultCategory.toLowerCase())) {
        problems.push(`defaultCategory "${defaultCategory}" does not match any configured category (${categoryNames.join(", ")}); classification failures and unknown labels will be silently dropped`);
    }
    for (const key of Object.keys(descriptions)) {
        if (!categoryNames.some((n) => n.toLowerCase() === key.toLowerCase())) {
            problems.push(`categoryDescriptions key "${key}" matches no configured category and is ignored`);
        }
    }
    return { problems, categories, descriptions };
}
/**
 * Build the classification prompt. We ask for a single JSON object with one
 * "category" field constrained to the valid labels, plus any operator-supplied
 * descriptions that disambiguate the categories.
 *
 * `categories` is keyed by lower-case name (the canonical routing key); each
 * entry's `name` is the original configured label shown in the prompt.
 */
function buildClassifierPrompt(prompt, categories, descriptions) {
    const names = Object.values(categories).map((c) => c.name);
    const lines = [
        "You are a routing classifier. Read the user request and choose EXACTLY ONE category.",
        'Reply with a single JSON object of the form {"category": "<label>"} and nothing else.',
        `Valid labels: ${names.join(", ")}.`,
    ];
    if (descriptions) {
        const entries = Object.entries(categories).filter(([key]) => key in descriptions);
        if (entries.length > 0) {
            lines.push("", "Category meanings:");
            for (const [key, c] of entries)
                lines.push(`- ${c.name}: ${descriptions[key]}`);
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
function parseCategory(raw, categories) {
    const cleaned = raw.trim();
    if (!cleaned.startsWith("{") || !cleaned.endsWith("}"))
        return null;
    try {
        const obj = JSON.parse(cleaned);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            const label = obj.category;
            if (typeof label === "string") {
                // Accept the canonical lower-case key or any original configured
                // spelling (e.g. "General" when the config key is "General").
                const normalized = label.trim().toLowerCase();
                if (normalized in categories)
                    return normalized;
                for (const [key, c] of Object.entries(categories)) {
                    if (c.name.toLowerCase() === normalized)
                        return key;
                }
            }
        }
    }
    catch {
        // not valid JSON; reject
    }
    return null;
}
export default definePluginEntry({
    id: "model-router",
    name: "Model Router",
    description: "Classify each turn with a small local model and route it to the best specialist model, narrowing the tool surface per category.",
    register(api) {
        const cfg = (api.pluginConfig ?? {});
        const noopLogger = { debug: () => { }, info: () => { }, warn: () => { }, error: () => { } };
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
        const classifierModel = cfg.classifierModel ?? DEFAULT_CLASSIFIER_MODEL;
        const timeoutMs = cfg.classifierTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        const fallbackModel = cfg.fallbackModel;
        const defaultCategory = cfg.defaultCategory ?? DEFAULT_CATEGORY;
        // Startup validation: surface semantic config problems the host schema
        // cannot express (missing categories, dangling defaultCategory, orphaned
        // descriptions) so a misconfigured plugin is visible in the gateway log
        // instead of silently no-oping or misrouting.
        const { problems, categories: rawCategories, descriptions } = validateConfig(cfg);
        for (const problem of problems) {
            logger.warn(`model-router config: ${problem}`);
        }
        // Normalize category keys into a lower-case map once. All routing lookups
        // (classifier prompt, parse, decisions, default fallback) go through this
        // map so "General" and "general" are the same routing target.
        const categories = {};
        for (const [name, entry] of Object.entries(rawCategories)) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
                continue;
            const model = entry.model;
            if (typeof model !== "string" || model.length === 0)
                continue;
            const toolsAllow = entry.toolsAllow;
            categories[name.toLowerCase()] = {
                name,
                model,
                ...(Array.isArray(toolsAllow) && toolsAllow.every((t) => typeof t === "string")
                    ? { toolsAllow }
                    : {}),
            };
        }
        if (!enabled) {
            logger.info("model-router disabled; all turns use the default model");
            return;
        }
        if (Object.keys(categories).length === 0) {
            // Already warned above via validateConfig(); avoid a duplicate line.
            return;
        }
        // Per-run cache so before_model_resolve and before_prompt_build share one
        // classification call. Keyed by runId when available, else sessionKey.
        // If neither is present, the turn is classified but NOT cached: a shared
        // "global" key would let unrelated turns within the TTL reuse each other's
        // classification and misroute model/tools.
        const cache = new Map();
        const CACHE_TTL_MS = 60_000;
        async function classify(prompt) {
            const started = Date.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const result = await runtime.llm.complete({
                    messages: [
                        {
                            role: "user",
                            content: buildClassifierPrompt(prompt, categories, descriptions),
                        },
                    ],
                    systemPrompt: 'You are a precise routing classifier. Reply with exactly one JSON object {"category": "<label>"} and nothing else.',
                    model: classifierModel,
                    maxTokens: 24,
                    temperature: 0,
                    // qwen3.x (and similar) are thinking models: they spend the token
                    // budget on hidden reasoning and return empty content. Disable
                    // thinking so the label is emitted directly.
                    reasoning: "off",
                    purpose: "model-router.classify",
                    signal: controller.signal,
                });
                const raw = (result?.text ?? "").trim();
                const parsed = parseCategory(raw, categories);
                const category = parsed ?? defaultCategory;
                logger.debug?.(`model-router classified in ${Date.now() - started}ms -> ${category} (raw=${JSON.stringify(raw)})`);
                return category;
            }
            catch (err) {
                const elapsed = Date.now() - started;
                if (controller.signal.aborted) {
                    logger.warn(`model-router classification timed out after ${elapsed}ms; using default category: ${defaultCategory}`);
                }
                else {
                    logger.warn(`model-router classification failed after ${elapsed}ms; using default category: ${err?.message ?? err}`);
                }
                return defaultCategory;
            }
            finally {
                clearTimeout(timer);
            }
        }
        function cacheKey(ctx) {
            const key = ctx.runId ?? ctx.sessionKey;
            // No stable identity: refuse to share a cache slot with other turns.
            return key && key.length > 0 ? key : null;
        }
        async function resolveCategory(prompt, ctx) {
            const key = cacheKey(ctx);
            if (key) {
                const hit = cache.get(key);
                if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
                    return hit.category;
                }
            }
            const category = await classify(prompt);
            if (key) {
                cache.set(key, { category, at: Date.now() });
                // Bound the cache.
                if (cache.size > 256) {
                    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                    if (oldest)
                        cache.delete(oldest[0]);
                }
            }
            return category;
        }
        // 1. Route the model.
        api.on("before_model_resolve", async (event, ctx) => {
            const prompt = event.prompt ?? "";
            if (!prompt)
                return;
            try {
                const category = await resolveCategory(prompt, ctx);
                const decision = categories[category] ?? categories[defaultCategory];
                if (!decision?.model)
                    return;
                logger.debug?.(`model-router routing ${category} -> ${decision.model}`);
                return { modelOverride: decision.model };
            }
            catch (err) {
                logger.warn(`model-router before_model_resolve error: ${err?.message ?? err}`);
                // Fail open: keep the session's default model.
                if (fallbackModel)
                    return { modelOverride: fallbackModel };
                return;
            }
        });
        // 2. Narrow the tool surface for this turn.
        api.on("before_prompt_build", async (event, ctx) => {
            const prompt = event.prompt ?? "";
            if (!prompt)
                return;
            try {
                const category = await resolveCategory(prompt, ctx);
                const decision = categories[category] ?? categories[defaultCategory];
                if (!decision?.toolsAllow)
                    return; // leave default surface unchanged
                logger.debug?.(`model-router toolsAllow for ${category}: [${decision.toolsAllow.join(", ")}]`);
                return { toolsAllow: decision.toolsAllow };
            }
            catch (err) {
                logger.warn(`model-router before_prompt_build error: ${err?.message ?? err}`);
                return; // leave default surface unchanged
            }
        });
    },
});
