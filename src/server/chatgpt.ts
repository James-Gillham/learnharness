import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { chatgptStore, type ChatGPTProfile } from "../store/chatgpt.ts";
import { CHATGPT_PROVIDER, type ChatGPTStatus } from "../core/chatgpt.ts";
import { createChatGPTProvider, subscriptionModels } from "../agent/chatgpt-provider.ts";
import { piModels } from "../agent/models.ts";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const random = () => randomBytes(32).toString("base64url");

interface Pending {
	server: Server;
	state: string;
	nonce: string;
	verifier: string;
	redirectUri: string;
	profileId: string;
	clientId: string;
	timer: ReturnType<typeof setTimeout>;
	consumed: boolean;
	controller: AbortController;
}
interface Runtime {
	pending?: Pending;
	starting: boolean;
	error: string | null;
	refreshCatalog?: Promise<void>;
	requests: AbortController;
}
const key = Symbol.for("lh.chatgptRuntime");
const globals = globalThis as typeof globalThis & { [key]?: Runtime };
const runtime = globals[key] ??= { starting: false, error: null, requests: new AbortController() };
runtime.requests ??= new AbortController();

function stopAccountRequests() {
	runtime.requests.abort();
	runtime.requests = new AbortController();
}

export function chatGPTConnected(): boolean {
	const record = chatgptStore.read();
	const profile = record.profiles.find((p) => p.id === record.activeId);
	return !!profile?.access && !!profile.refresh && !!profile.scopes?.includes(DIRECT_SCOPE);
}

export function chatGPTStatus(): ChatGPTStatus {
	const record = chatgptStore.read();
	return {
		profiles: record.profiles.map((p, i) => ({ id: p.id, email: `${p.email ?? "ChatGPT account"} · Connection ${i + 1}`, connected: !!p.access, sharing: !!p.access && !!p.scopes?.includes(DIRECT_SCOPE) })),
		activeId: record.activeId,
		pending: !!runtime.pending || runtime.starting,
		error: runtime.error,
	};
}

async function tokenRequest(params: URLSearchParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetch(TOKEN_URL, {
		method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params,
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
	});
	// Never include upstream response bodies: they can contain credentials.
	if (!response.ok) throw new Error(`ChatGPT token exchange failed (${response.status}). Reconnect in Settings → Keys.`);
	return response.json().catch(() => { throw new Error("ChatGPT returned an invalid token response"); });
}

