import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachPreflight, preflight, shouldStop, PreflightRefused, PreflightUnavailable, type HookClient, type PaymentCreationContext, type Outcome } from "../src/index.ts";

type Hook = (ctx: PaymentCreationContext) => Promise<void | { abort: true; reason: string }>;

function stubClient(): HookClient & { hooks: Hook[]; run(ctx: PaymentCreationContext): Promise<void> } {
  const hooks: Hook[] = [];
  return {
    hooks,
    onBeforePaymentCreation(hook: Hook) {
      hooks.push(hook);
      return this;
    },
    async run(ctx) {
      for (const h of hooks) await h(ctx);
    },
  };
}

const TERMS = { x402Version: 2, resource: { url: "https://example.com/api/thing" }, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "20000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: {} }] };
const SELECTED = TERMS.accepts[0];

function answering(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("preflight()", () => {
  it("posts the terms, the requested URL, the network and the policy to Overwing", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const out = await preflight(TERMS, SELECTED, { fetch: answering(200, { decision: "allow", reasons: [] }, seen), policy: { max_per_call_usd: 0.05 }, apiKey: "ow_live_x" });
    assert.equal(out.ok, true);
    assert.equal(seen.url, "https://overwing.ai/api/v1/preflight/x402");
    const body = JSON.parse(String(seen.init?.body));
    assert.deepEqual(body.payment_required, TERMS);
    assert.equal(body.requested_url, "https://example.com/api/thing");
    assert.equal(body.network, "eip155:8453");
    assert.deepEqual(body.policy, { max_per_call_usd: 0.05 });
    const headers = seen.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer ow_live_x");
    assert.match(headers["User-Agent"], /^overwing-x402-preflight\//);
  });
  it("builds terms from the selected requirements when the client gives no PAYMENT-REQUIRED object", async () => {
    const seen: { init?: RequestInit } = {};
    await preflight(null, SELECTED, { fetch: answering(200, { decision: "allow", reasons: [] }, seen) });
    const body = JSON.parse(String(seen.init?.body));
    assert.equal(body.payment_required.x402Version, 2);
    assert.deepEqual(body.payment_required.accepts, [SELECTED]);
    assert.equal("requested_url" in body, false);
  });
  it("keeps the decision and normalizes the reasons", async () => {
    const out = await preflight(TERMS, SELECTED, { fetch: answering(200, { decision: "review", reasons: [{ code: "payee_new", detail: "nobody lists it" }, { bad: true }], terms: { amount_usd: 0.02 } }) });
    assert.ok(out.ok);
    assert.equal(out.result.decision, "review");
    assert.deepEqual(out.result.reasons, [{ code: "payee_new", detail: "nobody lists it" }]);
    assert.equal(out.result.terms?.amount_usd, 0.02);
    assert.equal(out.url, "https://example.com/api/thing");
  });
  it("never throws: a non-2xx, a bad body or an unreachable server is a skipped outcome", async () => {
    const a = await preflight(TERMS, SELECTED, { fetch: answering(429, { error: "limit" }) });
    assert.deepEqual([a.ok, (a as { skipped: string }).skipped], [false, "preflight answered 429"]);
    const b = await preflight(TERMS, SELECTED, { fetch: answering(200, { nope: 1 }) });
    assert.deepEqual([b.ok, (b as { skipped: string }).skipped], [false, "preflight gave no decision"]);
    const c = await preflight(TERMS, SELECTED, { fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    assert.equal(c.ok, false);
    assert.match((c as { skipped: string }).skipped, /unreachable: ECONNREFUSED/);
  });
  it("gives up after timeoutMs", async () => {
    // AbortSignal.timeout does not keep the event loop alive, so the stub holds a timer until the signal fires.
    const slow = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const keep = setTimeout(() => reject(new Error("the signal never fired")), 1000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keep);
          reject(init.signal?.reason);
        });
      })) as typeof fetch;
    const out = await preflight(TERMS, SELECTED, { fetch: slow, timeoutMs: 20 });
    assert.equal(out.ok, false);
    assert.match((out as { skipped: string }).skipped, /timed out after 20 ms/);
  });
});

