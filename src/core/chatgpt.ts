/** Browser-safe identity and status for the subscription-only provider. */
export const CHATGPT_PROVIDER = "chatgpt-subscription";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export interface ChatGPTStatus {
	profiles: { id: string; email: string; connected: boolean; sharing: boolean }[];
	activeId: string | null;
	pending: boolean;
	error: string | null;
}
