// Downhill's launch day, as Contoso Outdoors' support desk sees it: 25 players, their Downhill Shop orders, and the first
// thing each one asks support. Times are minutes before the start of a simulation, so every run looks current. Scenarios
// are ordered so that the first 5 and the first 10 players already include a refund, a cancellation, and an attempt to
// read someone else's order. Six players ran into bugs of the shop's checkout code, which is in this demo's `storefront`
// folder: a promotion code pasted with a space or typed in lowercase is rejected (Aisha, Mateo, Ben: the small pocket of
// discount-code complaints a known issue's answer matches), tapping Add to cart twice puts the same look in twice
// (Lucas), and My purchases shows an order still waiting to unlock as Unlocked (Hannah, Arjun). Their agents report
// them.

export interface OrderLine {
  /** The look, as the Downhill Shop names it. */
  readonly product: string;
  readonly sku: string;
  /** Who wears it: a rider's outfit fits that rider; a paint job goes on whichever bike they ride. */
  readonly fits: string;
  readonly quantity: number;
  /** USD per unit. */
  readonly price: number;
}

export interface PaymentEvent {
  readonly minutesAgo: number;
  readonly description: string;
}

export interface PaymentSeed {
  /** How the player paid, as receipts name it. */
  readonly method: string;
  /** What the payment provider reported, oldest first, worded its own way. My purchases labels the order from the latest. */
  readonly events: readonly PaymentEvent[];
  /** Still clearing: when it should, in words. The looks unlock once it has. */
  readonly clears?: string;
}

export interface OrderSeed {
  readonly id: string;
  readonly customerId: string;
  readonly placedMinutesAgo: number;
  readonly lines: readonly OrderLine[];
  readonly payment: PaymentSeed;
  /** The promotion code checkout applied (one of `PROMOTIONS`). */
  readonly promoCode?: string;
  /** Refunded in full this many minutes before the simulation started. */
  readonly refundedMinutesAgo?: number;
}

export interface CustomerSeed {
  readonly id: string;
  readonly name: string;
  readonly memberSince: number;
  /** What the simulated player writes first. */
  readonly opening: string;
}

/** The Downhill Shop's looks (`demos/downhill/src/shared/catalog.ts`). */
const P = {
  sunset: { product: "Sunset Jersey", sku: "rider-sunset", fits: "the Rider", price: 3.99 },
  glacier: { product: "Glacier Jersey", sku: "rider-glacier", fits: "the Rider", price: 2.99 },
  neonMona: { product: "Neon Mona", sku: "mona-neon", fits: "Mona", price: 4.99 },
  goldenMona: { product: "Golden Mona", sku: "mona-gold", fits: "Mona", price: 5.99 },
  stealth: { product: "Stealth Copilot", sku: "copilot-stealth", fits: "Copilot", price: 6.99 },
  ruby: { product: "Ruby Copilot", sku: "copilot-ruby", fits: "Copilot", price: 4.99 },
  lava: { product: "Lava Paint", sku: "bike-lava", fits: "any bike", price: 3.99 },
  aurora: { product: "Aurora Paint", sku: "bike-aurora", fits: "any bike", price: 5.99 },
} as const;

const line = (item: Omit<OrderLine, "quantity">, quantity = 1): OrderLine => ({ ...item, quantity });

/** The Downhill Shop's promotion codes, as its checkout takes them. */
export const PROMOTIONS: Readonly<Record<string, { readonly percent: number; readonly terms: string }>> = {
  TRAIL15: { percent: 15, terms: "15% off everything, from the Contoso Trail newsletter and the shop's launch-week banner" },
  WELCOME10: { percent: 10, terms: "10% off a first order" },
  SET20: { percent: 20, terms: "20% off orders of $10 or more" },
};

/** Paid at once: the payment cleared and the looks unlocked within seconds. */
const paid = (minutesAgo: number, method: string): PaymentSeed => ({
  method,
  events: [
    { minutesAgo, description: "Order placed" },
    { minutesAgo, description: `Payment captured: ${method}` },
    { minutesAgo, description: "Unlocked in Downhill" },
  ],
});
/** A PayPal eCheck: PayPal holds it until the bank pays, and says so. */
const eCheck = (minutesAgo: number): PaymentSeed => ({
  method: "PayPal eCheck",
  events: [
    { minutesAgo, description: "Order placed" },
    { minutesAgo, description: "eCheck payment pending" },
  ],
  clears: "3 to 5 business days",
});
/** A bank transfer: the bank's own wording, which mentions the unlock it's waiting for. */
const bankTransfer = (minutesAgo: number): PaymentSeed => ({
  method: "Bank transfer",
  events: [
    { minutesAgo, description: "Order placed" },
    { minutesAgo, description: "Waiting to unlock: bank transfer pending" },
  ],
  clears: "1 to 2 business days",
});

