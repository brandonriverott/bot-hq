# Cua desktop bridge

`HQ_DESKTOP=cua` connects one existing primary Hermes agent to a specifically named **local gVisor Linux container**, default `local:bot-hq-desktop`. Cua's free self-hosted runtime supplies the guest. It does not create managed Hermes agents, copy credentials, touch the Mac desktop, or use Orgo. The CLI is selected with `CUA_BIN` (default `cua`), and the name with `CUA_SANDBOX` (must start `bot-hq-`). A mismatched location, kind or runtime fails closed.

The server stays loopback-only and applies the local Host/Origin checks. All screenshots, viewer links and file routes require the existing authenticated bot ownership checks. Screenshot previews refresh after each completed capture, approximately every two seconds. Files stay under `/home/cua/bot-hq/files/<bot>` in the guest; downloads check resolved paths and are limited to 8 MiB.

Watch and Take control prepare separate ten-minute viewer tickets. Files/sharing are off for both; watch uses Cua's `--view-only` restriction. The full viewer opens in a separate tab because Cua sends `frame-ancestors 'none'`. We preserve that protection and never expose a spacesd root token to the browser. Viewer links must be loopback HTTP `/viewer/` URLs with a scoped ticket fragment.

No shared `cua do` target is changed. Each subprocess names the exact local guest. The agent's per-conversation instructions identify that guest and the existing Cua MCP/CLI route, forbid host fallback and credential copying, and leave the existing agent model/configuration untouched. Actual availability of the gateway's tools still needs a live agent check; an installed bridge alone does not prove agent adoption.

Create the dedicated guest with the installed Cua CLI, on the local machine, using its gVisor runtime and the official Linux desktop image. This setup may boot Cua's managed Linux VM where no Docker engine exists. Keep network protections enabled. This change does not relax Cua's runtime policies. Existing Spaces and workspaces are not reused or modified.

`npm run typecheck`, `npm run build`, and `node --test tests/local-mode.test.mjs tests/cua.test.mjs` check the adapter and both local modes without touching real providers or live agents. Real guest screenshot/command/viewer and agent checks are recorded separately in the local task report.

Default `HQ_DESKTOP=orgo` and `HQ_DESKTOP=none` remain available. Missing voice/connected-app keys still disable their features. Multiple agents, new credentials, public access, and new PRs/merges are outside this change's automatic rollout.
