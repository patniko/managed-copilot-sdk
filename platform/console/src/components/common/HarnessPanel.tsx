import type { OperatorHarness, OperatorHarnessTool, OperatorMcpServer } from "@managed-copilot/protocol/operator";
import { Bot, Braces, Plug, ScrollText, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { Card, Field, FieldGrid, KeyValueTable } from "../ui/Card.js";
import { Chip } from "../ui/Chip.js";
import { CodeBlock, Disclosure, JsonBlock } from "../ui/CodeBlock.js";
import { Callout, EmptyState, None } from "../ui/Feedback.js";
import { ChipList, YesNo } from "./Entities.js";

const SOURCES: Readonly<Record<OperatorHarnessTool["source"], { readonly label: string; readonly tone: "active" | "plain" | "warning"; readonly description: string }>> = {
  client: { label: "Client", tone: "active", description: "Defined by a connected app (defineTool)" },
  server: { label: "Server", tone: "plain", description: "A declaration stored for schedules" },
  platform: { label: "Platform", tone: "warning", description: "Injected by the gateway" },
};

/** A session's admitted harness: what the runtime was told to run with (secrets redacted by the gateway). */
export function HarnessPanel({ harness, problem }: { readonly harness: OperatorHarness | undefined; readonly problem: string | undefined }) {
  if (!harness) {
    return problem ? (
      <Callout tone="danger" title="The harness can't be shown" role="alert">
        {problem}
      </Callout>
    ) : (
      <Card>
        <EmptyState icon={Wrench} title="No harness recorded">
          The gateway has no admitted configuration for this session yet.
        </EmptyState>
      </Card>
    );
  }
  const options = Object.entries(harness.options);
  return (
    <div className="space-y-5">
      {problem ? (
        <Callout tone="warning" title="Part of the harness can't be shown">
          {problem}
        </Callout>
      ) : null}
      <Card title="Model and agent" icon={Bot}>
        <FieldGrid columns={4}>
          <Field label="Model" mono>
            {harness.model}
          </Field>
          <Field label="Agent">{harness.agent}</Field>
          <Field label="Reasoning effort">{harness.reasoningEffort}</Field>
          <Field label="Working directory" mono>
            {harness.workingDirectory}
          </Field>
          <Field label="Allowed models" wide>
            {harness.allowedModels ? <ChipList items={harness.allowedModels} mono empty="None" /> : <span className="text-zinc-500">Any the environment allows</span>}
          </Field>
        </FieldGrid>
      </Card>

      <SystemMessage harness={harness} />

      <Card title="Tools" icon={Wrench} description="Tools the session's runtime was given." padded={false}>
        <div className="grid gap-5 border-b border-zinc-800/70 p-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Available tools (allowlist)</h3>
            {harness.availableTools ? <ChipList items={harness.availableTools} mono empty="None" /> : <span className="text-[13px] text-zinc-500">Not restricted</span>}
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Excluded tools</h3>
            <ChipList items={harness.excludedTools} mono empty="None" />
          </div>
        </div>
        {harness.tools.length === 0 ? (
          <p className="p-4 text-[13px] text-zinc-500">No custom tools.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {harness.tools.map((tool) => (
              <ToolRow key={`${tool.source}:${tool.name}`} tool={tool} />
            ))}
          </ul>
        )}
      </Card>

      <McpServers servers={harness.mcpServers} />

      <Card title="Custom agents" icon={Bot} padded={harness.customAgents.length === 0}>
        {harness.customAgents.length === 0 ? (
          <p className="text-[13px] text-zinc-500">None.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {harness.customAgents.map((agent) => (
              <li key={agent.name} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13.5px] font-semibold text-zinc-100">{agent.displayName ?? agent.name}</span>
                  {agent.displayName ? <span className="font-mono text-[12px] text-zinc-500">{agent.name}</span> : null}
                  {agent.model ? (
                    <Chip mono title="Model">
                      {agent.model}
                    </Chip>
                  ) : null}
                </div>
                {agent.description ? <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{agent.description}</p> : null}
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Tools</p>
                    {agent.tools ? <ChipList items={agent.tools} mono empty="None" /> : <span className="text-[12.5px] text-zinc-500">All available tools</span>}
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">MCP servers</p>
                    <ChipList items={agent.mcpServers} mono empty="None" />
                  </div>
                </div>
                {agent.prompt ? (
                  <Disclosure className="mt-3" summary="Prompt">
                    <CodeBlock text={agent.prompt} label={`Prompt of ${agent.name}`} copyLabel="Copy prompt" maxHeight="md" />
                  </Disclosure>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Customizations and skills" icon={Sparkles}>
          <FieldGrid columns={3}>
            <Field label="Deployed agents">
              <YesNo value={harness.customizations.agents} yes="Read" no="Not read" />
            </Field>
            <Field label="Deployed skills">
              <YesNo value={harness.customizations.skills} yes="Read" no="Not read" />
            </Field>
            <Field label="Instructions">
              <YesNo value={harness.customizations.instructions} yes="Read" no="Not read" />
            </Field>
            <Field label="Skills">
              <YesNo value={harness.skills.enabled} yes="Enabled" no="Disabled" />
            </Field>
            <Field label="Disabled skills" wide>
              <ChipList items={harness.skills.disabled} mono empty="None" />
            </Field>
          </FieldGrid>
        </Card>
        <Card title="Client callbacks" icon={Plug} description="Handlers connected clients registered.">
          <FieldGrid columns={2}>
            <Field label="Tools">
              <ChipList items={harness.callbacks.tools} mono empty="None" />
            </Field>
            <Field label="Callbacks">
              <ChipList items={harness.callbacks.flags} mono empty="None" />
            </Field>
          </FieldGrid>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Options" icon={Braces} description="Other caller settings with simple values.">
          {options.length > 0 ? (
            <KeyValueTable label="Session options" keyHeader="Option" rows={options.map(([key, value]) => [key, String(value)] as const)} />
          ) : (
            <p className="text-[13px] text-zinc-500">None.</p>
          )}
        </Card>
        <Card title="Enforced by the platform" icon={ShieldCheck}>
          {harness.enforced.length > 0 ? (
            <ul className="space-y-1.5 text-[13px] text-zinc-300">
              {harness.enforced.map((setting) => (
                <li key={setting} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-zinc-500" aria-hidden />
                  <span className="min-w-0 break-words">{setting}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-zinc-500">None.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function SystemMessage({ harness }: { readonly harness: OperatorHarness }) {
  const message = harness.systemMessage;
  const sections = Object.entries(message?.sections ?? {});
  return (
    <Card title="System message" icon={ScrollText} actions={message ? <Chip mono>mode: {message.mode}</Chip> : undefined}>
      {!message ? (
        <p className="text-[13px] text-zinc-500">The runtime&apos;s default system message.</p>
      ) : (
        <div className="space-y-4">
          {message.content ? <CodeBlock text={message.content} label="System message" copyLabel="Copy system message" maxHeight="lg" /> : null}
          {sections.length > 0 ? (
            <div className="space-y-3">
              {sections.map(([name, section]) => (
                <div key={name} className="rounded-xl border border-zinc-800/80 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12.5px] text-zinc-100">{name}</span>
                    <Chip>{section.action}</Chip>
                  </div>
                  {section.content ? <CodeBlock className="mt-2" text={section.content} label={`Section ${name}`} copyLabel="Copy section" maxHeight="sm" /> : null}
                </div>
              ))}
            </div>
          ) : null}
          {!message.content && sections.length === 0 ? <p className="text-[13px] text-zinc-500">No content.</p> : null}
        </div>
      )}
    </Card>
  );
}

function ToolRow({ tool }: { readonly tool: OperatorHarnessTool }) {
  const source = SOURCES[tool.source] ?? { label: tool.source, tone: "plain" as const, description: "" };
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12.5px] font-semibold text-zinc-100">{tool.name}</span>
        <Chip tone={source.tone} title={source.description}>
          {source.label}
        </Chip>
        {tool.skipPermission ? <Chip tone="warning">Skips permission</Chip> : null}
        {tool.overridesBuiltInTool ? <Chip tone="warning">Overrides built-in</Chip> : null}
      </div>
      {tool.description ? <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{tool.description}</p> : null}
      {tool.parameters && Object.keys(tool.parameters).length > 0 ? (
        <Disclosure className="mt-2" summary="Parameters (JSON schema)">
          <JsonBlock value={tool.parameters} label={`Parameters of ${tool.name}`} maxHeight="md" />
        </Disclosure>
      ) : null}
    </li>
  );
}

function McpServers({ servers }: { readonly servers: readonly OperatorMcpServer[] }) {
  return (
    <Card title="MCP servers" icon={Plug} padded={servers.length === 0}>
      {servers.length === 0 ? (
        <p className="text-[13px] text-zinc-500">None.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]" aria-label="MCP servers">
            <thead className="border-b border-zinc-800 text-[11px] uppercase tracking-[0.06em] text-zinc-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Server
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Transport
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Target
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Header names
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Env names
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Tools
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Agent
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={`${server.agent ?? ""}:${server.name}`} className="border-b border-zinc-800/60 align-top last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-zinc-100">{server.name}</span>
                    {server.adapter ? (
                      <Chip className="ml-1.5" tone="active" title="Reached through the gateway's MCP adapter, which applies network policy and vault credentials">
                        via gateway
                      </Chip>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip mono>{server.transport}</Chip>
                  </td>
                  <td className="max-w-80 px-3 py-2.5 font-mono break-all text-zinc-300">
                    {server.url ? server.url : server.command ? [server.command, ...(server.args ?? [])].join(" ") : <None />}
                  </td>
                  <td className="px-3 py-2.5">
                    <ChipList items={server.headers} mono />
                  </td>
                  <td className="px-3 py-2.5">
                    <ChipList items={server.env} mono />
                  </td>
                  <td className="px-3 py-2.5">{server.tools ? <ChipList items={server.tools} mono empty="None" /> : <span className="text-zinc-500">All</span>}</td>
                  <td className="px-4 py-2.5 text-zinc-300">{server.agent ?? <span className="text-zinc-500">Session</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
