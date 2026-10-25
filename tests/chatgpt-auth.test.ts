import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { CHATGPT_PROVIDER } from "../src/core/chatgpt.ts";
import { normalizeContext } from "@earendil-works/pi-ai";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chatgpt-test-"));
process.env.LH_DATA_DIR = dir;
const { chatgptStore, createChatGPTStore } = await import("../src/store/chatgpt.ts");
const { startChatGPTSignIn, chatGPTStatus, handleChatGPTRequest, validateChatGPTCallback, chatGPTRequestAllowed, applyChatGPTTokens, refreshChatGPTModels, selectChatGPTProfile } = await import("../src/server/chatgpt.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const originalFetch = globalThis.fetch;
const keys = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
let nonce = "";
let audience = "oaiapp_fixture";
let scope = "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct";
let refreshes = 0;
let revokeFails = false;

function request(action: string, profileId?: string) {
	return handleChatGPTRequest(new Request("http://localhost:3000/api/chatgpt", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ action, profileId }) }));
}

before(() => {
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
		if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
		if (url.endsWith("/oauth/token")) {
			const params = new URLSearchParams(String(init!.body));
			assert.notEqual(params.get("client_id"), "dynamic_agent_client");
			if (params.get("grant_type") === "refresh_token") {
				refreshes++;
				assert.equal(params.get("refresh_token"), "refresh-first");
				return Response.json({ access_token: "access-rotated", refresh_token: "refresh-rotated", expires_in: 3600, scope });
			}
			const token = await new SignJWT({ nonce, email: "fixture@example.test" }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://auth.openai.com").setSubject("fixture-user").setAudience(audience).setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
			return Response.json({ access_token: "access-first", refresh_token: "refresh-first", id_token: token, expires_in: 3600, scope });
		}
		if (url === "https://api.openai.com/v1/models") return Response.json({ models: [{ slug: "fixture-live", display_name: "Live fixture", visibility: "list", context_window: 64000, max_output_tokens: 8000, input_modalities: ["text", "image"] }] });
		if (url === "https://api.openai.com/v1/responses") {
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-rotated");
			return new Response('data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
		}
		if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
		if (url.endsWith("/oauth/revoke")) { if (revokeFails) throw new Error("Offline"); return new Response(null, { status: 200 }); }
		throw new Error(`Unexpected fixture endpoint ${url}`);
	};
});
afterEach(async () => { await request("cancel"); scope = "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct"; audience = "oaiapp_fixture"; revokeFails = false; });
after(() => { globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); });

async function signIn(profileId?: string) {
	const result = await startChatGPTSignIn(profileId);
	const url = new URL(result.url);
	nonce = url.searchParams.get("nonce")!;
	const callback = new URL(url.searchParams.get("redirect_uri")!);
	callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "test-code", client_id: "oaiapp_fixture" }).toString();
	return { url, callback };
}

