import type { OperatorHarness, OperatorHarnessTool, OperatorMcpServer } from "@managed-copilot/protocol/operator";
import { AgentIcon, AiModelIcon, CommentIcon, McpIcon, PlugIcon, ShieldCheckIcon, SlidersIcon, SparkleFillIcon, ToolsIcon } from "@primer/octicons-react";
import { Card, Field, FieldGrid, KeyValueTable } from "../ui/Card.js";
import { Chip } from "../ui/Chip.js";
import { CodeBlock, Disclosure, JsonBlock } from "../ui/CodeBlock.js";
import { Callout, EmptyState, None, SectionLabel } from "../ui/Feedback.js";
import { ChipList, YesNo } from "./Entities.js";

const SOURCES: Readonly<Record<OperatorHarnessTool["source"], { readonly label: string; readonly tone: "accent" | "plain" | "attention"; readonly description: string }>> = {
  client: { label: "Client", tone: "accent", description: "Defined by a connected app (defineTool)" },
  server: { label: "Server", tone: "plain", description: "A declaration stored for schedules" },
  platform: { label: "Platform", tone: "attention", description: "Injected by the gateway" },
};

function Muted({ children }: { readonly children: string }) {
  return <p className="text-fg-muted">{children}</p>;
}

/** A session's admitted harness: what the runtime was told to run with (secrets redacted by the gateway). */
export function HarnessPanel({ harness, problem }: { readonly harness: OperatorHarness | undefined; readonly problem: string | undefined }) {
  if (!harness) {
    return problem ? (
      <Callout tone="danger" title="The harness can't be shown" role="alert">
        {problem}
      </Callout>
    ) : (
      <div className="Box">
        <EmptyState icon={ToolsIcon} title="No harness recorded">
          The gateway has no admitted configuration for this session yet.
        </EmptyState>
      </div>
    );
  }
  const options = Object.entries(harness.options);
  return (
    <div className="space-y-6">
      {problem ? (
        <Callout tone="attention" title="Part of the harness can't be shown">
          {problem}
        </Callout>
      ) : null}
      <Card title="Model and agent" icon={AiModelIcon}>
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
            {harness.allowedModels ? <ChipList items={harness.allowedModels} mono empty="None" /> : <span className="text-fg-muted">Any the environment allows</span>}
          </Field>
        </FieldGrid>
      </Card>

      <SystemMessage harness={harness} />

      <Card title="Tools" icon={ToolsIcon} description="Tools the session's runtime was given." padded={false}>
        <div className="grid gap-5 border-b border-line p-4 lg:grid-cols-2">
          <div className="min-w-0">
            <SectionLabel className="mb-2">Available tools (allowlist)</SectionLabel>
            {harness.availableTools ? <ChipList items={harness.availableTools} mono empty="None" /> : <Muted>Not restricted</Muted>}
          </div>
          <div className="min-w-0">
            <SectionLabel className="mb-2">Excluded tools</SectionLabel>
            <ChipList items={harness.excludedTools} mono empty="None" />
          </div>
        </div>
        {harness.tools.length === 0 ? (
          <p className="p-4 text-fg-muted">No custom tools.</p>
        ) : (
          <ul>
            {harness.tools.map((tool) => (
              <ToolRow key={`${tool.source}:${tool.name}`} tool={tool} />
            ))}
          </ul>
        )}
      </Card>

      <McpServers servers={harness.mcpServers} />

      <Card title="Custom agents" icon={AgentIcon} padded={harness.customAgents.length === 0}>
        {harness.customAgents.length === 0 ? (
          <Muted>None.</Muted>
        ) : (
          <ul>
            {harness.customAgents.map((agent) => (
              <li key={agent.name} className="Box-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{agent.displayName ?? agent.name}</span>
                  {agent.displayName ? <span className="font-mono text-xs text-fg-muted">{agent.name}</span> : null}
                  {agent.model ? (
                    <Chip mono title="Model">
                      {agent.model}
                    </Chip>
                  ) : null}
                </div>
                {agent.description ? <p className="mt-1 text-fg-muted">{agent.description}</p> : null}
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <SectionLabel className="mb-1.5">Tools</SectionLabel>
                    {agent.tools ? <ChipList items={agent.tools} mono empty="None" /> : <Muted>All available tools</Muted>}
                  </div>
                  <div className="min-w-0">
                    <SectionLabel className="mb-1.5">MCP servers</SectionLabel>
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

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Customizations and skills" icon={SparkleFillIcon}>
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
        <Card title="Client callbacks" icon={PlugIcon} description="Handlers connected clients registered.">
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

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Options" icon={SlidersIcon} description="Other caller settings with simple values.">
          {options.length > 0 ? <KeyValueTable label="Session options" keyHeader="Option" rows={options.map(([key, value]) => [key, String(value)] as const)} /> : <Muted>None.</Muted>}
        </Card>
        <Card title="Enforced by the platform" icon={ShieldCheckIcon}>
          {harness.enforced.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 marker:text-fg-muted">
              {harness.enforced.map((setting) => (
                <li key={setting} className="break-words">
                  {setting}
                </li>
              ))}
            </ul>
          ) : (
            <Muted>None.</Muted>
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
    <Card title="System message" icon={CommentIcon} actions={message ? <Chip mono>mode: {message.mode}</Chip> : undefined}>
      {!message ? (
        <Muted>The runtime&apos;s default system message.</Muted>
      ) : (
        <div className="space-y-3">
          {message.content ? <CodeBlock text={message.content} label="System message" title="Content" copyLabel="Copy system message" maxHeight="lg" /> : null}
          {sections.map(([name, section]) =>
            section.content ? (
              <CodeBlock
                key={name}
                text={section.content}
                label={`Section ${name}`}
                title={name}
                path
                headerExtra={<Chip>{section.action}</Chip>}
                copyLabel="Copy section"
                maxHeight="sm"
              />
            ) : (
              <div key={name} className="Box flex items-center gap-2 bg-canvas-muted py-2 pr-2 pl-4">
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{name}</span>
                <Chip>{section.action}</Chip>
              </div>
            ),
          )}
          {!message.content && sections.length === 0 ? <Muted>No content.</Muted> : null}
        </div>
      )}
    </Card>
  );
}

function ToolRow({ tool }: { readonly tool: OperatorHarnessTool }) {
  const source = SOURCES[tool.source] ?? { label: tool.source, tone: "plain" as const, description: "" };
  return (
    <li className="Box-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold">{tool.name}</span>
        <Chip tone={source.tone} title={source.description}>
          {source.label}
        </Chip>
        {tool.skipPermission ? <Chip tone="attention">Skips permission</Chip> : null}
        {tool.overridesBuiltInTool ? <Chip tone="attention">Overrides built-in</Chip> : null}
      </div>
      {tool.description ? <p className="mt-1 text-fg-muted">{tool.description}</p> : null}
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
    <Card title="MCP servers" icon={McpIcon} padded={servers.length === 0}>
      {servers.length === 0 ? (
        <Muted>None.</Muted>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="Table" aria-label="MCP servers">
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Transport</th>
                <th scope="col">Target</th>
                <th scope="col">Header names</th>
                <th scope="col">Env names</th>
                <th scope="col">Tools</th>
                <th scope="col">Agent</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={`${server.agent ?? ""}:${server.name}`} className="align-top">
                  <td>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold">{server.name}</span>
                      {server.adapter ? (
                        <Chip tone="accent" title="Reached through the gateway's MCP adapter, which applies network policy and vault credentials">
                          via gateway
                        </Chip>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <Chip mono>{server.transport}</Chip>
                  </td>
                  <td className="max-w-80 font-mono text-xs break-all">{server.url ? server.url : server.command ? [server.command, ...(server.args ?? [])].join(" ") : <None />}</td>
                  <td>
                    <ChipList items={server.headers} mono />
                  </td>
                  <td>
                    <ChipList items={server.env} mono />
                  </td>
                  <td>{server.tools ? <ChipList items={server.tools} mono empty="None" /> : <span className="text-fg-muted">All</span>}</td>
                  <td>{server.agent ?? <span className="text-fg-muted">Session</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
