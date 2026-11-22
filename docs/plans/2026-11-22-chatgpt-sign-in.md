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

This first step is not connected to the window, plugin, or inference routes.
Those surfaces must never receive refresh tokens or retained ID tokens. A later
integration must keep all access-token handoff within the trusted local runtime.

Protocol reference: [OpenAI's open-source token-sharing documentation](https://developers.openai.com/siwc/token-sharing-open-source).
