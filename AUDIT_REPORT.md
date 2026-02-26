# Codebase Audit: Bugs, Security Vulnerabilities, and Logic Errors

Date: 2026-02-26
Scope: full repository (`/workspace/gcse-study-app`)

## Executive summary

The highest-risk issues are concentrated in billing/webhook handling and plan authorization consistency:

1. **`api/stripe-webhook.js` currently fails CommonJS parsing** (`export const config` in a CommonJS project), which can make the webhook endpoint non-functional.
2. **Plan field mismatch (`tier` vs `role`)** means payments can succeed while AI entitlements remain on free limits.
3. **Checkout ↔ webhook user correlation is incomplete** (`userId` is sent by frontend but not persisted as Stripe metadata), so subscription upgrades may not attach to a user deterministically.
4. **The AI usage counters are race-prone** (read-modify-write without transaction/RPC), enabling quota bypass under concurrent requests.
5. **Client-rendered DB content in `pastpapers.html` is inserted via `innerHTML` into anchors** without URL sanitization, creating XSS/open-redirect style risk if DB content is polluted.

---

## Findings

## 1) Webhook runtime syntax incompatibility (Critical)
- **Evidence:** `api/stripe-webhook.js` uses `export const config` and also `module.exports` while the project is CommonJS (`"type": "commonjs"`).
- **Impact:** The webhook function can fail to load in a CommonJS runtime, preventing subscription lifecycle events from being processed.
- **Where:** `api/stripe-webhook.js`, `package.json`.

## 2) Subscription entitlement field mismatch (`tier` vs `role`) (Critical)
- **Evidence:** AI authorization reads `user_settings.role`, but billing/account code writes `user_settings.tier`.
- **Impact:** Users can pay for Plus/Pro and still be treated as free on AI endpoints; operational support burden and revenue-impacting logic bug.
- **Where:** `api/ai.js`, `api/stripe-webhook.js`, `account.html`.

## 3) Checkout does not reliably bind Stripe session to a concrete user (High)
- **Evidence:** Frontend sends `userId` in payload, but backend ignores it and does not write `user_id` into Stripe metadata. Webhook then attempts fragile fallback by listing all users and matching email.
- **Impact:** Missed or incorrect entitlement assignment; expensive/slow user lookup pattern in webhook path.
- **Where:** `subscriptions.html`, `api/create-checkout-session.js`, `api/stripe-webhook.js`.

## 4) Webhook fallback enumerates all users (High)
- **Evidence:** `supabaseAdmin.auth.admin.listUsers()` then linear search by email.
- **Impact:** Inefficient and brittle at scale; potential to hit API limits/timeouts and delay webhook processing.
- **Where:** `api/stripe-webhook.js`.

## 5) AI quota updates are race-condition prone (High)
- **Evidence:** Usage updates do `select` + arithmetic + `upsert` without transaction/atomic increment.
- **Impact:** Concurrent requests can undercount usage and bypass quotas.
- **Where:** `api/ai.js` (`bumpTokenUsage`, `bumpImageUsage`).

## 6) Unvalidated timezone can crash AI requests (Medium)
- **Evidence:** User-supplied `req.body.timezone` is passed into `Intl.DateTimeFormat(..., { timeZone: tz })` without validation/try-catch.
- **Impact:** Invalid IANA timezone string can trigger runtime error and 500 responses (easy request-level DoS).
- **Where:** `api/ai.js`.

## 7) Unsafe HTML insertion of DB-provided URLs in past papers page (Medium)
- **Evidence:** `results.innerHTML` interpolates `data.question_link` and `data.markscheme_link` directly into `<a href="...">`.
- **Impact:** If database content is compromised/malformed, can inject malicious URLs or scriptable payloads; phishing/XSS risk.
- **Where:** `pastpapers.html`.

## 8) `target="_blank"` links missing `rel="noopener noreferrer"` (Low)
- **Evidence:** External links are opened in new tab without `rel` protections.
- **Impact:** Tabnabbing/opener abuse risk.
- **Where:** `pastpapers.html`.

## 9) Success redirect points to missing page (Low functional bug)
- **Evidence:** Checkout success URL points to `/billing-success.html`, but that file does not exist in repo.
- **Impact:** Post-checkout broken UX / potential failed confirmation flow.
- **Where:** `api/create-checkout-session.js` and repository root.

## 10) Repository hygiene issue: accidental shell-output files committed (Low)
- **Evidence:** Files named `h origin main --force` and `et --hard 7c1e0b9` exist and contain command output artifacts.
- **Impact:** Confusing repository state, accidental data leakage of git history context, and reduced maintainability.
- **Where:** repository root.

---

## Prioritized remediation plan

### Phase 0 (Same day, blockers)
1. **Fix webhook module format**
   - Convert `export const config` to CommonJS-compatible export pattern for your serverless runtime.
   - Add a deployment smoke test that invokes webhook locally with a signed fixture.
2. **Unify entitlement field names**
   - Choose one canonical field (`role` recommended) across UI, checkout, webhook, and AI authorization.
   - Backfill/migrate existing `user_settings` rows.
3. **Bind checkout to authenticated user IDs server-side**
   - Require auth on `/api/create-checkout-session`.
   - Set `metadata.user_id` and `subscription_data.metadata.user_id` from verified server-side identity only.

### Phase 1 (This week, security + correctness hardening)
4. **Eliminate webhook user enumeration fallback**
   - Resolve users by metadata only (or maintain a dedicated stripe_customer_id ↔ user_id mapping table).
5. **Make usage accounting atomic**
   - Move increments to a Postgres RPC/SQL function using `insert ... on conflict ... do update` atomic arithmetic.
   - Enforce caps in the same transaction where feasible.
6. **Validate timezone input strictly**
   - Accept only valid IANA IDs (allowlist or validation helper); fallback to stored timezone/UTC on invalid input.
7. **Sanitize rendered links in past papers UI**
   - Build anchors via `document.createElement("a")` and assign `href` only after protocol validation (`https:` only).
   - Add `rel="noopener noreferrer"` for all `target="_blank"` links.

### Phase 2 (This sprint, resilience)
8. **Add end-to-end tests for billing and entitlements**
   - Test: checkout session creation includes user metadata.
   - Test: webhook events update expected `user_settings.role`.
   - Test: AI endpoint enforces plan limits after webhook update.
9. **Fix success page routing**
   - Create `billing-success.html` or align success URL with existing page.
10. **Clean repository artifacts**
   - Remove accidental files and add a lightweight pre-commit hook for common command-output artifacts.

---

## Suggested implementation checklist

- [ ] Refactor billing+webhook schema to one entitlement field (`role`).
- [ ] Add auth middleware to checkout endpoint; reject unauthenticated calls.
- [ ] Write Stripe metadata (`user_id`) from authenticated session.
- [ ] Remove `listUsers()` fallback from webhook; fail fast + alert instead.
- [ ] Implement atomic DB counters for token/image usage.
- [ ] Add timezone validation helper and test invalid timezone behavior.
- [ ] Replace risky `innerHTML` link rendering with safe DOM APIs in `pastpapers.html`.
- [ ] Add/repair post-checkout success page.
- [ ] Delete accidental root artifact files.


## Remediation status update

- Completed Medium items: timezone validation in `api/ai.js`; safe external link rendering in `pastpapers.html`.
- Completed Low items: added `rel="noopener noreferrer"` for `_blank` links; removed accidental shell-output files from repo root.
- Completed Low checkout UX issue: success redirect now points to an existing page (`account.html`).

