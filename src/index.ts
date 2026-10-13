/**
 * Overwing Preflight for x402: should the agent sign this payment?
 *
 * One hook on an @x402 client. Before any signature exists, the 402 terms
 * the client selected are posted to Overwing, which answers allow, review or
 * refuse with reasons: the terms against your policy, the payee against the
 * x402 directory and the server's own manifest, the price against what is
 * recorded for that endpoint.
 *
 * Fails open by default: a check that cannot be made never stops a payment.
 * In observe mode (the default) nothing stops a payment; the decision is
 * reported to `onDecision`. In enforce mode a refuse throws before signing.
 *
 * Reference: GET https://overwing.ai/api/v1/preflight/x402
 */

export type Decision = "allow" | "review" | "refuse";

export type Reason = { code: string; detail: string };

/** The same keys the API takes; every field is optional. */
export type Policy = {
  /** The most one payment may be, in USD. Default 0.05. */
  max_per_call_usd?: number;
  /** The most a payee nobody lists may be paid, in USD. Default 0.01. */
  new_payee_max_usd?: number;
  /** CAIP-2 networks the agent may pay on, e.g. "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  allowed_networks?: string[];
  /** Payout addresses that are always allowed (own services, known vendors). */
  allowed_payees?: string[];
  /** Payout addresses that are never paid. */
  blocked_payees?: string[];
  /** Whether testnet terms are acceptable. Default false. */
  allow_testnets?: boolean;
  /** How far the quoted price may drift from the recorded one, as a fraction. Default 0.25. */
  max_price_drift?: number;
};

export type PreflightResult = {
  decision: Decision;
  reasons: Reason[];
  terms?: { network?: string; asset_symbol?: string | null; amount_usd?: number | null; pay_to?: string; resource_url?: string | null; service_name?: string | null } & Record<string, unknown>;
  payee?: Record<string, unknown>;
  price?: Record<string, unknown>;
  valid_for_seconds?: number;
  checked_at?: string;
} & Record<string, unknown>;

export type Outcome =
  | { ok: true; result: PreflightResult; url: string | null; ms: number }
  | { ok: false; skipped: string; url: string | null; ms: number };

export type Options = {
  policy?: Policy;
  /** "observe" (default): report the decision, never stop a payment. "enforce": a refuse throws before signing. */
  mode?: "observe" | "enforce";
  /** In enforce mode, what a review does. "allow" (default) lets the payment through; "hold" throws. */
  onReview?: "allow" | "hold";
  /** In enforce mode, what happens when the check cannot be made. false (default): the payment goes ahead. true: it is stopped. */
  failClosed?: boolean;
  /** An Overwing API key. Without one the check is keyless: 10 a day per address. */
  apiKey?: string;
  /** Overwing's origin. Default https://overwing.ai */
  baseUrl?: string;
  /** How long to wait for the check. Default 2000 ms. */
  timeoutMs?: number;
  /** Also have Overwing fetch the resource unpaid and compare its quote with the terms given. Slower. Default false. */
  freshQuote?: boolean;
  /** Called with every outcome, made or skipped. */
  onDecision?: (outcome: Outcome) => void;
  /** Replace the fetch used for the check (tests, proxies). */
  fetch?: typeof fetch;
};

/** Thrown in enforce mode when the check says not to sign. */
export class PreflightRefused extends Error {
  readonly decision: Decision;
  readonly reasons: Reason[];
  readonly result: PreflightResult;
  constructor(result: PreflightResult) {
    super(`x402 preflight: ${result.decision} (${result.reasons.map((r) => r.code).join(", ") || "no reason given"})`);
    this.name = "PreflightRefused";
    this.decision = result.decision;
    this.reasons = result.reasons;
    this.result = result;
  }
}

/** Thrown in enforce mode with failClosed when the check could not be made. */
export class PreflightUnavailable extends Error {
  constructor(skipped: string) {
    super(`x402 preflight could not be made: ${skipped}`);
    this.name = "PreflightUnavailable";
  }
}

/** What the hook reads off the client's context. The same shape in @x402/core 2.x. */
export type PaymentCreationContext = { paymentRequired?: unknown; selectedRequirements: unknown };

