/**
 * Seed data for the demo workspace: a realistic inbox and two weeks of calendar, generated relative to "now" in the
 * person's time zone. All people and companies are fictional and use reserved example domains (RFC 2606).
 */
import { addDays, atTime, formatLong, zonedParts } from "../../time.js";

export interface SeedMail {
  readonly id: string;
  readonly threadId: string;
  readonly folder: "inbox" | "sent" | "drafts";
  readonly fromName: string;
  readonly fromEmail: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly date: Date;
  readonly unread: boolean;
  readonly important: boolean;
  readonly labels: readonly string[];
}

export interface SeedEvent {
  readonly id: string;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  readonly location?: string;
  readonly description?: string;
  readonly attendees: readonly string[];
  readonly organizer?: string;
}

export interface SeedOwner {
  readonly name: string;
  readonly address: string;
}

const PEOPLE = {
  sam: { name: "Sam Rivera", email: "sam.rivera@contoso.example" },
  priya: { name: "Priya Natarajan", email: "priya.natarajan@contoso.example" },
  morgan: { name: "Morgan Patel", email: "morgan.patel@contoso.example" },
  taylor: { name: "Taylor Kim", email: "taylor.kim@fabrikam.example" },
  jordan: { name: "Jordan Lee", email: "jordan.lee@example.com" },
  alex: { name: "Alex Chen", email: "alex.chen@example.org" },
} as const;

/** The upcoming interview's candidate (fictional). The GitHub handle is GitHub's own public demo account. */
export const CANDIDATE = { name: "Robin Okafor", github: "@octocat" } as const;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

/** Next `count` weekdays after the day containing `from` (local midnight instants). */
function nextBusinessDays(from: Date, count: number, timeZone: string): Date[] {
  const days: Date[] = [];
  for (let offset = 1; days.length < count && offset < 30; offset++) {
    const day = addDays(from, offset, timeZone);
    const weekday = zonedParts(day, timeZone).weekday;
    if (weekday !== 0 && weekday !== 6) days.push(day);
  }
  return days;
}

/** The next occurrence of `weekday` strictly after the current week (0 = Sunday). */
function nextWeekday(from: Date, weekday: number, timeZone: string, minDaysAhead: number): Date {
  for (let offset = minDaysAhead; offset < minDaysAhead + 8; offset++) {
    const day = addDays(from, offset, timeZone);
    if (zonedParts(day, timeZone).weekday === weekday) return day;
  }
  return addDays(from, minDaysAhead, timeZone);
}

