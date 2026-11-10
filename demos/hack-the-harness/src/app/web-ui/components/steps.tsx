import { BookOpen, ChevronRight, Loader2, SquareTerminal, Wrench } from "lucide-react";
import type { TimelineItem } from "../lib/timeline";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

// A run of tool calls, shown as one collapsed line like a chain of thought.
export function Steps({ tools }: { tools: ToolItem[] }) {
  const running = tools.find(tool => tool.success === undefined);

  return (
    <Collapsible className="w-full text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex items-center gap-2 py-1 hover:text-foreground">
        {running
          ? <Loader2 className="size-4 animate-spin" />
          : <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />}
        {running ? `${label(running)}…` : `Ran ${tools.length} ${tools.length === 1 ? "step" : "steps"}`}
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-2 mt-1 flex flex-col border-l pl-4">
        {tools.map(tool => <Step key={tool.id} tool={tool} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Step({ tool }: { tool: ToolItem }) {
  const Icon = tool.name === "bash" ? SquareTerminal : tool.name === "skill" ? BookOpen : Wrench;
  const command = typeof tool.input.command === "string" ? `$ ${tool.input.command}` : JSON.stringify(tool.input, null, 2);
  const output = tool.error ?? tool.output?.content;

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 py-1 text-left hover:text-foreground">
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{label(tool)}</span>
        {tool.success === false && <span className="shrink-0 text-destructive">failed</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="my-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs">
          {command}
          {output && `\n\n${output}`}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function label(tool: ToolItem) {
  if (typeof tool.input.description === "string") {
    return tool.input.description;
  }

  if (tool.name === "skill") {
    return `Used the ${tool.input.skill} skill`;
  }

  const name = tool.name.replace(/_/g, " ");
  return name[0].toUpperCase() + name.slice(1);
}

// Puts each run of tool calls into one collapsible list. Shared files stay separate, as download cards.
export function groupSteps(items: TimelineItem[]) {
  const groups: (TimelineItem | { kind: "steps"; id: string; tools: ToolItem[] })[] = [];

  for (const item of items) {
    const last = groups.at(-1);

    if (item.kind !== "tool" || (item.name === "share_file" && item.success)) {
      groups.push(item);
    } else if (last?.kind === "steps") {
      last.tools.push(item);
    } else {
      groups.push({ kind: "steps", id: item.id, tools: [item] });
    }
  }

  return groups;
}
