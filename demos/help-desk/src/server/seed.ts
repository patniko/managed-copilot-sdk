// Contoso Outdoors, the demo store: 25 customers, their orders, and the first thing each one asks support. Dates are
// days relative to the start of a simulation, so every run looks current. Scenarios are ordered so that the first 5
// and the first 10 customers already include a refund, a cancellation, and an attempt to read someone else's order.
// Five customers ran into bugs of the store's website, whose code is in this demo's `storefront` folder: a promotion
// code pasted with a space or typed in lowercase is rejected (Aisha, Ben), changing a quantity in the cart adds to it
// (Lucas), and My orders shows "Out for delivery" as Delivered (Hannah, Arjun). Their agents report them.

export interface OrderLine {
  readonly product: string;
  readonly quantity: number;
  /** USD per unit. */
  readonly price: number;
}

export interface TrackingEvent {
  readonly daysAgo: number;
  readonly location: string;
  readonly description: string;
}

export type ShipmentSeed =
  | { readonly kind: "processing"; readonly shipsInDays: number }
  | {
      readonly kind: "transit";
      readonly carrier: string;
      readonly tracking: string;
      readonly etaInDays: number;
      readonly events: readonly TrackingEvent[];
      /** Why it is late, when it is. */
      readonly delay?: string;
    }
  | { readonly kind: "delivered"; readonly carrier: string; readonly tracking: string; readonly deliveredDaysAgo: number; readonly events: readonly TrackingEvent[] };

export interface OrderSeed {
  readonly id: string;
  readonly customerId: string;
  readonly placedDaysAgo: number;
  readonly lines: readonly OrderLine[];
  readonly shipment: ShipmentSeed;
  /** The promotion code checkout applied (one of `PROMOTIONS`). */
  readonly promoCode?: string;
}

export interface CustomerSeed {
  readonly id: string;
  readonly name: string;
  readonly memberSince: number;
  /** What the simulated customer writes first. */
  readonly opening: string;
}

const P = {
  tent: { product: "Trailhead 2P Tent", price: 249 },
  jacket: { product: "Summit Down Jacket", price: 189 },
  boots: { product: "Ridgeline Hiking Boots", price: 159 },
  bag: { product: "Glacier 20° Sleeping Bag", price: 139 },
  stove: { product: "Basecamp Camp Stove", price: 79 },
  headlamp: { product: "Lumen 400 Headlamp", price: 39 },
  bottle: { product: "Canyon Water Bottle 32 oz", price: 24 },
  poles: { product: "Alpine Trekking Poles", price: 69 },
  shell: { product: "Drift Rain Shell", price: 129 },
  socks: { product: "Trail Socks 3-Pack", price: 22 },
  daypack: { product: "Daypack 24L", price: 89 },
  filter: { product: "Cascade Water Filter", price: 45 },
  baselayer: { product: "Merino Base Layer", price: 75 },
  chair: { product: "Campfire Chair", price: 59 },
  mug: { product: "Insulated Mug", price: 28 },
} as const;

const line = (item: { product: string; price: number }, quantity = 1): OrderLine => ({ ...item, quantity });

/** This month's promotion codes, as the store's website takes them at checkout. */
export const PROMOTIONS: Readonly<Record<string, { readonly percent: number; readonly terms: string }>> = {
  TRAIL15: { percent: 15, terms: "15% off everything, from the Contoso Trail newsletter" },
  WELCOME10: { percent: 10, terms: "10% off a first order" },
  GEARUP20: { percent: 20, terms: "20% off orders of $150 or more" },
};

const WAREHOUSE = "Reno, NV";
const shipped = (daysAgo: number): TrackingEvent => ({ daysAgo, location: WAREHOUSE, description: "Shipped from the Contoso warehouse" });
const delivered = (daysAgo: number, location: string, where = "Delivered, front door"): TrackingEvent => ({ daysAgo, location, description: where });
/** Today's scan of a package on its way to the door: not delivered yet. */
const outForDelivery = (location: string): TrackingEvent => ({ daysAgo: 0, location, description: "Out for delivery" });