export function seedWorkspace(now: Date, timeZone: string, owner: SeedOwner): { mail: SeedMail[]; events: SeedEvent[] } {
  const me = owner.address;
  const hi = `Hi ${firstName(owner.name)},`;
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const daysAgoAt = (days: number, hour: number, minute = 0) => atTime(addDays(now, -days, timeZone), hour, minute, timeZone);

  const business = nextBusinessDays(now, 4, timeZone);
  const [b1, b2, b3, b4] = business as [Date, Date, Date, Date];
  const flightDay = nextWeekday(now, 4, timeZone, 5);
  const dentistDay = nextWeekday(now, 2, timeZone, 3);
  const enrollmentClose = nextWeekday(now, 5, timeZone, 1);
  const invoiceDue = addDays(now, 5, timeZone);
  const flightDeparture = atTime(flightDay, 7, 15, timeZone);

  let mailSeq = 0;
  const mail = (entry: Omit<SeedMail, "id" | "threadId" | "cc" | "labels" | "folder"> & Partial<Pick<SeedMail, "threadId" | "cc" | "labels" | "folder">>): SeedMail => {
    const id = `msg_${String(++mailSeq).padStart(3, "0")}`;
    return { folder: "inbox", cc: [], labels: [], threadId: `thr_${id.slice(4)}`, ...entry, id };
  };

  const mails: SeedMail[] = [
    mail({
      fromName: PEOPLE.taylor.name,
      fromEmail: PEOPLE.taylor.email,
      to: [me],
      subject: "Urgent: intermittent checkout errors since your last release",
      body: `${hi}\n\nSince your team's last release, our checkout flow has been failing for roughly 3% of requests with 502 errors from your payments API. We rolled back our own gateway config, but the errors persist.\n\nCould we get your on-call engineer and someone from your team on a call in the next day or two? My afternoons are mostly open.\n\nThanks,\nTaylor Kim\nDirector of Engineering, Fabrikam`,
      date: minutesAgo(25),
      unread: true,
      important: true,
      labels: ["Customers"],
    }),
    mail({
      fromName: PEOPLE.sam.name,
      fromEmail: PEOPLE.sam.email,
      to: [me],
      subject: "Q3 launch plan: can we find 30 minutes?",
      body: `${hi}\n\nI've pulled together the draft Q3 launch plan: timeline, pricing, and the beta cohort. Could we find 30 minutes in the next few days to walk through it? I'm flexible, but mornings work best for me.\n\nThanks!\nSam`,
      date: minutesAgo(130),
      unread: true,
      important: true,
    }),
    mail({
      fromName: PEOPLE.priya.name,
      fromEmail: PEOPLE.priya.email,
      to: [me],
      subject: "Board deck: comments by Thursday",
      body: `${hi}\n\nThe board deck is in the shared folder. Could you review the product section (slides 8–14) and leave comments by end of day Thursday? The adoption chart on slide 11 is the one I most want your eyes on.\n\nThanks,\nPriya`,
      date: minutesAgo(5 * 60 + 10),
      unread: true,
      important: true,
    }),
    mail({
      fromName: "Build Bot",
      fromEmail: "ci@builds.contoso.example",
      to: [me],
      subject: "Nightly build failed: main #1842",
      body: "The nightly build for main failed at step \"integration-tests\".\n\n3 tests failed in checkout-service:\n- payments_retry_on_timeout\n- payments_idempotency_replay\n- cart_total_rounding\n\nView logs: https://builds.contoso.example/runs/1842",
      date: minutesAgo(9 * 60),
      unread: true,
      important: false,
      labels: ["Notifications"],
    }),
    mail({
      fromName: PEOPLE.jordan.name,
      fromEmail: PEOPLE.jordan.email,
      to: [me],
      subject: "Dinner Saturday?",
      body: "Hey!\n\nAre you free for dinner Saturday? I was thinking the new ramen place on 5th, around 7. Let me know!\n\nJ",
      date: daysAgoAt(1, 19, 42),
      unread: true,
      important: false,
      labels: ["Personal"],
    }),
    mail({
      fromName: "Contoso People Team",
      fromEmail: "people@contoso.example",
      to: [me],
      subject: "Reminder: benefits open enrollment closes Friday",
      body: `${hi}\n\nOpen enrollment for next year's benefits closes on ${formatLong(atTime(enrollmentClose, 17, 0, timeZone), timeZone)}. If you don't make a selection, your current elections roll over, except the health savings account, which must be re-elected.\n\nThe People Team`,
      date: daysAgoAt(1, 10, 5),
      unread: true,
      important: true,
    }),
    mail({
      fromName: PEOPLE.morgan.name,
      fromEmail: PEOPLE.morgan.email,
      to: [me],
      cc: [PEOPLE.sam.email],
      subject: "Onboarding mocks: round 2",
      body: `Hey!\n\nRound 2 of the onboarding mocks is up. The biggest change is the new setup checklist on the welcome screen, which replaces the three-step carousel. Would love your thoughts before the design review.\n\nMorgan`,
      date: daysAgoAt(1, 14, 30),
      unread: false,
      important: false,
    }),
    mail({
      fromName: "The Weekly Byte",
      fromEmail: "newsletter@weeklybyte.example",
      to: [me],
      subject: "This week: agents that keep working while you sleep",
      body: "In this issue: scheduling background agents, why approvals still matter, and five tips for safer email automation.\n\nYou're receiving this because you subscribed to The Weekly Byte.",
      date: daysAgoAt(1, 6, 0),
      unread: true,
      important: false,
      labels: ["Newsletters"],
    }),
    mail({
      fromName: "Northwind Air",
      fromEmail: "reservations@northwind-air.example",
      to: [me],
      subject: "Your trip to Seattle: confirmation NWA4K2",
      body: `Thanks for flying Northwind Air.\n\nFlight NW 482 · San Francisco (SFO) → Seattle (SEA)\nDeparts ${formatLong(flightDeparture, timeZone)}\nSeat 14C · Confirmation NWA4K2\n\nCheck-in opens 24 hours before departure.`,
      date: daysAgoAt(2, 16, 12),
      unread: false,
      important: false,
      labels: ["Travel"],
    }),
    mail({
      fromName: PEOPLE.alex.name,
      fromEmail: PEOPLE.alex.email,
      to: [me],
      subject: "Coffee next week?",
      body: `${hi}\n\nIt's been a while! I'll be near your office next week. Any chance you're free for coffee one morning?\n\nAlex`,
      date: daysAgoAt(3, 11, 20),
      unread: false,
      important: false,
      labels: ["Personal"],
    }),
    mail({
      fromName: "Bright Smile Dental",
      fromEmail: "appointments@brightsmile.example",
      to: [me],
      subject: "Appointment reminder",
      body: `This is a reminder of your cleaning appointment on ${formatLong(atTime(dentistDay, 10, 0, timeZone), timeZone)}.\n\nReply C to confirm or call us to reschedule.`,
      date: daysAgoAt(3, 9, 0),
      unread: false,
      important: false,
    }),
    mail({
      fromName: "Contoso Cloud Billing",
      fromEmail: "billing@contoso-cloud.example",
      to: [me],
      subject: "Invoice INV-20481 is due in 5 days",
      body: `Your invoice INV-20481 for $1,240.00 is due on ${formatLong(atTime(invoiceDue, 23, 59, timeZone), timeZone)}.\n\nPay online at https://billing.contoso-cloud.example/invoices/INV-20481`,
      date: daysAgoAt(4, 8, 30),
      unread: false,
      important: true,
      labels: ["Finance"],
    }),
    mail({
      fromName: PEOPLE.sam.name,
      fromEmail: PEOPLE.sam.email,
      to: [me],
      subject: "Beta cohort shortlist",
      body: "Here's the shortlist of 12 design partners for the beta. I flagged the three I think we should invite first.\n\nSam",
      date: daysAgoAt(4, 15, 45),
      unread: false,
      important: false,
    }),
    mail({
      folder: "sent",
      fromName: owner.name,
      fromEmail: me,
      to: [PEOPLE.priya.email],
      subject: "Re: Q2 retro notes",
      body: "Thanks Priya, I added two action items about release checklists. Happy to own the first one.",
      date: daysAgoAt(2, 17, 5),
      unread: false,
      important: false,
    }),
  ];

  let eventSeq = 0;
  const event = (entry: Omit<SeedEvent, "id" | "allDay" | "attendees"> & Partial<Pick<SeedEvent, "allDay" | "attendees">>): SeedEvent => ({
    allDay: false,
    attendees: [],
    organizer: me,
    ...entry,
    id: `evt_${String(++eventSeq).padStart(3, "0")}`,
  });
  const at = (day: Date, hour: number, minute = 0) => atTime(day, hour, minute, timeZone);

  const events: SeedEvent[] = [];
  const today = addDays(now, 0, timeZone);
  const todayIsWeekend = [0, 6].includes(zonedParts(today, timeZone).weekday);

  for (let offset = 0; offset < 14; offset++) {
    const day = addDays(now, offset, timeZone);
    const weekday = zonedParts(day, timeZone).weekday;
    if (weekday === 0 || weekday === 6) continue;
    events.push(event({ title: "Team standup", start: at(day, 9, 30), end: at(day, 9, 45), location: "Video call", attendees: [PEOPLE.sam.email, PEOPLE.morgan.email], organizer: PEOPLE.priya.email }));
  }

  if (todayIsWeekend) {
    events.push(event({ title: "Farmers market", start: at(today, 10, 0), end: at(today, 11, 0), location: "Civic Center Plaza" }));
    events.push(event({ title: "Call with Mom", start: at(today, 17, 0), end: at(today, 17, 30) }));
  } else {
    events.push(event({ title: "1:1 with Priya", start: at(today, 11, 0), end: at(today, 11, 30), attendees: [PEOPLE.priya.email], organizer: PEOPLE.priya.email }));
    events.push(event({ title: "Lunch & learn: background agents", start: at(today, 12, 30), end: at(today, 13, 30), location: "Room 4.2" }));
    events.push(event({ title: "Focus: board deck review", start: at(today, 15, 30), end: at(today, 16, 30), description: "Blocked to review slides 8-14 for Priya." }));
  }

  events.push(
    event({ title: "Design review: onboarding", start: at(b1, 10, 0), end: at(b1, 11, 0), location: "Room 2.1", attendees: [PEOPLE.morgan.email, PEOPLE.sam.email], organizer: PEOPLE.morgan.email }),
    event({
      title: "Interview: Senior Backend Engineer",
      start: at(b1, 14, 0),
      end: at(b1, 14, 45),
      location: "Video call",
      attendees: [PEOPLE.morgan.email],
      description: `Candidate: ${CANDIDATE.name} (GitHub: ${CANDIDATE.github}). Panel: you and Morgan. Focus: distributed systems and API design. Resume and scorecard are in the recruiting portal.`,
    }),
    event({ title: "Customer call: Fabrikam", start: at(b2, 13, 0), end: at(b2, 14, 0), location: "Video call", attendees: [PEOPLE.taylor.email], organizer: PEOPLE.taylor.email }),
    event({ title: "Sprint planning", start: at(b2, 15, 0), end: at(b2, 16, 0), attendees: [PEOPLE.sam.email, PEOPLE.morgan.email] }),
    event({ title: "Roadmap sync", start: at(b3, 11, 0), end: at(b3, 12, 0), attendees: [PEOPLE.priya.email, PEOPLE.sam.email], organizer: PEOPLE.priya.email }),
    event({ title: "Expense report", start: at(b4, 16, 0), end: at(b4, 16, 30) }),
    event({ title: "Dentist: cleaning", start: at(dentistDay, 10, 0), end: at(dentistDay, 11, 0), location: "Bright Smile Dental" }),
    event({ title: "Flight NW 482 to Seattle", start: flightDeparture, end: at(flightDay, 9, 20), location: "SFO Terminal 2", description: "Confirmation NWA4K2 · Seat 14C" }),
  );

  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { mail: mails, events: [...pastMeetings(now, timeZone, event), ...events] };
}

