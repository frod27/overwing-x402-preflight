# overwing-x402-preflight

Check an x402 payment before your agent signs it.

One hook on any `@x402` client. Before a signature exists, the terms in the 402 are posted to [Overwing Preflight for x402](https://overwing.ai/api/v1/preflight/x402), which answers **allow**, **review** or **refuse** with reasons:

- the terms against your policy: amount, network, asset, timeout, resource, testnets;
- the payee against the x402 directory (verified delivery, settlements, buyers, shared payout addresses) and the server's own `/.well-known/x402` manifest;
- the price against what is recorded for that endpoint.

It is not a simulation and not a guarantee. It says whether the terms and the payee look like what they claim; it cannot see what the service will deliver.

No dependencies. Works with `x402Client` from `@x402/fetch`, `@x402/axios` or `@x402/core` (2.x), and with anything that exposes `onBeforePaymentCreation`.

## Install

```bash
npm install overwing-x402-preflight
```

## Use

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { attachPreflight } from "overwing-x402-preflight";

const client = new x402Client();
attachPreflight(client, {
  mode: "enforce",
  policy: { max_per_call_usd: 0.05, new_payee_max_usd: 0.01, allowed_networks: ["eip155:8453"] },
  onDecision: (o) => console.log("preflight", o.ok ? o.result.decision : o.skipped, o.url),
});
registerExactEvmScheme(client, { signer });

const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://example.com/api/thing"); // a refused payment throws PreflightRefused before signing
```

Register it before any spend-control hook of your own, so a refused payee is stopped before a budget is reserved for it.

## Options

| Option | Default | What it does |
|---|---|---|
| `policy` | `{}` | `max_per_call_usd` (0.05), `new_payee_max_usd` (0.01), `allowed_networks`, `allowed_payees`, `blocked_payees`, `allow_testnets` (false), `max_price_drift` (0.25). The API's defaults apply to anything left out. |
| `mode` | `"observe"` | `observe`: report the decision, never stop a payment. `enforce`: a refuse throws `PreflightRefused` before signing. |
| `onReview` | `"allow"` | In enforce mode, `hold` also throws on a review. |
| `failClosed` | `false` | In enforce mode, stop the payment when the check cannot be made (throws `PreflightUnavailable`). Off by default: a check that cannot be made never stops a payment. |
| `apiKey` | none | An Overwing key. Without one the check is keyless, 10 a day per address. A key is free: `POST https://overwing.ai/api/v1/signup`. |
| `timeoutMs` | 2000 | How long to wait for the check. |
| `freshQuote` | `false` | Also have Overwing fetch the resource unpaid and compare its quote with the terms you were given. Slower. |
| `baseUrl` | `https://overwing.ai` | Overwing's origin. |
| `onDecision` | none | Called with every outcome, made or skipped. |
| `fetch` | global | Replace the fetch used for the check. |

Start in observe mode and read what `onDecision` reports for a day; then switch to enforce. Put your own services' payout addresses in `allowed_payees`.

## Without a client

```ts
import { preflight } from "overwing-x402-preflight";

const outcome = await preflight(decodedPaymentRequired, selectedRequirements, { policy });
if (outcome.ok) console.log(outcome.result.decision, outcome.result.reasons);
```

`preflight` never throws. `shouldStop(outcome, options)` returns the error `attachPreflight` would throw, or `null`.

## Reasons

`terms_*` (unusable, version, scheme, testnet, network_unknown, asset, amount, amount_cap, timeout), `resource_*` (mismatch, missing), `payee_*` (blocked, not_allowed, allowed, manifest_match, manifest_mismatch, differs_from_listing, new_small, new, verified, listed, listed_unsettled, status, risk, shared, concentrated), `price_*` (listed, drift, inconsistent). The full list with what each means: `GET https://overwing.ai/api/v1/preflight/x402`.

## Also

- The same check as an MCP tool, `preflight_payment`, on `https://overwing.ai/mcp` and in the `overwing-mcp` package.
- The OpenClaw plugin `overwing-openclaw` runs it on every wallet payment (shadow by default, `x402Preflight: "enforce"` to stop refusals).
- Paid per check with a wallet and no key: `POST https://overwing.ai/api/x402/preflight/x402`, $0.002 USDC over x402.

Data: [x402-list.com](https://x402-list.com) (CC BY 4.0); Overwing Atlas.

MIT.
