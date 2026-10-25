"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CHATGPT_USAGE_URL, type ChatGPTStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

/** Shared by first-run setup and Settings. Only public account state crosses
 * this boundary; credentials and token renewal stay in the local server. */
export function ChatGPTConnection() {
	const [status, setStatus] = useState<ChatGPTStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [authUrl, setAuthUrl] = useState<string | null>(null);
	const previous = useRef<string | null>(null);
	const accept = useCallback((value: ChatGPTStatus) => {
		setStatus(value);
		const signature = JSON.stringify([value.activeId, value.profiles, value.pending]);
		// OAuth saves the account before live model discovery finishes. Keep
		// setup on this screen (and keep polling) until the entire attempt
		// completes; advancing early unmounts us with an empty model list.
		if (!value.pending && previous.current !== null && previous.current !== signature) notifySettingsSaved("keys");
		previous.current = signature;
		if (!value.pending) setAuthUrl(null);
	}, []);
	const reload = useCallback(async () => {
		const response = await fetch("/api/chatgpt", { cache: "no-store" });
		if (!response.ok) throw new Error("Could not load the ChatGPT connection");
		accept(await response.json() as ChatGPTStatus);
	}, [accept]);
	useEffect(() => { void reload().catch(() => setError("Could not load the ChatGPT connection")); }, [reload]);
	useEffect(() => {
		if (!status?.pending) return;
		const timer = setInterval(() => { void reload().catch(() => setError("Could not check sign-in. Try again.")); }, 1000);
		return () => clearInterval(timer);
	}, [status?.pending, reload]);

	async function action(action: string, profileId?: string) {
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/chatgpt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, profileId }) });
			const value = await response.json();
			if (!response.ok) throw new Error(value.error ?? "ChatGPT connection failed");
			if (value.url) {
				setAuthUrl(value.url);
				window.open(value.url, "_blank", "noopener,noreferrer");
				await reload();
			} else {
				accept(value as ChatGPTStatus);
				notifySettingsSaved("keys");
			}
		} catch (error) { setError(error instanceof Error ? error.message : "ChatGPT connection failed"); }
		finally { setBusy(false); }
	}
	const active = status?.profiles.find((p) => p.id === status.activeId);
	const disabled = busy || !!status?.pending;
	return (
		<section className="flex flex-col gap-3 border-b border-border pb-4 text-xs" aria-label="ChatGPT subscription" data-testid="chatgpt-connection">
			<div>
				<p className="text-sm text-foreground">Use your ChatGPT plan</p>
				<p className="mt-1 text-muted-foreground">Connect an eligible ChatGPT account and allow plan usage. No API key needed.</p>
			</div>
			{status && status.profiles.length > 0 && <label className="flex flex-col gap-1 text-muted-foreground">
				ChatGPT connection
				<select aria-label="ChatGPT connection" value={status.activeId ?? ""} disabled={disabled} onChange={(e) => void action("select", e.target.value)} className="rounded border border-border bg-background px-2 py-1.5 text-foreground">
					<option value="" disabled>Choose a connection</option>
					{status.profiles.map((p) => <option key={p.id} value={p.id}>{p.email}{p.connected ? "" : " (signed out)"}</option>)}
				</select>
			</label>}
			{active?.sharing && <p className="text-muted-foreground">ChatGPT plan usage is enabled. Select ChatGPT subscription models for your learning agents.</p>}
			{active?.connected && !active.sharing && <p className="text-muted-foreground">Plan usage wasn’t granted. Reconnect and allow it to use your subscription.</p>}
			<div className="flex flex-wrap items-center gap-3">
				<button type="button" disabled={disabled || !status} onClick={() => void action("signin", active?.id)} className="rounded-md border border-border bg-foreground px-3 py-2 font-ui text-background disabled:opacity-50">{active?.connected ? "Reconnect ChatGPT" : "Continue with ChatGPT"}</button>
				{status && status.profiles.length > 0 && <button type="button" disabled={disabled} onClick={() => void action("signin")} className="text-muted-foreground underline disabled:opacity-50">Add account</button>}
				{active?.connected && <>
					<button type="button" disabled={disabled} onClick={() => void action("refresh")} className="text-muted-foreground underline disabled:opacity-50">Refresh models</button>
					<button type="button" disabled={disabled} onClick={() => void action("signout", active.id)} className="text-muted-foreground underline disabled:opacity-50">Sign out</button>
				</>}
				<a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="text-muted-foreground underline">Manage usage</a>
			</div>
			{status?.pending && <p className="text-muted-foreground">Finish signing in in your browser. <button type="button" disabled={busy} className="underline" onClick={() => void action("cancel")}>Cancel sign-in</button></p>}
			{authUrl && <a href={authUrl} target="_blank" rel="noreferrer" className="text-foreground underline">Open sign-in in your browser</a>}
			{(error || status?.error) && <p role="alert" className="text-red-400">{error ?? status?.error}</p>}
		</section>
	);
}