describe("ChatGPT sign-in and protected storage", () => {
	it("discovers the newly selected account while another account's request is still in flight", async () => {
		const previous = chatgptStore.read();
		const fixtureFetch = globalThis.fetch;
		const requested: string[] = [];
		const releases = new Map<string, (response: Response) => void>();
		const started = new Map<string, () => void>();
		const accountAStarted = new Promise<void>((resolve) => started.set("Bearer account-a", resolve));
		const accountBStarted = new Promise<void>((resolve) => started.set("Bearer account-b", resolve));
		let accountA: Promise<void> | undefined;
		let accountB: Promise<void> | undefined;
		let duplicateB: Promise<void> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await chatgptStore.modify((record) => {
				record.activeId = "a";
				record.profiles = ["a", "b"].map((id) => ({ id, clientId: `client-${id}`, access: `account-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"], models: [] }));
			});
			globalThis.fetch = async (input, init) => {
				assert.equal(String(input), "https://api.openai.com/v1/models");
				const bearer = new Headers(init?.headers).get("authorization")!;
				requested.push(bearer);
				return new Promise<Response>((resolve) => { releases.set(bearer, resolve); started.get(bearer)?.(); });
			};
			accountA = refreshChatGPTModels();
			await accountAStarted;
			accountB = selectChatGPTProfile("b");
			await Promise.race([
				accountBStarted,
				accountB.then(() => { throw new Error("Account switch finished without discovering B's models"); }),
				new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Account B reused account A's in-flight discovery")), 5000); }),
			]);
			clearTimeout(deadline);
			duplicateB = refreshChatGPTModels();
			const response = (id: string) => Response.json({ models: [{ slug: `model-${id}`, display_name: `Account ${id}`, visibility: "list", context_window: 64000, max_output_tokens: 8000 }] });
			// Finish B first: completing B must not interfere with A's request.
			releases.get("Bearer account-b")!(response("b"));
			await Promise.all([accountB, duplicateB]);
			assert.equal(chatgptStore.read().activeId, "b");
			assert.deepEqual(chatgptStore.read().profiles.find((p) => p.id === "b")!.models?.map((m) => m.id), ["model-b"]);
			releases.get("Bearer account-a")!(response("a"));
			await accountA;
			assert.deepEqual(requested, ["Bearer account-a", "Bearer account-b"], "same-account refreshes deduplicate; different accounts never share credentials");
			const final = chatgptStore.read();
			assert.equal(final.activeId, "b");
			assert.deepEqual(final.profiles.find((p) => p.id === "a")!.models?.map((m) => m.id), ["model-a"]);
			assert.deepEqual(final.profiles.find((p) => p.id === "b")!.models?.map((m) => m.id), ["model-b"]);
		} finally {
			clearTimeout(deadline);
			for (const release of releases.values()) release(Response.json({ models: [] }));
			await Promise.allSettled([accountA, accountB, duplicateB]);
			globalThis.fetch = fixtureFetch;
			await chatgptStore.modify((record) => Object.assign(record, previous));
		}
	});
	it("persists one host identifier and owner-only credentials while serializing concurrent updates", async () => {
		const file = path.join(dir, "store-test", "auth.json");
		const store = createChatGPTStore(file);
		await store.modify((record) => { record.activeId = "start"; });
		const hostId = store.read().hostId;
		await Promise.all(Array.from({ length: 8 }, (_, i) => store.modify(async (record) => { await Promise.resolve(); record.profiles.push({ id: String(i), clientId: `client-${i}` }); })));
		assert.equal(store.read().profiles.length, 8);
		assert.equal(createChatGPTStore(file).read().hostId, hostId);
		assert.match(hostId, /^urn:uuid:/);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});

	it("rejects callbacks with wrong state, mismatched registrations, or declined consent", () => {
		assert.throws(() => validateChatGPTCallback(new URL("http://127.0.0.1/auth/callback?state=wrong&code=x&client_id=issued"), { state: "expected", clientId: "dynamic_agent_client" }), /state/);
		assert.throws(() => validateChatGPTCallback(new URL("http://127.0.0.1/auth/callback?state=s&code=x&client_id=other"), { state: "s", clientId: "issued" }), /match/);
		assert.throws(() => validateChatGPTCallback(new URL("http://127.0.0.1/auth/callback?state=s&error=access_denied"), { state: "s", clientId: "issued" }), /declined/);
		assert.deepEqual(validateChatGPTCallback(new URL("http://127.0.0.1/auth/callback?state=s&code=x"), { state: "s", clientId: "issued" }), { code: "x", clientId: "issued" });
	});

	it("completes PKCE sign-in, verifies identity, discovers models, and exposes no tokens", async () => {
		const { url, callback } = await signIn();
		assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
		assert.equal(url.searchParams.get("agent_name_hint"), "LearnHarness");
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");
		assert.match(url.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
		const bad = new URL(callback); bad.searchParams.set("state", "wrong");
		assert.equal((await originalFetch(bad)).status, 400);
		assert.equal(chatGPTStatus().pending, true);
		assert.equal((await originalFetch(callback)).status, 200);
		const status = chatGPTStatus();
		assert.equal(status.pending, false);
		assert.equal(status.profiles[0]!.sharing, true);
		assert.match(status.profiles[0]!.email, /fixture@example.test/);
		assert.equal(providerKeyPresent(CHATGPT_PROVIDER), true);
		assert.ok(modelCatalog().models.some((m) => m.provider === CHATGPT_PROVIDER && m.id === "fixture-live"));
		const json = JSON.stringify(status);
		for (const secret of ["access-first", "refresh-first", "idToken", "clientId"]) assert.ok(!json.includes(secret));
	});

	it("renews an expired session once for concurrent agent requests and persists rotation", async () => {
		await chatgptStore.modify((record) => { record.profiles.find((p) => p.id === record.activeId)!.expires = 0; });
		const engine = piEngineForSpec({ provider: CHATGPT_PROVIDER, id: "fixture-live" });
		const context = normalizeContext({ messages: [] });
		const results = await Promise.all([engine.streamFn(engine.model, context).result(), engine.streamFn(engine.model, context).result()]);
		assert.equal(refreshes, 1);
		assert.ok(results.every((r) => r.stopReason === "stop"));
		assert.equal(chatgptStore.read().profiles[0]!.refresh, "refresh-rotated");
	});

	it("reuses the issued client and host on reconnect, without registering again", async () => {
		const before = chatgptStore.read();
		const { url, callback } = await signIn(before.activeId!);
		assert.equal(url.searchParams.get("client_id"), "oaiapp_fixture");
		assert.equal(url.searchParams.get("ext_agent_host_id"), before.hostId);
		assert.equal(url.searchParams.has("agent_name_hint"), false);
		assert.equal((await originalFetch(callback)).status, 200);
		assert.equal(chatgptStore.read().profiles.length, 1);
	});

	it("rejects an ID token for another audience before storing its tokens", async () => {
		const { callback } = await signIn();
		audience = "oaiapp_wrong";
		assert.equal((await originalFetch(callback)).status, 400);
		const record = chatgptStore.read();
		assert.equal(record.profiles.at(-1)!.access, undefined);
		assert.equal(record.profiles[0]!.access, "access-first");
	});

	it("does not authorize inference after identity-only consent", () => {
		const profile = { id: "identity", clientId: "client" };
		applyChatGPTTokens(profile, { access_token: "token", refresh_token: "refresh", expires_in: 3600, scope: "openid email profile" });
		assert.equal((profile as { scopes?: string[] }).scopes?.includes("chatgpt.tokens.use.direct"), false);
	});

	it("rejects remote and cross-origin control requests", async () => {
		assert.equal(chatGPTRequestAllowed(new Request("http://localhost:3000/api/chatgpt", { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } })), true, "Next normalizes loopback request URLs");
		assert.equal(chatGPTRequestAllowed(new Request("http://localhost:3000/api/chatgpt", { headers: { host: "evil.example:3000" } })), false);
		assert.equal(chatGPTRequestAllowed(new Request("http://remote.example/api/chatgpt")), false);
		assert.equal(chatGPTRequestAllowed(new Request("http://localhost:3000/api/chatgpt", { headers: { origin: "https://evil.example" } })), false);
		assert.equal(chatGPTRequestAllowed(new Request("http://localhost:3000/api/chatgpt", { headers: { "sec-fetch-site": "same-site" } })), false);
		const response = await handleChatGPTRequest(new Request("http://localhost:3000/api/chatgpt", { method: "POST", headers: { origin: "https://evil.example", "Content-Type": "application/json" }, body: '{"action":"signout"}' }));
		assert.equal(response.status, 403);
	});

	it("clears tokens on sign-out even when remote revocation fails, retains registration, and closes the provider gate", async () => {
		revokeFails = true;
		const id = chatGPTStatus().activeId!;
		assert.equal((await request("signout", id)).status, 200);
		const profile = chatgptStore.read().profiles.find((p) => p.id === id)!;
		assert.equal(profile.access, undefined); assert.equal(profile.refresh, undefined); assert.equal(profile.idToken, undefined);
		assert.equal(profile.clientId, "oaiapp_fixture");
		assert.equal(providerKeyPresent(CHATGPT_PROVIDER), false);
		assert.match(chatGPTStatus().error!, /revocation was not confirmed/);
	});
});
