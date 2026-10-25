import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";

export interface ChatGPTProfile {
	id: string;
	clientId: string;
	subject?: string;
	email?: string;
	access?: string;
	refresh?: string;
	idToken?: string;
	expires?: number;
	scopes?: string[];
	models?: Model<"openai-responses">[];
}
export interface ChatGPTRecord {
	version: 1;
	hostId: string;
	activeId: string | null;
	profiles: ChatGPTProfile[];
}

/** Separate from API keys: tokens must never be reflected into OPENAI_API_KEY.
 * Like auth.json, this is a local, owner-readable file, not encrypted storage.
 * The desktop single-instance lock owns this data directory. */
export function createChatGPTStore(file = path.join(PATHS.data, "chatgpt-auth.json")) {
	let chain: Promise<unknown> = Promise.resolve();
	function read(): ChatGPTRecord {
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8")) as ChatGPTRecord;
			if (value.version !== 1 || !value.hostId || !Array.isArray(value.profiles)) {
				throw new Error("Invalid ChatGPT credential record");
			}
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { version: 1, hostId: `urn:uuid:${randomUUID()}`, activeId: null, profiles: [] };
		}
	}
	function write(value: ChatGPTRecord) {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, file);
		} finally {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		}
	}
	return {
		read,
		/** Serialize token rotation with sign-in, selection, and sign-out. */
		modify<T>(fn: (record: ChatGPTRecord) => T | Promise<T>): Promise<T> {
			const next = chain.then(async () => {
				const record = read();
				const result = await fn(record);
				write(record);
				return result;
			});
			chain = next.catch(() => undefined);
			return next;
		},
	};
}

const key = Symbol.for("lh.chatgptStore");
const globalStore = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createChatGPTStore> };
export const chatgptStore = globalStore[key] ??= createChatGPTStore();