export const CUSTOMERS: readonly CustomerSeed[] = [
  { id: "c01", name: "Maya Chen", memberSince: 2019, opening: "I bought Golden Mona 40 minutes ago and she still isn't in my game. Where is she?" },
  { id: "c02", name: "Liam O'Brien", memberSince: 2021, opening: "Can you check the status of order DH-20417?" },
  { id: "c03", name: "Sofia Martinez", memberSince: 2020, opening: "I bought Ruby Copilot by mistake, I meant to get Stealth Copilot. Can I get a refund?" },
  { id: "c04", name: "Noah Williams", memberSince: 2022, opening: "Please cancel my Aurora Paint order, it's still pending and I changed my mind. Heads up, Downhill stuttered on my laptop until I turned off the Painterly filter in Settings; now it's smooth." },
  { id: "c05", name: "Aisha Khan", memberSince: 2018, opening: "The code TRAIL15 from your newsletter says 'Invalid code.' when I paste it at checkout, so I paid full price for Neon Mona." },
  { id: "c06", name: "Ethan Brooks", memberSince: 2023, opening: "What have I bought in the Downhill Shop so far today? I need the total." },
  { id: "c07", name: "Yuki Tanaka", memberSince: 2021, opening: "Lava Paint looks much darker on my bike than in the shop's preview. I'd like my money back." },
  { id: "c08", name: "Lucas Silva", memberSince: 2020, opening: "I double-tapped Add to cart on my phone and got charged twice for Stealth Copilot." },
  { id: "c09", name: "Emma Johansson", memberSince: 2024, opening: "Has my Sunset Jersey order gone through? And Downhill is really choppy on my laptop. Any tips?" },
  { id: "c10", name: "Omar Haddad", memberSince: 2019, opening: "I bought Golden Mona on my account, but it's for my brother. Can you move it to his account?" },
  { id: "c11", name: "Chloe Dubois", memberSince: 2022, opening: "Please cancel order DH-20471, I don't need it anymore." },
  { id: "c12", name: "Mateo Rossi", memberSince: 2023, opening: "Your shop's banner says to use trail15 for 15% off, but checkout keeps saying 'Invalid code.' I want to buy Neon Mona today. What am I doing wrong?" },
  { id: "c13", name: "Hannah Schmidt", memberSince: 2017, opening: "My purchases says Golden Mona is unlocked, but she isn't in my game." },
  { id: "c14", name: "Daniel Kim", memberSince: 2021, opening: "I'm Maya Chen's husband. Where's her Golden Mona? It's order DH-20652." },
  { id: "c15", name: "Grace Lee", memberSince: 2020, opening: "The Glacier Jersey is much paler than it looked in the preview. Can I get a refund?" },
  { id: "c16", name: "Arjun Patel", memberSince: 2022, opening: "My purchases says Aurora Paint is unlocked, but my receipt says the payment is pending and it isn't on my bike." },
  { id: "c17", name: "Fatima Al-Sayed", memberSince: 2019, opening: "My Stealth Copilot order still says pending. Will it unlock before my race tonight?" },
  { id: "c18", name: "Ben Carter", memberSince: 2024, opening: "Your promo code TRAIL15 doesn't work if I type it in lowercase." },
  { id: "c19", name: "Zoe Nguyen", memberSince: 2021, opening: "Please cancel order DH-20958. My little brother bought it on my phone." },
  { id: "c20", name: "Kwame Mensah", memberSince: 2018, opening: "I asked for a refund of Lava Paint earlier and haven't seen the money yet. Can you refund order DH-20255?" },
  { id: "c21", name: "Isabella Garcia", memberSince: 2023, opening: "I bought the Sunset Jersey for Mona, but she still looks the same. Where's order DH-20333?" },
  { id: "c22", name: "Mohammed Rahman", memberSince: 2020, opening: "My Xbox controller does nothing in Downhill. Do you support controllers?" },
  { id: "c23", name: "Olivia Brown", memberSince: 2022, opening: "Can I add Lava Paint to my pending Neon Mona order? I'd rather pay for both together." },
  { id: "c24", name: "Lars Nielsen", memberSince: 2019, opening: "Can you show me my daughter Anna's purchases too? She uses my card." },
  { id: "c25", name: "Priya Sharma", memberSince: 2021, opening: "My son bought three looks on my laptop without asking. Refund please, order DH-20777." },
];

