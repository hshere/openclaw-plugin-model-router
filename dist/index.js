import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
const DEFAULT_CLASSIFIER_MODEL = "ollama/qwen3.5:2b";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CATEGORY = "general";
/**
 * Build the classification prompt. We ask for a single JSON object with one
 * "category" field constrained to the valid labels, plus any operator-supplied
 * descriptions that disambiguate the categories.
 */
function buildClassifierPrompt(prompt, categories, descriptions) {
    const lines = [
        "You are a routing classifier. Read the user request and choose EXACTLY ONE category.",
        'Reply with a single JSON object of the form {"category": "<label>"} and nothing else.',
        `Valid labels: ${categories.join(", ")}.`,
    ];
    if (descriptions) {
        const entries = Object.entries(descriptions).filter(([k]) => categories.includes(k));
        if (entries.length > 0) {
            lines.push("", "Category meanings:");
            for (const [k, v] of entries)
                lines.push(`- ${k}: ${v}`);
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
                const normalized = label.trim().toLowerCase();
                if (categories.includes(normalized))
                    return normalized;
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
        const categories = cfg.categories ?? {};
        const descriptions = cfg.categoryDescriptions ?? {};
        const defaultCategory = cfg.defaultCategory ?? DEFAULT_CATEGORY;
        const categoryNames = Object.keys(categories);
        if (!enabled) {
            logger.info("model-router disabled; all turns use the default model");
            return;
        }
        if (categoryNames.length === 0) {
            logger.warn("model-router enabled but no categories configured; routing is a no-op");
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
                            content: buildClassifierPrompt(prompt, categoryNames, descriptions),
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
                const parsed = parseCategory(raw, categoryNames);
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