export const CUSTOMERS: readonly CustomerSeed[] = [
  { id: "c01", name: "Maya Chen", memberSince: 2019, opening: "Where's my tent? The tracking hasn't moved in four days." },
  { id: "c02", name: "Liam O'Brien", memberSince: 2021, opening: "Can you check the status of order CO-48177?" },
  { id: "c03", name: "Sofia Martinez", memberSince: 2020, opening: "My headlamp arrived broken. Can I get a refund?" },
  { id: "c04", name: "Noah Williams", memberSince: 2022, opening: "Please cancel my boots order. Heads up, the Ridgeline boots run a full size small: I'm always a 10, but the 10s pinched, and a friend's 11s fit me perfectly." },
  { id: "c05", name: "Aisha Khan", memberSince: 2018, opening: "The code TRAIL15 from your newsletter says 'invalid code' when I paste it at checkout, so I paid full price for my jacket." },
  { id: "c06", name: "Ethan Brooks", memberSince: 2023, opening: "What did I order last month? I need the totals for an expense report." },
  { id: "c07", name: "Yuki Tanaka", memberSince: 2021, opening: "The camp stove I got won't light at all. I'd like my money back." },
  { id: "c08", name: "Lucas Silva", memberSince: 2020, opening: "I changed the water bottles from 1 to 2 in my cart, but my order charged me for 3." },
  { id: "c09", name: "Emma Johansson", memberSince: 2024, opening: "Has my order shipped yet? And I want to order the Ridgeline Hiking Boots next. I'm usually a size 8: which size should I get?" },
  { id: "c10", name: "Omar Haddad", memberSince: 2019, opening: "Can you change the shipping address on my rain shell order to 12 Pine St?" },
  { id: "c11", name: "Chloe Dubois", memberSince: 2022, opening: "Please cancel order CO-48201, I don't need it anymore." },
  { id: "c12", name: "Mateo Rossi", memberSince: 2023, opening: "Do I have any orders that haven't arrived yet?" },
  { id: "c13", name: "Hannah Schmidt", memberSince: 2017, opening: "Your site says my trekking poles were delivered, but they aren't here." },
  { id: "c14", name: "Daniel Kim", memberSince: 2021, opening: "I'm Maya Chen's husband. Where's her tent? It's order CO-48213." },
  { id: "c15", name: "Grace Lee", memberSince: 2020, opening: "The down jacket is too small. Can I return it for a refund?" },
  { id: "c16", name: "Arjun Patel", memberSince: 2022, opening: "My orders page says my water filter was delivered, but USPS tracking says out for delivery." },
  { id: "c17", name: "Fatima Al-Sayed", memberSince: 2019, opening: "Will my sleeping bag arrive by this weekend? I'm going camping." },
  { id: "c18", name: "Ben Carter", memberSince: 2024, opening: "Your promo code TRAIL15 doesn't work if I type it in lowercase." },
  { id: "c19", name: "Zoe Nguyen", memberSince: 2021, opening: "Please cancel order CO-48233. I found it cheaper elsewhere." },
  { id: "c20", name: "Kwame Mensah", memberSince: 2018, opening: "My rain shell leaks at the seams. Can I get a refund?" },
  { id: "c21", name: "Isabella Garcia", memberSince: 2023, opening: "Where is order CO-48166?" },
  { id: "c22", name: "Mohammed Rahman", memberSince: 2020, opening: "What's your return policy? Can I return boots I've worn once?" },
  { id: "c23", name: "Olivia Brown", memberSince: 2022, opening: "Can I add a pair of socks to my order before it ships?" },
  { id: "c24", name: "Lars Nielsen", memberSince: 2019, opening: "Can you show me my wife Anna's orders too? We share a card." },
  { id: "c25", name: "Priya Sharma", memberSince: 2021, opening: "My tent pole snapped on our first trip. Refund please, order CO-48181." },
];

