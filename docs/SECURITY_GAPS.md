# Watcher / Alert-path security gaps

Tracked auth/permission weaknesses in the watcher agent and the subscription/peg-monitor path. `gh` CLI is unavailable locally; mirror these to github.com/maxalexweber1/CHAINFEED issues when convenient.

---

## 1. MCP transport has no authentication — RESOLVED (2026-05-28)

**Status:** Fixed. `srv/mcp/http.ts` now enforces `Authorization: Bearer <MCP_AUTH_TOKEN>` on `/mcp` (constant-time compare), `main()` fails closed in production when the token is unset, and all agents send it via the client's `authToken` option. `/healthz` stays open. Covered by `scripts/test-mcp-http.ts` (401 missing/wrong, 200 correct).

**Severity:** High
**Where:** `srv/mcp/http.ts`, `agents/shared/chainfeed-client.ts:35`

The CHAINFEED MCP HTTP server is stateless (`sessionIdGenerator: undefined`) and performs no authentication. Any process that can reach `localhost:4005/mcp` can call `assess_stable`, `get_service_status`, etc. The watcher's `clientName: 'chainfeed-watcher'` on the `initialize` handshake is purely cosmetic — the server neither verifies nor authorizes based on it.

**Impact:** Unauthenticated read access to the full tool surface; in any deploy where the MCP port is reachable beyond loopback, anyone can drive fanout to Blockfrost/Koios/DEX GraphQL.

**Proposed fix:** Require a bearer token (env-configured shared secret or per-client key) on the MCP transport; reject unauthenticated `initialize`. Bind to loopback by default and document the exposure if widened.

---

## 2. SSRF guard is bypassable via DNS rebinding — RESOLVED (2026-05-28)

**Status:** Fixed. `srv/lib/webhook-egress.ts:assertPublicEgress` resolves the webhook hostname and re-checks every A/AAAA record against the private-range patterns immediately before each POST in `fireWebhook` (`srv/workers/peg-monitor.ts`). Fails closed on private resolution, private literal, DNS failure, or empty result; enforced in production. Covered by `scripts/test-webhook-egress.ts` (8 cases). Firewall egress restriction is still recommended as defense-in-depth.

**Severity:** Medium
**Where:** `srv/lib/alert-detector.ts:186-232` (`validateWebhookUrl`, `isPrivateHostLiteral`)

`validateWebhookUrl` only does a literal-hostname check against `PRIVATE_HOST_PATTERNS`. A subscriber can register `webhookUrl=https://evil.example.com/...` whose public DNS A-record points at `10.0.0.1` (or flips after validation), and the peg-monitor worker will POST to the internal target. The code already documents this as a known limitation.

**Impact:** Server-side request forgery against internal services from the alert-firing worker, despite the literal-IP guard.

**Proposed fix:** Resolve the hostname and re-check the resolved IP against the private ranges immediately before each outbound POST (defeats static rebinds), and/or pin egress at the firewall. Consider an allowlist for high-value deploys.

---

## 3. Rate limiting is IP-only and disabled outside production — PARTIALLY RESOLVED (2026-05-28)

**Severity:** Medium
**Where:** `srv/lib/rate-limit.ts` (limiters), limiter key

**Done:** The implicit `NODE_ENV`-based no-op is gone — limits are now ENABLED by default in every environment and disabled only via the explicit `RATE_LIMIT_DISABLED=1` flag. A non-prod-but-internet-reachable deploy keeps real limits unless someone deliberately opts out.

**Still open:** All limiters still key solely on `req.ip` (via `trust proxy`), with no per-consumer/identity dimension, so a distributed source can evade the per-IP caps and shared-NAT users collide.

**Impact (remaining):** Quota exhaustion (Blockfrost) and subscription-table abuse are only bounded per-IP.

**Proposed fix (remaining):** Add an identity dimension (API key / x402 payer) to the limiter key for authenticated routes.
