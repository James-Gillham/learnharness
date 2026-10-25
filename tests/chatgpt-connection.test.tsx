import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChatGPTConnection } from "../components/chatgpt-connection.tsx";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { useZeroKeys } from "../components/setup-cta.tsx";
import type { ChatGPTStatus } from "../src/core/chatgpt.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(globalThis, {
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let root: Root | undefined;
let host: HTMLElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); globalThis.fetch = originalFetch; globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; });

async function mount(component: React.ReactNode) {
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(component));
}
function button(text: string) {
	const value = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
	assert.ok(value, `Expected ${text} button`); return value;
}
async function click(value: HTMLElement) { await act(async () => value.dispatchEvent(new dom.window.Event("click", { bubbles: true }))); }

it("opens browser sign-in from setup without an API key and permits cancellation", async () => {
	const state: ChatGPTStatus = { profiles: [], activeId: null, pending: false, error: null };
	const opened: string[] = [];
	Object.assign(window, { open: (url: string) => { opened.push(url); return null; } });
	globalThis.fetch = async (input, init) => {
		const route = String(input);
		if (route === "/api/models") return Response.json({ models: [], providers: [], slots: { strong: null, cheap: null, vision: null } });
		if (route === "/api/keys") return Response.json({ keys: [], providers: [] });
		assert.equal(route, "/api/chatgpt");
		if (init?.method === "POST") {
			const action = JSON.parse(init.body as string).action;
			if (action === "signin") { state.pending = true; return Response.json({ url: "https://auth.openai.com/test-authorize" }); }
			assert.equal(action, "cancel"); state.pending = false;
		}
		return Response.json(state);
	};
	await mount(<SetupDialog open onClose={() => {}} onDone={() => {}} />);
	assert.ok(document.querySelector('[data-testid="setup-stage-keys"]'));
	await click(button("Continue with ChatGPT"));
	assert.deepEqual(opened, ["https://auth.openai.com/test-authorize"]);
	assert.ok(document.querySelector('a[href="https://auth.openai.com/test-authorize"]'), "fallback link when popups are blocked");
	await click(button("Cancel sign-in"));
	assert.equal(state.pending, false);
});

it("shows the active account and plan controls and signs out without requesting API credentials", async () => {
	const state: ChatGPTStatus = { profiles: [{ id: "account", email: "learner@example.test · Connection 1", connected: true, sharing: true }], activeId: "account", pending: false, error: null };
	let signedOut = false;
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "/api/chatgpt");
		if (init?.method === "POST") {
			assert.deepEqual(JSON.parse(init.body as string), { action: "signout", profileId: "account" });
			signedOut = true; state.profiles[0]!.connected = false; state.profiles[0]!.sharing = false;
		}
		return Response.json(state);
	};
	await mount(<ChatGPTConnection />);
	assert.match(host.textContent!, /learner@example.test/);
	assert.match(host.textContent!, /ChatGPT plan usage is enabled/);
	assert.ok(host.querySelector('a[href="https://chatgpt.com/#settings/Usage"]'));
	await click(button("Sign out"));
	assert.equal(signedOut, true);
	button("Continue with ChatGPT");
});

it("allows a subscription-only learner past the composer’s provider-connection gate", async () => {
	globalThis.fetch = async (input) => {
		assert.equal(String(input), "/api/models", "the gate must count OAuth connections, not only /api/keys");
		return Response.json({ providers: [{ id: "chatgpt-subscription", envVar: null, keyPresent: true }] });
	};
	function Harness() { return <span>{useZeroKeys() ? "missing connection" : "ready to learn"}</span>; }
	await mount(<Harness />);
	assert.equal(host.textContent, "ready to learn");
});

it("waits for model discovery before advancing setup after OAuth connects the account", async () => {
	const state: ChatGPTStatus = { profiles: [], activeId: null, pending: false, error: null };
	let poll: (() => void) | undefined;
	globalThis.setInterval = ((callback: () => void) => { poll = callback; return 1; }) as unknown as typeof setInterval;
	globalThis.clearInterval = (() => {}) as typeof clearInterval;
	Object.assign(window, { open: () => null });
	let catalogReads = 0;
	let discovered = false;
	globalThis.fetch = async (input, init) => {
		const route = String(input);
		if (route === "/api/keys") return Response.json({ keys: [], providers: [] });
		if (route === "/api/models") {
			catalogReads++;
			return Response.json({
				providers: [{ id: "chatgpt-subscription", keyPresent: state.profiles.length > 0 }],
				models: discovered ? [{ id: "discovered-model", name: "Discovered model", provider: "chatgpt-subscription", input: ["text", "image"], supportedLevels: ["off"], cost: { input: 0, output: 0 }, contextWindow: 64000 }] : [],
				slots: { strong: null, cheap: null, vision: null },
			});
		}
		assert.equal(route, "/api/chatgpt");
		if (init?.method === "POST") {
			state.pending = true;
			// The account is persisted and usable before /models finishes.
			state.profiles = [{ id: "account", email: "learner@example.test", connected: true, sharing: true }];
			state.activeId = "account";
			return Response.json({ url: "https://auth.openai.com/test-authorize" });
		}
		return Response.json(state);
	};
	await mount(<SetupDialog open onClose={() => {}} onDone={() => {}} />);
	await click(button("Continue with ChatGPT"));
	assert.ok(document.querySelector('[data-testid="setup-stage-keys"]'), "pending discovery must keep the polling component mounted");
	assert.equal(catalogReads, 1, "do not request the empty catalog during discovery");
	assert.ok(poll);
	discovered = true;
	state.pending = false;
	await act(async () => { poll!(); });
	assert.ok(document.querySelector('[data-testid="setup-stage-pickers"]'));
	assert.equal(catalogReads, 2);
	await click(document.querySelector<HTMLElement>('[data-testid="setup-trigger-strong"]')!);
	assert.match(document.body.textContent!, /Discovered model/);
});