export function applyChatGPTTokens(profile: ChatGPTProfile, data: Record<string, unknown>, refreshing = false) {
	if (data.token_type !== undefined && (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")) throw new Error("Unsupported ChatGPT token type");
	if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error("Invalid ChatGPT token response");
	const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/) : refreshing ? profile.scopes : undefined;
	if (!scopes) throw new Error("ChatGPT did not return granted permissions");
	const refresh = typeof data.refresh_token === "string" ? data.refresh_token : refreshing ? profile.refresh : undefined;
	if (!refresh) throw new Error("ChatGPT did not return a renewable session");
	profile.access = data.access_token;
	profile.refresh = refresh;
	profile.expires = Date.now() + data.expires_in * 1000;
	profile.scopes = scopes;
	if (typeof data.id_token === "string") profile.idToken = data.id_token;
}

async function accessToken(profileId: string, signal?: AbortSignal): Promise<string> {
	const result = await chatgptStore.modify(async (record) => {
		const profile = record.profiles.find((p) => p.id === profileId);
		if (!profile?.access || !profile.refresh || !profile.scopes?.includes(DIRECT_SCOPE)) throw new Error("Connect ChatGPT and allow plan usage in Settings → Keys.");
		if (!profile.expires || profile.expires < Date.now() + 60_000) {
			const data = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", client_id: profile.clientId, refresh_token: profile.refresh, resource: RESOURCE }), signal);
			applyChatGPTTokens(profile, data, true);
		}
		// Persist a rotated session even when its permissions were reduced.
		if (!profile.scopes?.includes(DIRECT_SCOPE)) return new Error("ChatGPT plan usage permission is no longer available. Reconnect in Settings → Keys.");
		return profile.access!;
	});
	if (result instanceof Error) throw result;
	return result;
}

function activeProfileId(): string {
	const id = chatgptStore.read().activeId;
	if (!id) throw new Error("Connect your ChatGPT account in Settings → Keys.");
	return id;
}

/** Register only this subscription provider; ambient API keys cannot satisfy
 * its auth resolver. All learning roles already use the shared collection. */
function installProvider() {
	piModels().setProvider(createChatGPTProvider({
		models: () => {
			const record = chatgptStore.read();
			return record.profiles.find((p) => p.id === record.activeId)?.models ?? [];
		},
		token: (signal) => accessToken(activeProfileId(), AbortSignal.any([signal, runtime.requests.signal])),
		signal: () => runtime.requests.signal,
	}));
}
installProvider();

export async function refreshChatGPTModels(): Promise<void> {
	if (!chatGPTConnected()) return;
	if (runtime.refreshCatalog) return runtime.refreshCatalog;
	const id = activeProfileId();
	runtime.refreshCatalog = (async () => {
		const token = await accessToken(id);
		const response = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
		if (!response.ok) throw new Error(`ChatGPT model discovery failed (${response.status}). Reconnect or try again.`);
		const models = subscriptionModels(await response.json(), piModels().getModels("openai"));
		if (!models.length) throw new Error("No compatible ChatGPT models were returned for this account. Try refreshing or reconnecting.");
		await chatgptStore.modify((record) => {
			const profile = record.profiles.find((p) => p.id === id);
			if (profile?.access) profile.models = models;
		});
	})().finally(() => { runtime.refreshCatalog = undefined; });
	return runtime.refreshCatalog;
}

function stopPending() {
	const pending = runtime.pending;
	if (!pending) return;
	clearTimeout(pending.timer);
	pending.controller.abort();
	pending.server.close();
	pending.server.closeAllConnections();
	runtime.pending = undefined;
}

export function validateChatGPTCallback(url: URL, expected: { state: string; clientId: string }): { code: string; clientId: string } {
	if (url.searchParams.get("state") !== expected.state) throw new Error("Invalid sign-in state");
	if (url.searchParams.has("error")) throw new Error("ChatGPT sign-in was declined. You can try again.");
	const code = url.searchParams.get("code");
	const clientId = url.searchParams.get("client_id") ?? (expected.clientId !== "dynamic_agent_client" ? expected.clientId : null);
	if (!code || !clientId || clientId === "dynamic_agent_client") throw new Error("ChatGPT registration was incomplete");
	if (expected.clientId !== "dynamic_agent_client" && clientId !== expected.clientId) throw new Error("ChatGPT registration did not match the selected connection");
	return { code, clientId };
}

export async function startChatGPTSignIn(profileId?: string): Promise<{ url: string }> {
	if (runtime.starting || runtime.pending) throw new Error("A ChatGPT sign-in is already in progress. Complete or cancel it first.");
	runtime.starting = true;
	runtime.error = null;
	try {
		const info = await chatgptStore.modify((record) => {
			const profile = profileId ? record.profiles.find((p) => p.id === profileId) : undefined;
			if (profileId && !profile) throw new Error("Unknown ChatGPT connection");
			return { hostId: record.hostId, profile: profile ? { ...profile } : undefined };
		});
		const state = random();
		const nonce = random();
		const verifier = random();
		const clientId = info.profile?.clientId ?? "dynamic_agent_client";
		const controller = new AbortController();
		const server = createServer((request, response) => {
			const pending = runtime.pending;
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			response.setHeader("Referrer-Policy", "no-referrer");
			if (!pending || url.pathname !== "/auth/callback" || request.method !== "GET") { response.writeHead(404).end("Not found"); return; }
			// A stray callback must not consume or cancel the legitimate attempt.
			if (url.searchParams.get("state") !== state || pending.consumed) { response.writeHead(400).end("Invalid or already used sign-in state"); return; }
			pending.consumed = true;
			void (async () => {
				try {
					const result = validateChatGPTCallback(url, pending);
					// Retain the issued registration even if code exchange fails.
					await chatgptStore.modify((record) => {
						if (!record.profiles.some((p) => p.id === pending.profileId)) record.profiles.push({ id: pending.profileId, clientId: result.clientId });
					});
					const data = await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: result.clientId, code: result.code, code_verifier: verifier, redirect_uri: pending.redirectUri, resource: RESOURCE }), controller.signal);
					if (typeof data.id_token !== "string") throw new Error("ChatGPT did not return an identity token");
					const { payload } = await jwtVerify(data.id_token, jwks, { issuer: ISSUER, audience: result.clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
					if (payload.nonce !== nonce || !payload.sub) throw new Error("ChatGPT identity verification failed");
					if (info.profile?.subject && payload.sub !== info.profile.subject) throw new Error("Sign-in used a different ChatGPT account");
					controller.signal.throwIfAborted();
					stopAccountRequests();
					await chatgptStore.modify((record) => {
						controller.signal.throwIfAborted();
						const profile = record.profiles.find((p) => p.id === pending.profileId)!;
						applyChatGPTTokens(profile, data);
						profile.subject = payload.sub;
						profile.email = typeof payload.email === "string" ? payload.email : undefined;
						record.activeId = profile.id;
					});
					if (chatGPTConnected()) await refreshChatGPTModels();
					response.end("ChatGPT connected to LearnHarness. You can close this tab and return to the app.");
				} catch (error) {
					if (!controller.signal.aborted) runtime.error = error instanceof Error ? error.message : "ChatGPT sign-in failed";
					response.writeHead(400).end("Could not complete sign-in. Return to LearnHarness for details.");
				} finally {
					clearTimeout(pending.timer);
					server.close();
					server.closeIdleConnections();
					if (runtime.pending === pending) runtime.pending = undefined;
				}
			})();
		});
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Could not start ChatGPT callback listener");
		const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
		const timer = setTimeout(() => { runtime.error = "ChatGPT sign-in timed out. Please try again."; stopPending(); }, 5 * 60_000);
		timer.unref();
		runtime.pending = { server, state, nonce, verifier, clientId, profileId: profileId ?? randomUUID(), redirectUri, timer, consumed: false, controller };
		const url = new URL(`${ISSUER}/api/accounts/authorize`);
		url.search = new URLSearchParams({ client_id: clientId, ext_agent_host_id: info.hostId, response_type: "code", redirect_uri: redirectUri, resource: RESOURCE, scope: `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`, state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
		if (clientId === "dynamic_agent_client") url.searchParams.set("agent_name_hint", "LearnHarness");
		// No token hints in returned URLs; the system browser chooses the account.
		return { url: url.toString() };
	} finally { runtime.starting = false; }
}

export async function selectChatGPTProfile(id: string) {
	stopPending();
	stopAccountRequests();
	await chatgptStore.modify((record) => {
		if (!record.profiles.some((p) => p.id === id)) throw new Error("Unknown ChatGPT connection");
		record.activeId = id;
	});
	runtime.error = null;
	await refreshChatGPTModels();
}

export async function signOutChatGPT(id: string): Promise<void> {
	stopPending();
	stopAccountRequests();
	let revoked = true;
	await chatgptStore.modify(async (record) => {
		const profile = record.profiles.find((p) => p.id === id);
		if (!profile) throw new Error("Unknown ChatGPT connection");
		if (profile.refresh) {
			try {
				const configResponse = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
				const config = await configResponse.json() as { revocation_endpoint: string };
				const endpoint = new URL(config.revocation_endpoint);
				if (endpoint.origin !== ISSUER) throw new Error("Invalid revocation endpoint");
				revoked = false;
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: profile.refresh, token_type_hint: "refresh_token", client_id: profile.clientId }), signal: AbortSignal.timeout(10_000) });
						revoked = response.ok;
						if (response.status < 500) break;
					} catch { /* retry one transient failure before clearing locally */ }
					if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
				}
			} catch { revoked = false; }
		}
		delete profile.access; delete profile.refresh; delete profile.idToken; delete profile.expires; delete profile.scopes; delete profile.models;
	});
	runtime.error = revoked ? null : "Signed out locally. Remote revocation was not confirmed; disconnect LearnHarness in ChatGPT Settings → Usage.";
}

