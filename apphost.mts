// The Managed Copilot AppHost. `aspire run` starts the platform with its example environments and the demos.
import { createBuilder } from "./.aspire/modules/aspire.mjs";
import { addManagedCopilot } from "@managed-copilot/aspire";

const builder = await createBuilder();

const copilot = await addManagedCopilot(builder, "copilot", {
  environments: {
    chat: { type: "shared", description: "Chat agent with your own tools", network: ["learn.microsoft.com"] },
    coder: { type: "isolated", size: "small", description: "Coding agent in its own sandbox" },
    helper: { type: "promotable", promoteTo: "coder", description: "Starts shared, moves into a sandbox when it needs one" },
  },

  // Lets code request { type, size } without a name, using the default sandbox image and settings.
  inline: { types: ["shared", "isolated"], sizes: ["small"] },
});

await builder.build().run();