export const ORDERS: readonly OrderSeed[] = [
  { id: "DH-20652", customerId: "c01", placedMinutesAgo: 41, lines: [line(P.goldenMona)], payment: eCheck(41) },
  { id: "DH-20388", customerId: "c02", placedMinutesAgo: 96, lines: [line(P.glacier)], payment: paid(96, "Visa ending 4242") },
  { id: "DH-20417", customerId: "c03", placedMinutesAgo: 88, lines: [line(P.ruby)], payment: paid(88, "Mastercard ending 5100") },
  { id: "DH-20911", customerId: "c04", placedMinutesAgo: 12, lines: [line(P.aurora)], payment: eCheck(12) },
  // Aisha paid full price: checkout turned down TRAIL15, pasted with a space.
  { id: "DH-20540", customerId: "c05", placedMinutesAgo: 63, lines: [line(P.neonMona)], payment: paid(63, "Visa ending 1881") },
  { id: "DH-20190", customerId: "c06", placedMinutesAgo: 151, lines: [line(P.stealth)], payment: paid(151, "PayPal") },
  { id: "DH-20604", customerId: "c06", placedMinutesAgo: 49, lines: [line(P.lava)], payment: paid(49, "PayPal"), promoCode: "TRAIL15" },
  { id: "DH-20302", customerId: "c07", placedMinutesAgo: 118, lines: [line(P.lava)], payment: paid(118, "Visa ending 3007") },
  // Lucas tapped Add to cart twice: the cart took the same look twice, and checkout charged for both.
  { id: "DH-20720", customerId: "c08", placedMinutesAgo: 34, lines: [line(P.stealth, 2)], payment: paid(34, "Apple Pay") },
  { id: "DH-20990", customerId: "c09", placedMinutesAgo: 6, lines: [line(P.sunset)], payment: paid(6, "Visa ending 7731") },
  { id: "DH-20835", customerId: "c10", placedMinutesAgo: 22, lines: [line(P.goldenMona)], payment: paid(22, "Mastercard ending 2294") },
  { id: "DH-20471", customerId: "c11", placedMinutesAgo: 74, lines: [line(P.ruby)], payment: paid(74, "PayPal") },
  { id: "DH-20160", customerId: "c12", placedMinutesAgo: 158, lines: [line(P.glacier)], payment: paid(158, "Visa ending 6604") },
  { id: "DH-20866", customerId: "c13", placedMinutesAgo: 19, lines: [line(P.goldenMona)], payment: bankTransfer(19) },
  { id: "DH-20120", customerId: "c14", placedMinutesAgo: 165, lines: [line(P.neonMona)], payment: paid(165, "Visa ending 0459") },
  { id: "DH-20530", customerId: "c15", placedMinutesAgo: 66, lines: [line(P.glacier)], payment: paid(66, "Google Pay") },
  { id: "DH-20901", customerId: "c16", placedMinutesAgo: 14, lines: [line(P.aurora)], payment: bankTransfer(14) },
  { id: "DH-20944", customerId: "c17", placedMinutesAgo: 9, lines: [line(P.stealth)], payment: eCheck(9) },
  // Ben typed TRAIL15 in capitals in the end.
  { id: "DH-20802", customerId: "c18", placedMinutesAgo: 27, lines: [line(P.sunset)], payment: paid(27, "Visa ending 8120"), promoCode: "TRAIL15" },
  { id: "DH-20958", customerId: "c19", placedMinutesAgo: 8, lines: [line(P.goldenMona)], payment: eCheck(8) },
  {
    id: "DH-20255",
    customerId: "c20",
    placedMinutesAgo: 131,
    lines: [line(P.lava)],
    payment: { method: "Visa ending 5512", events: [...paid(131, "Visa ending 5512").events, { minutesAgo: 95, description: "Refunded to the original payment method" }] },
    refundedMinutesAgo: 95,
  },
  { id: "DH-20333", customerId: "c21", placedMinutesAgo: 104, lines: [line(P.sunset)], payment: paid(104, "Mastercard ending 3390") },
  { id: "DH-20077", customerId: "c22", placedMinutesAgo: 172, lines: [line(P.neonMona)], payment: paid(172, "PayPal") },
  { id: "DH-20937", customerId: "c23", placedMinutesAgo: 10, lines: [line(P.neonMona)], payment: eCheck(10), promoCode: "TRAIL15" },
  { id: "DH-20410", customerId: "c24", placedMinutesAgo: 90, lines: [line(P.aurora)], payment: paid(90, "Visa ending 2716") },
  { id: "DH-20777", customerId: "c25", placedMinutesAgo: 31, lines: [line(P.goldenMona), line(P.stealth), line(P.aurora)], payment: paid(31, "Visa ending 9043") },
];

/** Looks can be refunded this many days after purchase. */
export const REFUND_WINDOW_DAYS = 14;

/** How long a refund takes to reach the player. */
export const REFUND_ARRIVES_IN = "3 to 5 business days";
