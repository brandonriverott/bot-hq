# Local mode without Orgo

Set `HQ_DESKTOP=none` when starting the server. No Orgo key or computer is required. The server binds to 127.0.0.1, accepts localhost/127.0.0.1 hostnames and rejects cross-origin requests. With `DEV_LOGIN=1`, use the email form on this Mac only. Do not publish this mode through a proxy or tunnel.

This mode supports one existing Hermes gateway (default http://127.0.0.1:8642). It does not create extra managed agents or desktops. It does not modify the existing Hermes configuration. Chat still requires that gateway and its existing API authentication. Screens, desktop sign-in, and desktop-backed file operations are unavailable.

Composio and xAI keys are optional. Without them, connected apps/Google login and voice/X research are unavailable. No placeholder credentials are used. A session secret is still required. Existing Orgo installations keep the default `HQ_DESKTOP=orgo`.

Build with `npm run build`, check with `npm run typecheck`, and run isolated local-mode checks with `node --test tests/local-mode.test.mjs`. The tests use a temporary database and home, never your live Hermes keys or paid providers.

Cua Spaces is a possible future self-hosted desktop backend: https://github.com/trycua/cua . Its local software is free to use and self-host under the repository's stated licenses, but it is not Orgo API-compatible. Integration needs an adapter for desktop allocation, screenshot/input, streaming and file/command transport. This change does not install that adapter or claim that screens work.
