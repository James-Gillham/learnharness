import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createModels, type Model, Type } from "@earendil-works/pi-ai";
import { createChatGPTProvider, chatGPTPayload, subscriptionModels } from "../src/agent/chatgpt-provider.ts";
import { CHATGPT_PROVIDER } from "../src/core/chatgpt.ts";
import { callCost } from "../src/core/prices.ts";

const model: Model<"openai-responses"> = {
	id: "fixture-chatgpt", name: "Fixture", provider: CHATGPT_PROVIDER, api: "openai-responses", baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"], reasoning: false, contextWindow: 128000, maxTokens: 16000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
afterEach(() => { globalThis.fetch = originalFetch; if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalApiKey; });

function sse(events: unknown[]) {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("ChatGPT subscription provider", () => {
	it("discovers only visible account models, preserving discovery order and capability metadata", () => {
		const result = subscriptionModels({ models: [
			{ slug: model.id, display_name: "Account model", visibility: "list" },
			{ slug: "hidden", visibility: "hidden" },
			{ slug: "new-model", display_name: "New model", visibility: "list", context_window: 64000, max_output_tokens: 8000, input_modalities: ["text"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
			{ slug: "unknown-limits", visibility: "list" },
		] }, [{ ...model, provider: "openai" }]);
		assert.deepEqual(result.map((m) => m.id), [model.id, "new-model"]);
		assert.equal(result[0]!.name, "Account model");
		assert.deepEqual(result[0]!.input, ["text", "image"]);
		assert.equal(result[1]!.thinkingLevelMap?.medium, null);
		assert.equal(result[1]!.thinkingLevelMap?.high, "high");
		assert.equal(result[0]!.provider, CHATGPT_PROVIDER);
	});

	it("removes unsupported fields, retains history, and groups function tools", () => {
		const payload = chatGPTPayload({ model: model.id, input: [{ role: "system", content: "Teach" }, { role: "user", content: "Hello" }], tools: [{ type: "function", name: "quiz" }], temperature: 0.7, max_output_tokens: 1000, previous_response_id: "old", store: true });
		assert.equal(payload.store, false); assert.equal(payload.stream, true);
		assert.ok(!("temperature" in payload)); assert.ok(!("max_output_tokens" in payload)); assert.ok(!("previous_response_id" in payload));
		assert.deepEqual(payload.input, [{ role: "developer", content: "Teach" }, { role: "user", content: "Hello" }]);
		assert.deepEqual(payload.tools, [{ type: "namespace", name: "learnharness", description: "LearnHarness learning tools", tools: [{ type: "function", name: "quiz" }] }]);
	});

	it("streams real Pi tool calls through the public endpoint with the OAuth bearer", async () => {
		let requests = 0;
		globalThis.fetch = async (input, init) => {
			requests++;
			assert.equal(String(input), "https://api.openai.com/v1/responses");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer subscription-token");
			const body = JSON.parse(init!.body as string);
			assert.equal(body.store, false); assert.equal(body.stream, true);
			assert.equal(body.tools[0].type, "namespace");
			assert.equal(body.tools[0].tools[0].name, "quiz");
			assert.ok(!("max_output_tokens" in body));
			return sse([
				{ type: "response.created", response: { id: "resp_test" } },
				{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "quiz", namespace: "learnharness", arguments: "" } },
				{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"question":"Why?"}' },
				{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "quiz", namespace: "learnharness", arguments: '{"question":"Why?"}' } },
				{ type: "response.completed", response: { id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
			]);
		};
		const models = createModels();
		models.setProvider(createChatGPTProvider({ models: () => [model], token: async () => "subscription-token" }));
		assert.equal(models.getModel(CHATGPT_PROVIDER, model.id)?.id, model.id);
		const result = await models.streamSimple(model, { messages: [{ role: "user", content: "Help me learn", timestamp: Date.now() }], tools: [{ name: "quiz", description: "Ask a question", parameters: Type.Object({ question: Type.String() }) }] }, { maxTokens: 500 }).result();
		assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.deepEqual(result.content[0], { type: "toolCall", id: "call_test|fc_test", name: "quiz", namespace: "learnharness", arguments: { question: "Why?" } });
		assert.equal(requests, 1);
	});

	it("reports an in-stream subscription limit as an error and never retries with an API key", async () => {
		process.env.OPENAI_API_KEY = "must-not-be-used";
		let requests = 0;
		globalThis.fetch = async (_input, init) => {
			requests++;
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer subscription-token");
			return sse([{ type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "Plan limit reached" } } }]);
		};
		const models = createModels();
		models.setProvider(createChatGPTProvider({ models: () => [model], token: async () => "subscription-token" }));
		const result = await models.streamSimple(model, { messages: [{ role: "user", content: "Hello", timestamp: 0 }] }).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /subscription_sharing_usage_limit_exceeded/);
		assert.equal(requests, 1);
	});

	it("overrides paid-API capabilities on a saved reasoning model and sends effort in request config", async () => {
		// The account's cached model predates the subscription compatibility fix.
		const cached: Model<"openai-responses"> = { ...model, reasoning: true, compat: { supportsMidConvoEffort: true, supportsToolSearch: true, supportsAdditionalTools: true, supportsExplicitPromptCacheMode: true, supportsMidConvoSystemMessages: true } };
		let requests = 0;
		globalThis.fetch = async (_input, init) => {
			requests++;
			const body = JSON.parse(init!.body as string);
			assert.equal(body.reasoning.effort, "high");
			assert.ok(!("prompt_cache_options" in body));
			assert.ok(!("max_output_tokens" in body));
			assert.ok(body.input.every((item: { type?: string; role?: string }) => item.type !== "configuration_update" && item.type !== "tool_search_call" && item.type !== "tool_search_output" && item.role !== "system"));
			assert.ok(body.input.some((item: { type?: string }) => item.type === "additional_tools"), "mid-conversation tools use the supported input item");
			return sse([{ type: "response.completed", response: { id: "resp_reasoning", status: "completed", output: [] } }]);
		};
		const models = createModels();
		models.setProvider(createChatGPTProvider({ models: () => [cached], token: async () => "subscription-token" }));
		const resolved = models.getModel(CHATGPT_PROVIDER, cached.id)! as Model<"openai-responses">;
		assert.equal(resolved.compat?.supportsMidConvoEffort, false);
		const result = await models.streamSimple(cached, {
			systemPrompt: "Teach step by step", messages: [
				{ role: "user", content: "Teach me about LLMs", timestamp: 0 },
				{ role: "system", content: "A learning tool is now available", toolsAdded: [{ name: "quiz", description: "Ask a question", parameters: Type.Object({ question: Type.String() }) }], timestamp: 1 },
			],
		}, { reasoning: "high", maxTokens: 500, cacheRetention: "long" }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(requests, 1);
	});

	it("moves legacy configuration items into request reasoning while preserving transcript content", () => {
		const payload = chatGPTPayload({ reasoning: { effort: "medium", summary: "auto" }, input: [{ role: "user", content: "Explain" }, { type: "configuration_update", reasoning: { effort: "high" } }] });
		assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
		assert.deepEqual(payload.input, [{ role: "user", content: "Explain" }]);
	});

	it("fails closed on an interrupted stream or missing subscription session", async () => {
		process.env.OPENAI_API_KEY = "must-not-be-used";
		globalThis.fetch = async () => sse([{ type: "response.created", response: { id: "unfinished" } }]);
		const models = createModels();
		models.setProvider(createChatGPTProvider({ models: () => [model], token: async () => "subscription-token" }));
		assert.equal((await models.streamSimple(model, { messages: [] }).result()).stopReason, "error");
		let requests = 0;
		globalThis.fetch = async () => { requests++; throw new Error("Must not request"); };
		models.setProvider(createChatGPTProvider({ models: () => [model], token: async () => { throw new Error("Reconnect ChatGPT"); } }));
		assert.equal((await models.streamSimple(model, { messages: [] }).result()).stopReason, "error");
		assert.equal(requests, 0);
	});

	it("does not infer API charges for subscription usage", () => {
		assert.equal(callCost({ inputTokens: 10000, outputTokens: 2000 }, `${CHATGPT_PROVIDER}:${model.id}`), 0);
	});
});
