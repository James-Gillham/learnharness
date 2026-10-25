import { handleChatGPTRequest } from "@/src/server";

export const runtime = "nodejs";
export const GET = handleChatGPTRequest;
export const POST = handleChatGPTRequest;
