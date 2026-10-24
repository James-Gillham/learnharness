import { createProvider, type Api, type Model, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { CHATGPT_PROVIDER } from "../core/chatgpt.ts";

/** Enforce the public subscription endpoint's smaller request surface after
 * the normal Pi adapter has assembled history, instructions, and local tools. */
export function chatGPTPayload(value: unknown): Record<string, unknown> {
	const body: Record<string, unknown> = { ...(value as Record<string, unknown>), store: false, stream: true };
	const unsupported = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "prompt_cache_options", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"];
	for (const field of unsupported) delete (body as Record<string, unknown>)[field];
	if (Array.isArray(body.input)) {
		// Paid API models can encode effort changes in the transcript; the
		// subscription endpoint requires the final effort in request config.
		const updates = body.input.filter((item) => item.type === "configuration_update");
		const effort = updates.at(-1)?.reasoning?.effort;
		if (typeof effort === "string") body.reasoning = { ...(body.reasoning as object), effort };
		body.input = body.input.filter((item) => item.type !== "configuration_update").map((item) => item.role === "system" ? { ...item, role: "developer" } : item);
	}
	if (Array.isArray(body.tools) && body.tools.length) {
		body.tools = [{ type: "namespace", name: "learnharness", description: "LearnHarness learning tools", tools: body.tools }];
	}
	return body;
}

/** Pi recognizes subscription restrictions only for provider id "openai".
 * Our separate billing identity must explicitly override paid-API capabilities,
 * including on models restored from an existing account's saved catalog. */
function subscriptionModel(model: Model<"openai-responses">): Model<"openai-responses"> {
	return {
		...model,
		compat: {
			...model.compat,
			supportsToolSearch: false,
			supportsAdditionalTools: true,
			supportsMidConvoEffort: false,
			supportsExplicitPromptCacheMode: false,
			supportsMaxOutputTokens: false,
		},
	};
}

/** Account discovery restricts availability; Pi's catalog supplies the model
 * capability metadata when OpenAI's response omits it. Unknown limits are
 * never invented. New models with full discovery metadata work immediately. */
export function subscriptionModels(value: unknown, known: readonly Model<Api>[]): Model<"openai-responses">[] {
	const rows = (value as { models?: unknown[] })?.models;
	if (!Array.isArray(rows)) throw new Error("ChatGPT returned an invalid model catalog");
	return rows.flatMap((value) => {
		const row = value as Record<string, unknown>;
		if (row.visibility !== "list" || typeof row.slug !== "string") return [];
		const base = known.find((m) => m.id === row.slug && m.api === "openai-responses");
		const contextWindow = typeof row.context_window === "number" ? row.context_window : base?.contextWindow;
		const maxTokens = typeof row.max_output_tokens === "number" ? row.max_output_tokens : base?.maxTokens;
		if (!contextWindow || !maxTokens) return [];
		const levels = Array.isArray(row.supported_reasoning_levels)
			? row.supported_reasoning_levels.map((v) => typeof v === "string" ? v : (v as { effort?: string }).effort).filter((v): v is string => !!v)
			: null;
		const thinkingLevelMap = levels ? Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, levels.includes(level) ? level : null])) as ThinkingLevelMap : base?.thinkingLevelMap;
		const input: ("text" | "image")[] = Array.isArray(row.input_modalities)
			? row.input_modalities.filter((v): v is "text" | "image" => v === "text" || v === "image")
			: base?.input ?? ["text"];
		return [subscriptionModel({
			...base, id: row.slug, name: typeof row.display_name === "string" ? row.display_name : row.slug,
			provider: CHATGPT_PROVIDER, api: "openai-responses", baseUrl: "https://api.openai.com/v1",
			input, reasoning: levels ? levels.some((v) => v !== "off") : base?.reasoning ?? false,
			thinkingLevelMap, contextWindow, maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})];
	});
}

export function createChatGPTProvider(deps: {
	models(): Model<"openai-responses">[];
	token(signal: AbortSignal): Promise<string>;
	signal?(): AbortSignal;
}): Provider<"openai-responses"> {
	const requestSignal = (signal?: AbortSignal) => {
		const accountSignal = deps.signal?.();
		return accountSignal ? (signal ? AbortSignal.any([signal, accountSignal]) : accountSignal) : signal;
	};
	const provider = createProvider<"openai-responses">({
		id: CHATGPT_PROVIDER, name: "ChatGPT subscription", baseUrl: "https://api.openai.com/v1",
		auth: { apiKey: { name: "ChatGPT subscription", async resolve({ signal }) { return { auth: { apiKey: await deps.token(signal) }, source: "ChatGPT subscription" }; } } },
		models: [],
		api: {
			stream: (model, context, options) => stream(subscriptionModel(model as Model<"openai-responses">), context, { ...options, signal: requestSignal(options?.signal), maxRetries: 0, onPayload: chatGPTPayload }),
			streamSimple: (model, context, options) => streamSimple(subscriptionModel(model as Model<"openai-responses">), context, { ...options, signal: requestSignal(options?.signal), maxRetries: 0, onPayload: chatGPTPayload }),
		},
		// Dynamic list restored from this account's protected record.
	});
	const models = () => deps.models().map(subscriptionModel);
	return { ...provider, getModels: models, getAllModels: models };
}
