# Desktop ChatGPT sign-in

The desktop main process owns ChatGPT OAuth and its renewable session. It uses
OpenAI's documented public-client dynamic registration, PKCE, a loopback callback,
and verified OIDC identity. No DSH changes or DevKit source are used.

The initial module serves one account registration. It retains the issued client
ID, verified account mapping and installation host ID across sign-out. A later
account picker must keep registrations separate rather than replace this mapping.
Reauthorization rejects a different account or client ID.

The whole record lives encrypted by Electron safeStorage in userData, outside
DSH_HOME. Without OS-backed encryption the feature is unavailable; Linux
basic_text is not accepted. This protects copied files, not a compromised running
main process. Existing DSH API keys and Bot secrets are unchanged.

Only a successfully persisted token rotation may be used. Concurrent refreshes
share one operation. Terminal refresh errors remove tokens but retain registration;
temporary failures preserve credentials. Sign-out attempts remote revocation and
reports whether it was confirmed, then removes local tokens even on remote failure.

## Main process and relay

Electron main creates the sign-in service and a loopback relay once per app launch,
before starting any DSH child (including an import's warm child). The relay binds
127.0.0.1 on a random port, requires its exact Host and a timing-safe checked random
32-byte bearer secret, and accepts only GET /v1/models and POST /v1/responses.
The relay secret is per-launch, not an OpenAI credential. Only main receives OpenAI
access, refresh and ID tokens. Nothing is passed to a renderer or written to DSH's
credential store except the loopback-only relay secret.

Responses bodies are limited to 32 MiB, parsed as JSON, and normalized for the
preview: store:false, stream:true, unsupported fields removed, system input messages
appended to instructions, developer messages retained. String input becomes a user
message array. Flat function/custom tools are grouped in the reserved ds_bot namespace
using {type:'namespace',name:'ds_bot',description,tools:[...]}; schemas, tool names and
tool_choice are retained. Existing namespaces and hosted tool definitions are retained.
Replayed function_call/custom_tool_call items without a namespace receive ds_bot,
including history whose tool definition is no longer present. Function results stay
linked by their unchanged call_id; no qualified name or namespace is needed on the
ordinary {type:'function_call_output',call_id,output} result.

The [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces)
documents namespace declarations. The [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
defines call name and namespace as separate fields. Its forced tool_choice schema
defines only type and name, so the relay keeps the original leaf name rather than
inventing a dotted name or an undocumented choice namespace. The reference does not
explain forced selection between identical leaf names in different namespaces;
DSH's flat tools do not introduce that ambiguity.

SSE output_item events and response output arrays have the relay's namespace removed
from function/custom calls, while names, IDs and arguments remain unchanged. Echoed
ds_bot tool declarations are flattened. Only complete SSE events are buffered, not
the response; chunked UTF-8, multiline data and event metadata are preserved.
Upstream status, content-type and non-SSE bodies (including subscription_sharing_*
errors) pass through unchanged. Live account/tool compatibility remains unverified.
Disconnects abort upstream requests. A 401 before
streaming triggers one refresh and one retry. Redirects are never followed; they
return a fixed local 502 error. Credential errors return 401 (sign-in/consent needed)
or 503 (unsupported/temporary failure), with a fixed safe message and
error.code = chatgpt_<state>. A signed-out relay uses chatgpt_needs-sign-in.

The plugin maintains a separate openai-chatgpt route named ChatGPT (plan), protocol
openai-responses, pointing at the current relay's /v1. Its OPENAI_CHATGPT_API_KEY
credential is replaced on every launch, as is the endpoint, even if model refresh
fails. The existing openai API-key route is never modified. Models use the ordinary
provider model-saving logic. DSH custom routes require at least one model: an empty
visible-model list creates no new route and preserves an existing list, rather than
inventing models. A plan-usage-off session cannot list inference models yet.
Sign-out retains an established account's route and models. A route for an installation
that never signed in is removed. Manual API-key edits and removal are refused.

## IPC

The child sends {type:'ds-bot:chatgpt', id, method, body?}; main responds with
{type:'ds-bot:chatgpt-response', id, result} or {type, id, error:{state, message,...}}.
Errors contain fixed safe text, never remote diagnostics. Request methods:

- chatgpt:status -> Status
- chatgpt:sign-in, {consent?:boolean} -> Status after the attempt finishes; main opens
  the browser and owns cancellation. consent:true requests prompt=consent.
- chatgpt:cancel -> current Status; abort requested (completion is asynchronous).
- chatgpt:sign-out -> Status plus remoteRevocationConfirmed:boolean
- chatgpt:models -> [{id, name}] in server order
- chatgpt:route -> {baseURL, secret}, **trusted child only**, never a client channel

Main pushes {type:'chatgpt:changed', status:Status} whenever service status changes,
including relay-triggered refresh failures. The plugin retains the latest push;
clients poll the chatgpt channel for authoritative status. No renderer push API is
introduced here. Process listeners and relay connections are cleaned up on disposal.

## UI contract

No src/client changes are included. The existing authenticated /api/bot POST body
is {endpoint, payload?}. Success is {ok:true, value}; failure is the ordinary
{ok:false, error:{code,message,details}}. After a failed operation, query chatgpt
again for its current state. The frontend must never request or display relay secrets.

| Endpoint | Payload | Success value |
| --- | --- | --- |
| chatgpt | none | Status |
| chatgpt-sign-in | {consent?:boolean} | Status, resolves when sign-in finishes and route refresh completes |
| chatgpt-cancel | none | current Status (abort requested) |
| chatgpt-sign-out | none | Status plus remoteRevocationConfirmed:boolean |
| chatgpt-models | none | [{id,name}], also refreshes the route; empty results preserve existing models |

Outside DS_BOT_APP=1, every endpoint above returns {state:'unsupported'} and performs
no IPC or route writes. Provider rows identify this route with auth:'chatgpt',
key.writable:false and removable:false. Use sign-in/sign-out, not provider-key or
provider-remove. Models remain selectable after sign-out; inference then reports
chatgpt_needs-sign-in until reauthorization.

Status is {state, account?:{email?,name?}, planUsage?:boolean, expiresAt?:number};
expiresAt is Unix milliseconds. No status includes tokens or internal account IDs.

| State | UI needed |
| --- | --- |
| unsupported | Explain desktop/OS secure-storage requirement; disable sign-in |
| signed-out | Offer Sign in with ChatGPT; retained account identity may be shown |
| signing-in | Show browser sign-in in progress and Cancel; avoid duplicate starts |
| connected | Show account, plan usage, model refresh and Sign out |
| plan-usage-off | Show account; offer Enable plan usage via consent:true, and Sign out |
| needs-sign-in | Explain session expired/revoked; offer reauthorization and Sign out |
| temporarily-unavailable | Show retryable connection/storage failure; preserve account and avoid implying sign-out |

If remoteRevocationConfirmed is false after sign-out, explain that local credentials
were cleared but remote revocation was not confirmed. A completed sign-in may still
have no visible models; show an empty list rather than a placeholder model.

Protocol reference: [OpenAI's open-source token-sharing documentation](https://developers.openai.com/siwc/token-sharing-open-source).
