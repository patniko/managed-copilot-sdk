// The bundled demo service's "production": logs and deploy history generated around the alert's time (so timestamps are
// current), and the Alertmanager notification the "Simulate an incident" button posts. Deterministic for a seed, so
// the numbers in the alert are the ones the agent finds in the logs.

export const DEMO_SERVICE = "checkout";

/** What makes one simulated incident's logs: a seed and the moment the alert fired. */
export interface DemoSeed {
  readonly seed: number;
  readonly at: string;
}

/** The demo service's source files the stack traces point into. */
export interface DemoSources {
  readonly discounts: string;
  readonly cart: string;
  readonly server: string;
}

export interface DemoStats {
  readonly deployAt: string;
  readonly checkoutsLast5m: number;
  readonly failedLast5m: number;
  /** Percent of checkouts in the last 5 minutes that failed with a 5xx, one decimal. */
  readonly errorRate: number;
  readonly failedSinceDeploy: number;
}

export interface DemoProduction {
  /** `logs/checkout.log`. */
  readonly log: string;
  /** `deploys/HISTORY.md`. */
  readonly history: string;
  readonly stats: DemoStats;
}

const MINUTE = 60_000;
const WINDOW_MS = 90 * MINUTE;
/** The bad deploy went out this long before the alert fired. */
const DEPLOY_BEFORE_MS = 9 * MINUTE + 17_000;

/** mulberry32: small, fast, and good enough for believable logs. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** `file:line:column` of the first line containing `needle`, pointing at `at` within it. */
function position(source: string, file: string, needle: string, at: string = needle): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) return `file:///srv/checkout/${file}`;
  return `file:///srv/checkout/${file}:${index + 1}:${lines[index]!.indexOf(at) + 1}`;
}

const stamp = (ms: number): string => new Date(ms).toISOString();