export type HookClient = {
  onBeforePaymentCreation(hook: (context: PaymentCreationContext) => Promise<void | { abort: true; reason: string }>): unknown;
};

export const VERSION = "0.1.0";

const DEFAULTS = { baseUrl: "https://overwing.ai", timeoutMs: 2000, mode: "observe", onReview: "allow", failClosed: false } as const;

function requestedUrl(paymentRequired: unknown): string | null {
  const pr = paymentRequired as { resource?: { url?: unknown } } | null;
  const url = pr && typeof pr === "object" ? pr.resource?.url : undefined;
  return typeof url === "string" ? url : null;
}

function isDecision(v: unknown): v is Decision {
  return v === "allow" || v === "review" || v === "refuse";
}

/**
 * One check, with no client involved: the terms (the decoded PAYMENT-REQUIRED
 * object, or the header's base64 string) and the requirements the client
 * selected. Never throws.
 */
export async function preflight(paymentRequired: unknown, selected: unknown, opts: Options = {}): Promise<Outcome> {
  const started = Date.now();
  const url = requestedUrl(paymentRequired);
  const sel = (typeof selected === "object" && selected !== null ? selected : {}) as { network?: unknown };
  const terms = paymentRequired ?? { x402Version: 2, resource: url ? { url } : undefined, accepts: [sel] };
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": `overwing-x402-preflight/${VERSION}` };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const body: Record<string, unknown> = { payment_required: terms, policy: opts.policy ?? {} };
  if (url) body.requested_url = url;
  if (typeof sel.network === "string") body.network = sel.network;
  if (opts.freshQuote) body.fresh_quote = true;
  const base = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${base}/api/v1/preflight/x402`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULTS.timeoutMs) });
    if (!res.ok) return { ok: false, skipped: `preflight answered ${res.status}`, url, ms: Date.now() - started };
    const json = (await res.json()) as Partial<PreflightResult> | null;
    if (!json || typeof json !== "object" || !isDecision(json.decision)) return { ok: false, skipped: "preflight gave no decision", url, ms: Date.now() - started };
    const reasons = Array.isArray(json.reasons) ? json.reasons.filter((r): r is Reason => typeof r === "object" && r !== null && typeof (r as Reason).code === "string").map((r) => ({ code: r.code, detail: typeof r.detail === "string" ? r.detail : "" })) : [];
    return { ok: true, result: { ...json, decision: json.decision, reasons }, url, ms: Date.now() - started };
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" ? `timed out after ${opts.timeoutMs ?? DEFAULTS.timeoutMs} ms` : err.message) : String(err);
    return { ok: false, skipped: `preflight unreachable: ${msg}`, url, ms: Date.now() - started };
  }
}

/** What an outcome means under the options: stop the payment, or let it through. */
export function shouldStop(outcome: Outcome, opts: Options = {}): Error | null {
  if ((opts.mode ?? DEFAULTS.mode) !== "enforce") return null;
  if (!outcome.ok) return (opts.failClosed ?? DEFAULTS.failClosed) ? new PreflightUnavailable(outcome.skipped) : null;
  const d = outcome.result.decision;
  if (d === "refuse" || (d === "review" && (opts.onReview ?? DEFAULTS.onReview) === "hold")) return new PreflightRefused(outcome.result);
  return null;
}

/**
 * Register the check on an @x402 client (x402Client from @x402/fetch, @x402/axios
 * or @x402/core). Call it before any spend-control hook of your own so a
 * refused payee is stopped before a budget is reserved for it, and before
 * wrapFetchWithPayment. Returns the client.
 */
export function attachPreflight<C extends HookClient>(client: C, opts: Options = {}): C {
  client.onBeforePaymentCreation(async (ctx) => {
    const outcome = await preflight(ctx.paymentRequired ?? null, ctx.selectedRequirements, opts);
    try {
      opts.onDecision?.(outcome);
    } catch {
      // a reporting error is never a reason to stop or to allow a payment
    }
    const stop = shouldStop(outcome, opts);
    if (stop) throw stop;
  });
  return client;
}
