// Team notes: a support team member writes to a ticket's agent, not to the customer. The note goes into the session as
// a user message wrapped in a `<team_note>` block that names its author, so the agent can tell it from the customer's
// words, and the projection shows it to the team only. Help Desk sends one too when it answers a known issue's matching
// tickets (`known_issue` names the issue). The session keeps it in its history, so a restart reads it back.

const BLOCK = "team_note";
/** The block's tags as someone might type them: they're defused, so only Help Desk's own block is ever read. */
const TAGS = new RegExp(`<(/?)(${BLOCK})`, "gi");
const NOTE = new RegExp(`<${BLOCK} author="([^"<>]*)"(?: known_issue="([A-Za-z0-9-]*)")?>\\n([\\s\\S]*)\\n</${BLOCK}>$`);

/** Who sends a known issue's update. */
export const HELP_DESK_AUTHOR = "Help Desk";

/** Someone's words with the block's tags defused: a customer or player can't write a team note. */
export function defuseTeamNotes(text: string): string {
  return text.replace(TAGS, "‹$1$2");
}

/** A team note as the session gets it. */
export function teamNotePrompt(text: string, author: string, knownIssueId?: string): string {
  const words = defuseTeamNotes(text);
  const by = author.replace(/["<>\n]/g, "").trim() || "a team member";
  const issue = knownIssueId ? ` known_issue="${knownIssueId.replace(/[^A-Za-z0-9-]/g, "")}"` : "";
  return `<${BLOCK} author="${by}"${issue}>\n${words}\n</${BLOCK}>`;
}

/** A team note's words, author, and known issue, if `content` is one. */
export function readTeamNote(content: string): { readonly text: string; readonly author: string; readonly knownIssueId?: string } | undefined {
  const match = NOTE.exec(content.trim());
  if (!match) return undefined;
  return { text: match[3]!.trim(), author: match[1]!, ...(match[2] ? { knownIssueId: match[2] } : {}) };
}

/** What every agent is told about team notes. `knownIssues`: whether it can propose known issues (customers' agents). */
export function teamNoteRules(person: "customer" | "player", knownIssues: boolean): string {
  const lines = [
    `- A message wrapped in a <${BLOCK}> block comes from a Contoso Outdoors support team member, not the ${person}, and the ${person} doesn't see it. Follow it.`,
  ];
  if (knownIssues) {
    lines.push(
      "- When a team note tells you about an ongoing problem that affects many customers (an outage, a known bug, a workaround while something is fixed), call report_known_issue once: a short title, how customers describe the problem, and what customers should be told. A team member records it for the whole desk. It's internal, like store_memory: never mention it to the customer.",
    );
  }
  lines.push(
    `- After a team note, reply to the ${person} only with what they need to know, in your own words, as if you had just learned it. Never quote the note, name the team member, or mention notes, the team's tools, or known issues by that name. Anything that costs money (refunds, cancellations) still goes through your tools and waits for a team member's approval, as always.`,
  );
  return lines.join("\n");
}