/** Logs and deploy history for one simulated incident. */
export function demoProduction(sources: DemoSources, demo: DemoSeed): DemoProduction {
  const rand = random(demo.seed);
  const end = Date.parse(demo.at);
  const start = end - WINDOW_MS;
  const deployAt = end - DEPLOY_BEFORE_MS;
  const hex = () => Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0");
  const stack = [
    `    at applyDiscount (${position(sources.discounts, "src/discounts.js", "coupon.percent", "percent")})`,
    `    at priceCart (${position(sources.cart, "src/cart.js", "applyDiscount(before")})`,
    `    at handleCheckout (${position(sources.server, "src/server.js", "priceCart(cart)")})`,
  ];
  const events: { at: number; text: string }[] = [];
  const add = (at: number, text: string) => events.push({ at, text: `${stamp(at)} ${text}` });

  for (let at = start + 20_000; at < end; at += MINUTE) add(at, "level=info msg=request req=health method=GET path=/health status=200 duration_ms=1");
  add(deployAt - 2_400, 'level=info msg="shutting down" version=1.4.1');
  add(deployAt, 'level=info msg="starting checkout-service" version=1.4.2 commit=a1c9e3f port=8080');
  // An unrelated payment-provider blip long before the deploy: noise the triage should rule out.
  const blip = start + 31 * MINUTE + 12_000;
  for (const offset of [0, 2_100]) add(blip + offset, `level=error msg="payment provider error" provider=acmepay status=502 req=${hex()} retry=1`);

  let checkoutsLast5m = 0;
  let failedLast5m = 0;
  let failedSinceDeploy = 0;
  for (let at = start + 3_000; at < end; at += 1_500 + rand() * 3_500) {
    const roll = rand();
    const coupon = roll < 0.13 ? "SUMMER24" : roll < 0.15 ? "SPRING25" : roll < 0.32 ? "WELCOME10" : roll < 0.4 ? "LOYAL15" : roll < 0.41 ? "BLACKFRIDAY" : "none";
    const items = 1 + Math.floor(rand() * 4);
    const id = hex();
    const recent = at >= end - 5 * MINUTE;
    if (recent) checkoutsLast5m++;
    const common = `req=${id} method=POST path=/checkout`;
    if (coupon === "BLACKFRIDAY") {
      add(at, `level=warn msg="request rejected" ${common} status=400 duration_ms=${3 + Math.floor(rand() * 5)} items=${items} coupon=${coupon} error="CheckoutError: Unknown coupon ${coupon}."`);
    } else if ((coupon === "SUMMER24" || coupon === "SPRING25") && at >= deployAt) {
      failedSinceDeploy++;
      if (recent) failedLast5m++;
      add(
        at,
        `level=error msg="request failed" ${common} status=500 duration_ms=${6 + Math.floor(rand() * 9)} items=${items} coupon=${coupon} error="TypeError: Cannot read properties of undefined (reading 'percent')"\n${stack.join("\n")}`,
      );
    } else {
      add(at, `level=info msg=request ${common} status=200 duration_ms=${38 + Math.floor(rand() * 130)} items=${items} coupon=${coupon}`);
    }
    if (rand() < 0.02) add(at + 300, `level=warn msg="payment provider slow" provider=acmepay req=${id} duration_ms=${1_200 + Math.floor(rand() * 1_400)}`);
  }
  events.sort((a, b) => a.at - b.at);

  const day = (ms: number) => stamp(ms).replace("T", " ").slice(0, 19);
  const history = [
    "# Deploys: checkout-service (production)",
    "",
    "| When (UTC) | Version | Commit | Change |",
    "| --- | --- | --- | --- |",
    `| ${day(deployAt)} | v1.4.2 | a1c9e3f | Move the coupon expiry check into findCoupon (#482) |`,
    `| ${day(deployAt - 11 * 60 * MINUTE - 7 * MINUTE)} | v1.4.1 | 77b02d4 | Show savings on the receipt (#479) |`,
    `| ${day(deployAt - 37 * 60 * MINUTE - 31 * MINUTE)} | v1.4.0 | e5d1c08 | Free shipping from $50 (#471) |`,
    "",
    "What v1.4.2 changed: deploys/v1.4.2.diff",
    "",
  ].join("\n");

  return {
    log: `${events.map((event) => event.text).join("\n")}\n`,
    history,
    stats: {
      deployAt: stamp(deployAt),
      checkoutsLast5m,
      failedLast5m,
      errorRate: checkoutsLast5m === 0 ? 0 : Math.round((failedLast5m / checkoutsLast5m) * 1_000) / 10,
      failedSinceDeploy,
    },
  };
}

/** The Alertmanager notification "Simulate an incident" sends: the shape a real Alertmanager or Grafana posts. */
export function sampleNotification(stats: DemoStats, demo: DemoSeed, fingerprint: string): Record<string, unknown> {
  const labels = { alertname: "CheckoutHighErrorRate", service: DEMO_SERVICE, severity: "major", env: "production", team: "storefront" };
  const annotations = {
    summary: `Checkout 5xx error rate is ${stats.errorRate}% (threshold 2%)`,
    description: `${stats.failedLast5m} of ${stats.checkoutsLast5m} checkouts failed in the last 5 minutes.`,
    runbook_url: "https://runbooks.example.com/storefront/checkout-errors",
  };
  return {
    version: "4",
    status: "firing",
    receiver: "incident-commander",
    groupKey: `{}:{alertname="CheckoutHighErrorRate"}`,
    groupLabels: { alertname: labels.alertname },
    commonLabels: labels,
    commonAnnotations: annotations,
    externalURL: "https://alertmanager.example.com",
    alerts: [
      {
        status: "firing",
        labels,
        annotations,
        startsAt: new Date(Date.parse(demo.at) - 3 * MINUTE).toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "https://prometheus.example.com/graph?g0.expr=checkout_5xx_ratio%3E0.02",
        fingerprint,
      },
    ],
  };
}