describe("shouldStop()", () => {
  const refuse: Outcome = { ok: true, result: { decision: "refuse", reasons: [{ code: "payee_blocked", detail: "" }] }, url: null, ms: 1 };
  const review: Outcome = { ok: true, result: { decision: "review", reasons: [] }, url: null, ms: 1 };
  const allow: Outcome = { ok: true, result: { decision: "allow", reasons: [] }, url: null, ms: 1 };
  const skipped: Outcome = { ok: false, skipped: "preflight answered 503", url: null, ms: 1 };
  it("observe mode never stops a payment", () => {
    for (const o of [refuse, review, allow, skipped]) assert.equal(shouldStop(o), null);
    assert.equal(shouldStop(refuse, { mode: "observe", failClosed: true }), null);
  });
  it("enforce mode stops a refuse, lets an allow through, and holds a review only when asked", () => {
    assert.ok(shouldStop(refuse, { mode: "enforce" }) instanceof PreflightRefused);
    assert.equal(shouldStop(allow, { mode: "enforce" }), null);
    assert.equal(shouldStop(review, { mode: "enforce" }), null);
    assert.ok(shouldStop(review, { mode: "enforce", onReview: "hold" }) instanceof PreflightRefused);
  });
  it("a check that cannot be made stops the payment only with failClosed", () => {
    assert.equal(shouldStop(skipped, { mode: "enforce" }), null);
    assert.ok(shouldStop(skipped, { mode: "enforce", failClosed: true }) instanceof PreflightUnavailable);
  });
});

describe("attachPreflight()", () => {
  it("registers one hook and returns the client", () => {
    const c = stubClient();
    assert.equal(attachPreflight(c, { fetch: answering(200, {}) }), c);
    assert.equal(c.hooks.length, 1);
  });
  it("reports every outcome and, in observe mode, lets the payment through", async () => {
    const c = stubClient();
    const seen: Outcome[] = [];
    attachPreflight(c, { fetch: answering(200, { decision: "refuse", reasons: [{ code: "payee_blocked", detail: "" }] }), onDecision: (o) => seen.push(o) });
    await c.run({ paymentRequired: TERMS, selectedRequirements: SELECTED });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].ok && seen[0].result.decision === "refuse");
  });
  it("in enforce mode a refuse throws before the signature, with the reasons on the error", async () => {
    const c = stubClient();
    attachPreflight(c, { mode: "enforce", fetch: answering(200, { decision: "refuse", reasons: [{ code: "payee_blocked", detail: "on your list" }] }) });
    await assert.rejects(c.run({ paymentRequired: TERMS, selectedRequirements: SELECTED }), (err: unknown) => err instanceof PreflightRefused && err.reasons[0].code === "payee_blocked" && /refuse \(payee_blocked\)/.test(err.message));
  });
  it("in enforce mode an unreachable check lets the payment through unless failClosed", async () => {
    const down = (async () => { throw new Error("down"); }) as typeof fetch;
    const open = stubClient();
    attachPreflight(open, { mode: "enforce", fetch: down });
    await open.run({ paymentRequired: TERMS, selectedRequirements: SELECTED });
    const closed = stubClient();
    attachPreflight(closed, { mode: "enforce", failClosed: true, fetch: down });
    await assert.rejects(closed.run({ paymentRequired: TERMS, selectedRequirements: SELECTED }), PreflightUnavailable);
  });
  it("a throwing onDecision neither stops nor allows a payment on its own", async () => {
    const c = stubClient();
    attachPreflight(c, { mode: "enforce", fetch: answering(200, { decision: "refuse", reasons: [] }), onDecision: () => { throw new Error("logger broke"); } });
    await assert.rejects(c.run({ paymentRequired: TERMS, selectedRequirements: SELECTED }), PreflightRefused);
  });
});