/**
 * The last four weeks of meetings, so questions about meeting load have history to work with. Each week (the seven
 * days ending yesterday, the seven before, ...) has the same recurring meetings (9 hours); hiring adds interviews and
 * debriefs: none four weeks ago, then one, three, and five, plus a hiring sync last week (9, 10, 12, and 15 hours).
 */
function pastMeetings(now: Date, timeZone: string, event: (entry: Omit<SeedEvent, "id" | "allDay" | "attendees"> & Partial<Pick<SeedEvent, "attendees">>) => SeedEvent): SeedEvent[] {
  const at = (day: Date, hour: number, minute = 0) => atTime(day, hour, minute, timeZone);
  const team = [PEOPLE.sam.email, PEOPLE.morgan.email];
  const interviewsPerWeek = [5, 3, 1, 0];
  const roles = ["Senior Backend Engineer", "Frontend Engineer", "Product Designer", "Senior Backend Engineer", "Site Reliability Engineer"];
  const meetings: SeedEvent[] = [];
  for (let week = 0; week < 4; week++) {
    // The weekdays among days 1-7 (week 0), 8-14 (week 1), ... before today, oldest first.
    const weekdays: Date[] = [];
    for (let daysAgo = week * 7 + 7; daysAgo > week * 7; daysAgo--) {
      const day = addDays(now, -daysAgo, timeZone);
      const weekday = zonedParts(day, timeZone).weekday;
      if (weekday !== 0 && weekday !== 6) weekdays.push(day);
    }
    for (const day of weekdays) {
      const weekday = zonedParts(day, timeZone).weekday;
      meetings.push(event({ title: "Team standup", start: at(day, 9, 30), end: at(day, 9, 45), location: "Video call", attendees: team, organizer: PEOPLE.priya.email }));
      switch (weekday) {
        case 1:
          meetings.push(event({ title: "Weekly planning", start: at(day, 10, 0), end: at(day, 11, 0), attendees: team }));
          break;
        case 2:
          meetings.push(event({ title: "1:1 with Priya", start: at(day, 11, 0), end: at(day, 11, 30), attendees: [PEOPLE.priya.email], organizer: PEOPLE.priya.email }));
          meetings.push(event({ title: "Customer call: Fabrikam", start: at(day, 13, 0), end: at(day, 14, 0), location: "Video call", attendees: [PEOPLE.taylor.email], organizer: PEOPLE.taylor.email }));
          break;
        case 3:
          meetings.push(event({ title: "Roadmap sync", start: at(day, 11, 0), end: at(day, 12, 0), attendees: [PEOPLE.priya.email, PEOPLE.sam.email], organizer: PEOPLE.priya.email }));
          meetings.push(event({ title: "Sprint planning", start: at(day, 15, 0), end: at(day, 16, 0), attendees: team }));
          break;
        case 4:
          meetings.push(event({ title: "Design review", start: at(day, 10, 0), end: at(day, 11, 0), location: "Room 2.1", attendees: team, organizer: PEOPLE.morgan.email }));
          meetings.push(event({ title: "Architecture office hours", start: at(day, 14, 0), end: at(day, 15, 15), location: "Room 4.2" }));
          break;
        case 5:
          meetings.push(event({ title: "Demo day", start: at(day, 15, 0), end: at(day, 16, 0), attendees: team }));
          break;
      }
    }
    // Interviews (45 minutes) with a 15-minute debrief, on different days late in the afternoon.
    const order = [1, 3, 0, 2, 4];
    for (let index = 0; index < interviewsPerWeek[week]!; index++) {
      const day = weekdays[order[index]! % weekdays.length]!;
      const role = roles[(week * 2 + index) % roles.length]!;
      meetings.push(event({ title: `Interview: ${role}`, start: at(day, 16, 15), end: at(day, 17, 0), location: "Video call", attendees: [PEOPLE.morgan.email] }));
      meetings.push(event({ title: "Interview debrief", start: at(day, 17, 0), end: at(day, 17, 15), attendees: [PEOPLE.morgan.email], organizer: PEOPLE.morgan.email }));
    }
    if (week === 0) meetings.push(event({ title: "Hiring sync", start: at(weekdays[0]!, 14, 0), end: at(weekdays[0]!, 15, 0), attendees: [PEOPLE.priya.email, PEOPLE.morgan.email], organizer: PEOPLE.priya.email }));
  }
  return meetings.sort((a, b) => a.start.getTime() - b.start.getTime());
}
