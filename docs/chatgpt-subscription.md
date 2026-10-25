# ChatGPT subscription integration

The user approved a local ChatGPT subscription provider with browser sign-in, protected credentials, account model discovery, integration across the learning agents, and no fallback to paid API access.

## Structure

- `src/core/chatgpt.ts`: public provider identity and account status types.
- `src/store/chatgpt.ts`: a separate, atomic, mode-0600 credential record under `LH_DATA_DIR`. The persisted UUID host ID survives sign-out and reconnecting. A process-wide store serializes refresh, account selection, and credential writes. As with the rest of LearnHarness, one process owns a data directory.
- `src/server/chatgpt.ts`: loopback OAuth listener, PKCE, state, nonce, signature/issuer/audience/expiry verification with `jose`, issued-client registration reuse, multiple connections, token renewal, live models, and session revocation. The API projects only non-secret account status and authorization URLs. Cross-origin requests and non-loopback hosts are rejected. Cancelled and timed-out attempts close their listeners.
- `src/agent/chatgpt-provider.ts`: an injected Pi provider, using Pi's existing Responses streaming and tool-call machinery. Its auth resolver obtains a subscription token from the server; it cannot resolve an ambient API key. The payload adapter removes unsupported parameters, converts system inputs to developer messages, groups local tools in a namespace, and forces `stream: true` and `store: false` at `https://api.openai.com/v1/responses`.
- `components/chatgpt-connection.tsx`: shared setup/Settings account controls. Existing model slots and role overrides select the provider without a second agent implementation. The existing settings event invalidates model pickers after connection changes.

Account model discovery restricts the picker to `visibility: "list"`. Capability metadata comes from discovery where present, otherwise from the installed Pi catalog for an exact model ID. Models with unknown context/output limits are omitted rather than assigned invented values. Saved catalogs permit restart without signing in again; **Refresh models** updates them.

Concurrent discovery is deduplicated per profile: switching accounts starts discovery with the selected account's own credentials even while another account's request is pending. OpenAI's native `none` reasoning effort maps to Pi's `off` level, preserving disabled-reasoning selections through discovery and streaming.

No access tokens are sent through UI responses, browser storage, command arguments, or environment variables. Token exchange errors omit upstream response bodies. Credentials are permission-protected plaintext, matching the existing local API-key storage approach; this is not OS-keychain encryption. Credentials live under excluded `data/`, so they are absent from source control and desktop server payloads. No DevKit code is vendored.

Subscription calls retain token counts but contribute no estimated API dollar charge. The session summary and model menu display **ChatGPT plan**; actual allowance and optional credit controls remain in ChatGPT Settings. Existing API-provider selections continue using their chosen providers. No error path changes a subscription selection into API billing.

## Verification

`tests/chatgpt-auth.test.ts` exercises the real loopback callback with mocked OpenAI endpoints and locally signed ID tokens: state rejection, identity validation, reusable registration, concurrent token renewal/rotation, protected file permissions, scope gating, origin restrictions, and sign-out when remote revocation fails.

`tests/chatgpt-provider.test.ts` exercises the real Pi streaming adapter against mocked SSE: tool calls, request parameters, discovery, in-stream usage-limit errors, interrupted streams, and failure without an OAuth session despite an ambient API key.

The full repository tests, lint, TypeScript checks, production build, and standalone desktop-server probes should pass. A real ChatGPT sign-in and inference require the user's browser consent and eligible account; mocked tests do not establish account eligibility or a live provider response.

The verified production build command in this environment is `npm run build -- --webpack`: Turbopack's PostCSS worker cannot bind its evaluation port here. The browser barrel no longer re-exports the unused Node-only coverage module, and prompt fragments are explicitly included in standalone tracing so webpack also produces a complete desktop payload.

A live subscription check subsequently completed on GPT-6.1 Sol with reasoning enabled and a local function declared. It sent only a diagnostic request and received `OK`. This caught a gap in the original non-reasoning mock: Pi detects subscription restrictions only for the `openai` provider ID. The separate subscription provider now explicitly disables paid-API configuration updates, tool search, explicit prompt-cache options, and output-token caps on every dispatch, including cached model records. Thinking effort is sent in the request's reasoning configuration; mid-conversation tool additions use supported `additional_tools` items.

## Official protocol references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, renewal, revocation, and storage](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Model discovery and streamed inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Current request limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
