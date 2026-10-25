// The tutorial: scenes of shots. Each shot has a visual (a slide or a range of a recorded clip) and narration
// pages; each page is spoken (`say`, defaulting to the caption) and shown as one caption.
// Clip ranges: numbers are seconds; "mark:<label prefix>" resolves against the clip's markers; "end" is the clip end.

export const scenes = [
  {
    id: "intro",
    shots: [
      {
        id: "title",
        slide: "title",
        pages: [
          "This is a short tour of Managed Copilot.",
          "It lets you run GitHub Copilot agents inside environments you own: on your own laptop, or in your own Azure subscription.",
        ],
      },
      {
        id: "idea",
        slide: "idea",
        pages: [
          { caption: "Apps can already build in Copilot agents with the GitHub Copilot SDK.", say: "Apps can already build in Copilot agents with the GitHub Copilot S D K." },
          "Managed Copilot keeps that same SDK, unmodified, and changes only where the agents run.",
        ],
      },
      {
        id: "idea-setup",
        slide: "idea-setup",
        pages: [
          "Your code still creates a normal Copilot client and session.",
          "Two setup lines connect it to your platform, which decides where each agent runs and what it can reach.",
        ],
      },
    ],
  },
  {
    id: "environments",
    shots: [
      { id: "env-0", slide: "env-0", pages: [{ caption: "You describe your environments once, in an Aspire AppHost. There are three kinds.", say: "You describe your environments once, in an Aspire app host. There are three kinds." }] },
      { id: "env-1", slide: "env-1", pages: ["A shared environment is a lightweight chat agent. Its tools run inside your own app."] },
      {
        id: "env-2",
        slide: "env-2",
        pages: [
          "An isolated environment gives every session its own sandbox:",
          "a private workspace with a shell, the packages you choose, and network rules you control.",
        ],
      },
      { id: "env-3", slide: "env-3", pages: ["A promotable session starts out cheap, then moves into its own sandbox the moment it needs one."] },
    ],
  },
  {
    id: "architecture",
    shots: [
      { id: "arch-1", slide: "arch-1", pages: ["Here is how the pieces fit together. Your app connects to a gateway that you run."] },
      {
        id: "arch-2",
        slide: "arch-2",
        pages: [
          "The gateway signs you in with GitHub, and sends each session to a shared runtime or to its own sandbox.",
          "It keeps a durable record of every request your app must answer, so work can continue after your app goes away.",
        ],
      },
      {
        id: "arch-3",
        slide: "arch-3",
        pages: [
          "Sandboxes reach the internet only through an egress proxy.",
          "It enforces your allowlists and adds secrets at the edge, so code in the sandbox only ever sees placeholders.",
        ],
      },
      { id: "arch-4", slide: "arch-4", pages: ["Model calls go through the gateway and use your own Copilot plan. Your GitHub token never enters a sandbox."] },
    ],
  },
  {
    id: "run",
    shots: [
      {
        id: "run",
        slide: "run",
        pages: [
          { caption: "Running it on your machine takes one command: aspire run.", say: "Running it on your machine takes one command: aspire run." },
          "It starts the gateway, the sandbox images, the egress proxy, and both demos.",
        ],
      },
      {
        id: "quickstart",
        slide: "quickstart",
        pages: [
          "Every example in the design is also an automated check.",
          "The quickstart runs all thirteen against the real platform, with real models, and all thirteen pass.",
        ],
      },
    ],
  },
  {
    id: "factory",
    shots: [
      { id: "factory-chapter", slide: "chapter-factory", pages: ["Demo one: an AI software factory."] },
      {
        id: "factory-start",
        clip: "factory-start",
        from: 0,
        to: "end",
        pages: [
          "You describe the software you want, and a team of Copilot agents builds it.",
          { caption: "Here, we start the CSV ⇄ JSON toolkit.", say: "Here, we start the C S V to Jason toolkit." },
        ],
      },
      {
        id: "factory-plan",
        clip: "factory-run",
        from: 0,
        to: "mark:floor",
        pages: ["A planner agent splits the work into two tasks. It runs on a shared runtime, with no network access."],
      },
      {
        id: "factory-build",
        clip: "factory-run",
        from: "mark:floor",
        to: "mark:review:json2csv working r1",
        pages: [
          "Each task goes to its own builder, in its own sandbox.",
          "Both builders work at the same time, writing code and running the tests.",
        ],
      },
      {
        id: "factory-review",
        clip: "factory-run",
        from: "mark:review:json2csv working r1",
        to: "mark:release starting",
        pages: [
          "A reviewer on a different model checks each task.",
          "When it finds a problem, it sends the work back with the file and line, and the builder fixes it in the same sandbox.",
        ],
      },
      {
        id: "factory-release",
        clip: "factory-run",
        from: "mark:release starting",
        to: "end",
        pages: [
          { caption: "Finally, a release agent combines the tasks, adds integration tests and a README, and checks that everything passes.", say: "Finally, a release agent combines the tasks, adds integration tests and a read me, and checks that everything passes." },
        ],
      },
      {
        id: "factory-deliverable",
        clip: "factory-after",
        from: 0,
        to: "mark:cli",
        pages: ["The result is a tested release you can download, and every station's files are kept as versioned artifacts."],
      },
      {
        id: "factory-cli",
        clip: "factory-after",
        from: "mark:cli",
        to: "end",
        pages: [{ caption: "Any agent's session can also be opened in the Copilot CLI, attached to the same live conversation.", say: "Any agent's session can also be opened in the Copilot command line, attached to the same live conversation." }],
      },
    ],
  },
  {
    id: "assistant",
    shots: [
      { id: "assistant-chapter", slide: "chapter-assistant", pages: ["Demo two: a personal assistant."] },
      {
        id: "assistant-welcome",
        clip: "assistant-welcome",
        from: 0,
        to: "end",
        pages: [
          "This is an assistant you chat with, like a bot. It can read your mail and manage your calendar.",
          "Here it uses a clearly labeled demo inbox and calendar; you can connect your own Google account.",
        ],
      },
      {
        id: "assistant-triage",
        clip: "assistant-triage",
        from: 0,
        to: "end",
        pages: ["Ask it to triage your inbox, and it sorts your messages into what needs a reply, what is just for your information, and what can wait."],
      },
      {
        id: "assistant-find",
        clip: "assistant-meeting",
        from: 0,
        to: "mark:approval",
        pages: ["Ask it to book a meeting, and it checks your calendar for a free slot."],
      },
      {
        id: "assistant-approve",
        clip: "assistant-meeting",
        from: "mark:approval",
        to: "end",
        pages: ["But it always asks before it sends mail or changes your calendar. Here, we approve the invite."],
      },
      {
        id: "assistant-remind",
        clip: "assistant-reminder",
        from: 0,
        to: "mark:scheduled",
        toOffset: 2,
        pages: ["It also keeps working when you're not there. Ask for a reminder, and the platform schedules it."],
      },
      {
        id: "assistant-fired",
        clip: "assistant-reminder",
        from: "mark:fired",
        fromOffset: -1.5,
        to: "end",
        pages: ["A minute later, the reminder runs on its own, as you, and the assistant sends you a message."],
      },
      {
        id: "assistant-offline-ask",
        clip: "assistant-offline-ask",
        from: 0,
        to: "end",
        pages: ["Now we ask it to check the calendar in two minutes, and then close the tab."],
      },
      {
        id: "assistant-closed",
        slide: "tab-closed",
        pages: [
          "With no browser open, the platform still runs the request.",
          "When the agent needs the calendar, the platform calls the assistant's server directly.",
        ],
      },
      {
        id: "assistant-away",
        clip: "assistant-away",
        from: 0,
        to: "end",
        pages: ["When we come back, the answer is waiting, and the calendar lookup is marked: handled while you were away."],
      },
    ],
  },
  {
    id: "azure",
    shots: [
      {
        id: "azure",
        slide: "azure",
        pages: [
          "The same AppHost deploys to Azure with one more command: aspire deploy.",
          "The gateway, the demos, and the egress proxy run as Azure Container Apps.",
          "Each isolated session gets its own sandbox, and the platform's state is kept on Azure Files.",
        ].map((caption) => ({ caption, say: caption.replace("AppHost", "app host") })),
      },
      { id: "azure-factory", clip: "azure-factory", from: 0, to: "end", pages: ["Both demos run there today."] },
      {
        id: "azure-assistant",
        clip: "azure-assistant",
        from: 0,
        to: "end",
        pages: ["Eleven of the thirteen checks run against the deployment, and all eleven pass. The other two need a local webhook receiver."],
      },
    ],
  },
  {
    id: "wrap",
    shots: [
      {
        id: "recap",
        slide: "recap",
        pages: [
          "To recap: genuine Copilot SDK clients and sessions, running in environments you control,",
          "with sandboxes, network rules, secrets, offline work, schedules, and the Copilot CLI,",
          "all tested end to end with real models, locally and on Azure.",
        ].map((caption) => ({ caption, say: caption.replace("SDK", "S D K").replace("Copilot CLI", "Copilot command line") })),
      },
      {
        id: "try",
        slide: "try",
        pages: [
          { caption: "To try it yourself: sign in with the GitHub CLI, install and build, and run aspire run.", say: "To try it yourself: sign in with the GitHub command line, install and build, and run aspire run." },
          { caption: "Then open the factory and the assistant. The README and the quickstart are the best places to start.", say: "Then open the factory and the assistant. The read me and the quickstart are the best places to start." },
          "Thanks for watching.",
        ],
      },
    ],
  },
];

/** Narration pages as { caption, say }. */
export function pagesOf(shot) {
  return shot.pages.map((page) => (typeof page === "string" ? { caption: page, say: page } : { caption: page.caption, say: page.say ?? page.caption }));
}