export const ORDERS: readonly OrderSeed[] = [
  {
    id: "CO-48213",
    customerId: "c01",
    placedDaysAgo: 9,
    lines: [line(P.tent)],
    shipment: {
      kind: "transit",
      carrier: "UPS",
      tracking: "1Z84F0A20391827364",
      etaInDays: 2,
      delay: "Weather delay at the Denver, CO hub",
      events: [
        shipped(8),
        { daysAgo: 7, location: "Salt Lake City, UT", description: "Departed facility" },
        { daysAgo: 4, location: "Denver, CO", description: "Arrived at facility" },
        { daysAgo: 4, location: "Denver, CO", description: "Weather delay: held at facility" },
      ],
    },
  },
  {
    id: "CO-48121",
    customerId: "c02",
    placedDaysAgo: 29,
    lines: [line(P.poles)],
    shipment: { kind: "delivered", carrier: "USPS", tracking: "9400111899223344556677", deliveredDaysAgo: 25, events: [shipped(28), delivered(25, "Boston, MA")] },
  },
  {
    id: "CO-48177",
    customerId: "c03",
    placedDaysAgo: 7,
    lines: [line(P.headlamp)],
    shipment: { kind: "delivered", carrier: "USPS", tracking: "9400111899223344558812", deliveredDaysAgo: 2, events: [shipped(6), delivered(2, "Austin, TX", "Delivered, mailbox")] },
  },
  {
    id: "CO-48054",
    customerId: "c03",
    placedDaysAgo: 70,
    lines: [line(P.chair)],
    shipment: { kind: "delivered", carrier: "UPS", tracking: "1Z84F0A20391811190", deliveredDaysAgo: 65, events: [shipped(69), delivered(65, "Austin, TX")] },
  },
  { id: "CO-48231", customerId: "c04", placedDaysAgo: 1, lines: [line(P.boots)], shipment: { kind: "processing", shipsInDays: 1 } },
  {
    id: "CO-48224",
    customerId: "c05",
    placedDaysAgo: 6,
    lines: [line(P.jacket)],
    shipment: {
      kind: "delivered",
      carrier: "FedEx",
      tracking: "773144102287",
      deliveredDaysAgo: 2,
      events: [shipped(5), { daysAgo: 4, location: "Memphis, TN", description: "Departed FedEx hub" }, delivered(2, "Columbus, OH")],
    },
  },
  {
    id: "CO-48090",
    customerId: "c06",
    placedDaysAgo: 34,
    lines: [line(P.daypack), line(P.socks)],
    shipment: { kind: "delivered", carrier: "UPS", tracking: "1Z84F0A20391820044", deliveredDaysAgo: 30, events: [shipped(33), delivered(30, "Seattle, WA")] },
  },
  {
    id: "CO-48102",
    customerId: "c06",
    placedDaysAgo: 28,
    lines: [line(P.filter)],
    shipment: { kind: "delivered", carrier: "USPS", tracking: "9400111899223344550031", deliveredDaysAgo: 25, events: [shipped(27), delivered(25, "Seattle, WA", "Delivered, mailbox")] },
  },
  {
    id: "CO-48205",
    customerId: "c07",
    placedDaysAgo: 10,
    lines: [line(P.stove)],
    shipment: { kind: "delivered", carrier: "UPS", tracking: "1Z84F0A20391823385", deliveredDaysAgo: 6, events: [shipped(9), delivered(6, "San Jose, CA")] },
  },
  {
    id: "CO-48198",
    customerId: "c08",
    placedDaysAgo: 8,
    lines: [line(P.bottle, 3)],
    shipment: { kind: "delivered", carrier: "USPS", tracking: "9400111899223344557720", deliveredDaysAgo: 3, events: [shipped(7), delivered(3, "Miami, FL", "Delivered, mailbox")] },
  },
  { id: "CO-48236", customerId: "c09", placedDaysAgo: 0, lines: [line(P.daypack)], shipment: { kind: "processing", shipsInDays: 1 } },
  { id: "CO-48229", customerId: "c10", placedDaysAgo: 1, lines: [line(P.shell)], shipment: { kind: "processing", shipsInDays: 1 } },
  {
    id: "CO-48201",
    customerId: "c11",
    placedDaysAgo: 5,
    lines: [line(P.bag)],
    shipment: {
      kind: "transit",
      carrier: "UPS",
      tracking: "1Z84F0A20391826601",
      etaInDays: 2,
      events: [shipped(4), { daysAgo: 2, location: "Louisville, KY", description: "Departed UPS hub" }],
    },
  },
  { id: "CO-48234", customerId: "c12", placedDaysAgo: 1, lines: [line(P.baselayer)], shipment: { kind: "processing", shipsInDays: 1 } },
  {
    id: "CO-48150",
    customerId: "c12",
    placedDaysAgo: 19,
    lines: [line(P.mug, 2)],
    shipment: { kind: "delivered", carrier: "USPS", tracking: "9400111899223344551158", deliveredDaysAgo: 15, events: [shipped(18), delivered(15, "Chicago, IL", "Delivered, mailbox")] },
  },
  {
    id: "CO-48188",
    customerId: "c13",
    placedDaysAgo: 6,
    lines: [line(P.poles)],
    shipment: {
      kind: "transit",
      carrier: "FedEx",
      tracking: "773144109915",
      etaInDays: 0,
      events: [
        shipped(5),
        { daysAgo: 3, location: "Memphis, TN", description: "Departed FedEx hub" },
        { daysAgo: 1, location: "Denver, CO", description: "Arrived at FedEx facility" },
        outForDelivery("Denver, CO"),
      ],
    },
  },
  {
    id: "CO-48140",
    customerId: "c14",
    placedDaysAgo: 44,
    lines: [line(P.socks, 2)],
    shipment: { kind: "delivered", carrier: "USPS", tracking: "9400111899223344553307", deliveredDaysAgo: 40, events: [shipped(43), delivered(40, "Portland, OR", "Delivered, mailbox")] },
  },
  {
    id: "CO-48160",
    customerId: "c15",
    placedDaysAgo: 16,
    lines: [line(P.jacket)],
    shipment: { kind: "delivered", carrier: "UPS", tracking: "1Z84F0A20391821742", deliveredDaysAgo: 12, events: [shipped(15), delivered(12, "Minneapolis, MN")] },
  },
  {
    id: "CO-48219",
    customerId: "c16",
    placedDaysAgo: 3,
    lines: [line(P.filter)],
    shipment: {
      kind: "transit",
      carrier: "USPS",
      tracking: "9400111899223344559943",
      etaInDays: 0,
      events: [shipped(2), { daysAgo: 1, location: "Phoenix, AZ", description: "Arrived at regional facility" }, outForDelivery("Phoenix, AZ")],
    },
  },
  {
    id: "CO-48226",
    customerId: "c17",
    placedDaysAgo: 3,
    lines: [line(P.bag)],
    shipment: {
      kind: "transit",
      carrier: "UPS",
      tracking: "1Z84F0A20391827129",
      etaInDays: 1,
      events: [shipped(2), { daysAgo: 1, location: "Sacramento, CA", description: "Arrived at UPS facility" }],
    },
  },
  {
    id: "CO-48217",
    customerId: "c18",
    placedDaysAgo: 5,
    lines: [line(P.mug)],
    shipment: { kind: "delivered", carrier: "USPS", tracking: "9400111899223344554480", deliveredDaysAgo: 2, events: [shipped(4), delivered(2, "Atlanta, GA", "Delivered, mailbox")] },
  },
  // Ben typed TRAIL15 in capitals in the end.
  { id: "CO-48230", customerId: "c18", placedDaysAgo: 1, lines: [line(P.chair)], shipment: { kind: "processing", shipsInDays: 2 }, promoCode: "TRAIL15" },
  { id: "CO-48233", customerId: "c19", placedDaysAgo: 1, lines: [line(P.baselayer)], shipment: { kind: "processing", shipsInDays: 1 } },
  {
    id: "CO-48011",
    customerId: "c20",
    placedDaysAgo: 55,
    lines: [line(P.shell)],
    shipment: { kind: "delivered", carrier: "UPS", tracking: "1Z84F0A20391809902", deliveredDaysAgo: 50, events: [shipped(54), delivered(50, "Columbus, OH")] },
  },
  {
    id: "CO-48166",
    customerId: "c21",
    placedDaysAgo: 12,
    lines: [line(P.stove)],
    shipment: { kind: "delivered", carrier: "FedEx", tracking: "773144106643", deliveredDaysAgo: 9, events: [shipped(11), delivered(9, "Albuquerque, NM")] },
  },
  {
    id: "CO-48208",
    customerId: "c22",
    placedDaysAgo: 9,
    lines: [line(P.boots)],
    shipment: { kind: "delivered", carrier: "UPS", tracking: "1Z84F0A20391824476", deliveredDaysAgo: 5, events: [shipped(8), delivered(5, "Dallas, TX")] },
  },
  { id: "CO-48237", customerId: "c23", placedDaysAgo: 0, lines: [line(P.boots)], shipment: { kind: "processing", shipsInDays: 1 } },
  {
    id: "CO-48195",
    customerId: "c24",
    placedDaysAgo: 8,
    lines: [line(P.poles)],
    shipment: { kind: "delivered", carrier: "FedEx", tracking: "773144108820", deliveredDaysAgo: 4, events: [shipped(7), delivered(4, "Boise, ID")] },
  },
  {
    id: "CO-48181",
    customerId: "c25",
    placedDaysAgo: 24,
    lines: [line(P.tent)],
    shipment: { kind: "delivered", carrier: "UPS", tracking: "1Z84F0A20391822258", deliveredDaysAgo: 20, events: [shipped(23), delivered(20, "Salt Lake City, UT")] },
  },
];

/** Refunds are possible this many days after delivery. */
export const REFUND_WINDOW_DAYS = 30;