/** This feature is only for the local runtime. Reject cross-origin writes and
 * non-loopback Host headers rather than exposing local account control on LAN. */
export function chatGPTRequestAllowed(request: Request): boolean {
	const url = new URL(request.url);
	const loopback = ["127.0.0.1", "localhost", "[::1]"];
	if (!loopback.includes(url.hostname)) return false;
	// Next normalizes a standalone request URL to localhost even when the
	// Electron window and HTTP Host use 127.0.0.1. Check the actual authority
	// independently, then compare Origin against the browser-visible origin.
	let actual: URL;
	try { actual = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`); }
	catch { return false; }
	if (!loopback.includes(actual.hostname) || actual.port !== url.port) return false;
	const origin = request.headers.get("origin");
	if (origin && origin !== actual.origin) return false;
	const site = request.headers.get("sec-fetch-site");
	return site !== "cross-site" && site !== "same-site";
}

export async function handleChatGPTRequest(request: Request): Promise<Response> {
	const headers = { "Cache-Control": "no-store" };
	if (!chatGPTRequestAllowed(request)) return Response.json({ error: "ChatGPT connection is only available from this local app" }, { status: 403, headers });
	try {
		if (request.method === "GET") return Response.json(chatGPTStatus(), { headers });
		if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Expected JSON" }, { status: 415, headers });
		const body = await request.json() as { action?: string; profileId?: string };
		if (body.action === "signin") return Response.json(await startChatGPTSignIn(body.profileId), { headers });
		if (body.action === "cancel") { stopPending(); runtime.error = null; }
		else if (body.action === "select" && body.profileId) await selectChatGPTProfile(body.profileId);
		else if (body.action === "signout" && body.profileId) await signOutChatGPT(body.profileId);
		else if (body.action === "refresh") { await refreshChatGPTModels(); runtime.error = null; }
		else return Response.json({ error: "Unknown ChatGPT action" }, { status: 400, headers });
		return Response.json(chatGPTStatus(), { headers });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "ChatGPT connection failed" }, { status: 400, headers });
	}
}
