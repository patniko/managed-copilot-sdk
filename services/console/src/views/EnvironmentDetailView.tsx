import type { CustomizationFileInfo, OperatorCustomizations, OperatorEnvironment, OperatorToolPolicy, OperatorVaultRef } from "@managed-copilot/protocol/operator";
import {
  AgentIcon,
  AiModelIcon,
  ArrowRightIcon,
  BookIcon,
  ChecklistIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  FileCodeIcon,
  FileDirectoryFillIcon,
  FileDirectoryIcon,
  FileDirectoryOpenFillIcon,
  FileIcon,
  GlobeIcon,
  KeyIcon,
  McpIcon,
  PackageIcon,
  PeopleIcon,
  SandboxIcon,
  SparkleFillIcon,
  StackIcon,
  ToolsIcon,
  WorkflowIcon,
} from "@primer/octicons-react";
import { useMemo, useState, type ReactNode } from "react";
import { getEnvironment, getEnvironmentFile, listSessions } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { formatBytes, formatDuration, formatNumber, formatSize } from "../lib/format.js";
import { isMarkdownPath, parseFrontmatter } from "../lib/frontmatter.js";
import { usePoll } from "../lib/poll.js";
import { useQueryUpdater } from "../lib/router.js";
import { buildSearch, hrefs, type Query } from "../lib/routes.js";
import { healthMeta } from "../lib/status.js";
import { ancestorFolders, buildFileTree, type FileTreeNode } from "../lib/tree.js";
import { ChipList, EnvironmentTypeChip, NetworkPolicyView, YesNo } from "../components/common/Entities.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { buttonClass } from "../components/ui/Button.js";
import { Card, Field, FieldGrid, KeyValueTable } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { CodeBlock, CodeLines } from "../components/ui/CodeBlock.js";
import { Segmented, Tabs } from "../components/ui/Controls.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { TableSkeleton } from "../components/ui/DataTable.js";
import { Callout, Code, EmptyState, ErrorState, None, SectionLabel, Skeleton, SkeletonLines } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";
import { MarkdownView } from "../components/ui/Markdown.js";
import { SessionsTable } from "./SessionsView.js";

const TABS = ["policy", "harness", "customizations", "sessions"] as const;
type Tab = (typeof TABS)[number];

function tabFrom(query: Query): Tab {
  const value = query["tab"];
  return (TABS as readonly string[]).includes(value ?? "") ? (value as Tab) : "policy";
}

export function EnvironmentDetailView({ name, query }: { readonly name: string; readonly query: Query }) {
  const poll = usePoll(`environment:${name}`, (signal) => getEnvironment(name, signal));
  const tab = tabFrom(query);
  const environment = poll.data;
  const tabHref = (id: string): string => hrefs.environment(name, { tab: id === "policy" ? undefined : id });
  return (
    <Page
      wide
      title={<span className="font-mono">{name}</span>}
      documentTitle={`${name} · Environments`}
      breadcrumbs={[{ label: "Environments", href: hrefs.view("environments") }, { label: name }]}
      description={environment?.description}
      poll={poll}
      actions={environment ? <EnvironmentTypeChip type={environment.type} /> : null}
      headerExtra={
        <Tabs
          label="Environment sections"
          active={tab}
          hrefFor={tabHref}
          items={[
            { id: "policy", label: "Policy", icon: ChecklistIcon },
            { id: "harness", label: "Harness", icon: ToolsIcon },
            { id: "customizations", label: "Customizations", icon: SparkleFillIcon, count: environment?.customizations?.files.length, countTone: environment?.customizations?.problem ? "danger" : undefined },
            { id: "sessions", label: "Sessions", icon: CommentDiscussionIcon, count: environment?.sessions.total },
          ]}
        />
      }
    >
      <PollContent
        poll={poll}
        skeleton={<DetailSkeleton />}
        errorTitle="Couldn't load this environment"
        boxed
        notFound={() => (
          <div className="Box">
            <EmptyState
              icon={StackIcon}
              title="Environment not found"
              spacious
              action={
                <Link href={hrefs.view("environments")} className={buttonClass("default")}>
                  Back to environments
                </Link>
              }
            >
              No environment named <Code>{name}</Code> is declared in this deployment.
            </EmptyState>
          </div>
        )}
      >
        {(data) => (
          <>
            {tab === "policy" ? <PolicyTab environment={data} /> : null}
            {tab === "harness" ? <HarnessTab policy={data.tools} /> : null}
            {tab === "customizations" ? <CustomizationsTab environment={data} query={query} /> : null}
            {tab === "sessions" ? <SessionsTab environment={data} /> : null}
          </>
        )}
      </PollContent>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Policy

function PolicyTab({ environment }: { readonly environment: OperatorEnvironment }) {
  const sandboxed = environment.type === "isolated" || environment.type === "promotable";
  const env = Object.entries(environment.env ?? {});
  return (
    <div className="space-y-6">
      {environment.customizations?.problem ? (
        <Callout tone="danger" title="Sessions in this environment fail">
          {environment.customizations.problem}
        </Callout>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Models" icon={AiModelIcon}>
          {environment.models && environment.models.length > 0 ? <ChipList items={environment.models} mono label="Allowed models" /> : <p>Every model the caller&apos;s Copilot entitlement offers.</p>}
        </Card>
        <Card title="Network ceiling" icon={GlobeIcon} description="Callers can narrow this policy, never broaden it.">
          <NetworkPolicyView policy={environment.network} />
        </Card>
      </div>

      {environment.type === "orchestrator" ? (
        <Card title="Workers" icon={PeopleIcon} description="Coordinators run on the shared runtime and start workers, each a session of a worker environment in its own sandbox.">
          <FieldGrid columns={2}>
            <Field label="Worker environments" hint="The first is the default">
              {environment.workers && environment.workers.length > 0 ? (
                <span className="flex flex-wrap items-center gap-2">
                  {environment.workers.map((worker) => (
                    <Link key={worker} href={hrefs.environment(worker)} className="Link font-mono text-xs">
                      {worker}
                    </Link>
                  ))}
                </span>
              ) : undefined}
            </Field>
            <Field label="At once per session" hint="Stopped workers don't count">
              {environment.maxWorkers !== undefined ? formatNumber(environment.maxWorkers) : undefined}
            </Field>
          </FieldGrid>
        </Card>
      ) : (
        <Card title="Sandbox" icon={SandboxIcon} description={sandboxed ? "What each session's sandbox is built from." : undefined}>
          {sandboxed ? (
            <div className="space-y-6">
              <FieldGrid columns={4}>
                <Field label="Size">{formatSize(environment.size, environment.resources)}</Field>
                <Field label="Idle timeout" hint="Before an idle sandbox may stop compute">
                  {environment.idleTimeoutSeconds !== undefined ? formatDuration(environment.idleTimeoutSeconds) : <span className="text-fg-muted">Backend default</span>}
                </Field>
                <Field label="Warm instances">{environment.warm !== undefined ? formatNumber(environment.warm) : <span className="text-fg-muted">None</span>}</Field>
                <Field label="Inference">
                  {environment.inference?.foundry ? (
                    <span className="font-mono text-xs">Foundry: {environment.inference.foundry}</span>
                  ) : environment.inference?.openai ? (
                    <span className="font-mono text-xs">OpenAI-compatible: {environment.inference.openai}</span>
                  ) : (
                    <span className="text-fg-muted">Through GitHub Copilot</span>
                  )}
                </Field>
                <Field label="Image" wide>
                  {environment.image ? (
                    <span className="inline-flex max-w-full items-center gap-1">
                      <span className="min-w-0 font-mono text-xs break-all">{environment.image}</span>
                      <CopyButton text={environment.image} label="Copy image" className="size-6" />
                    </span>
                  ) : (
                    <span className="text-fg-muted">The platform&apos;s default sandbox image</span>
                  )}
                </Field>
              </FieldGrid>
              <div className="grid gap-5 border-t border-line-muted pt-4 lg:grid-cols-3">
                <PackageList label="Python packages" items={environment.packages?.python} />
                <PackageList label="npm packages" items={environment.packages?.npm} />
                <PackageList label="System packages" items={environment.packages?.system} hint="Installed when the image is prepared" />
              </div>
              <div className="border-t border-line-muted pt-4">
                {environment.setupCommands && environment.setupCommands.length > 0 ? (
                  <CodeBlock text={environment.setupCommands.join("\n")} label="Setup commands" copyLabel="Copy setup commands" maxHeight="sm" />
                ) : (
                  <>
                    <SectionLabel className="mb-2">Setup commands</SectionLabel>
                    <p className="text-fg-muted">None.</p>
                  </>
                )}
              </div>
              <div className="border-t border-line-muted pt-4">
                <SectionLabel className="mb-2">Environment variables</SectionLabel>
                {env.length > 0 ? <KeyValueTable label="Environment variables" rows={env.map(([key, value]) => [key, value] as const)} /> : <p className="text-fg-muted">None. Secrets belong in vaults.</p>}
              </div>
            </div>
          ) : (
            <p className="text-fg-muted">Shared environments have no sandbox: their sessions run on the shared runtime.</p>
          )}
        </Card>
      )}

      <VaultsCard vaults={environment.vaults} />

      <Card title="Automation and delivery" icon={WorkflowIcon}>
        <FieldGrid columns={2}>
          <Field label="Agent scheduling" hint="scheduling: true lets agents schedule follow-up work">
            <YesNo value={environment.scheduling} yes="Allowed" no="Not allowed" />
          </Field>
          <Field label="Promotes to">
            {environment.promoteTo ? (
              <Link href={hrefs.environment(environment.promoteTo)} className="Link font-mono text-xs">
                {environment.promoteTo}
              </Link>
            ) : undefined}
          </Field>
          <Field label="Webhooks" hint="AppHost webhooks that receive this environment's events">
            {environment.webhooks.length > 0 ? (
              <span className="flex flex-wrap items-center gap-2">
                <ChipList items={environment.webhooks} mono />
                <Link href={hrefs.view("webhooks")} className="Link text-xs">
                  View deliveries
                </Link>
              </span>
            ) : (
              <span className="text-fg-muted">None</span>
            )}
          </Field>
          <Field label="AppHost schedules">
            {environment.schedules.length > 0 ? (
              <span className="flex flex-wrap items-center gap-2">
                <ChipList items={environment.schedules} mono />
                <Link href={hrefs.view("schedules")} className="Link text-xs">
                  View schedules
                </Link>
              </span>
            ) : (
              <span className="text-fg-muted">None</span>
            )}
          </Field>
        </FieldGrid>
      </Card>
    </div>
  );
}

function PackageList({ label, items, hint }: { readonly label: string; readonly items: readonly string[] | undefined; readonly hint?: string }) {
  return (
    <div className="min-w-0">
      <SectionLabel>{label}</SectionLabel>
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
      <div className="mt-2">{items && items.length > 0 ? <ChipList items={items} mono label={label} /> : <span className="text-fg-muted">None</span>}</div>
    </div>
  );
}

function VaultsCard({ vaults }: { readonly vaults: readonly OperatorVaultRef[] }) {
  return (
    <Card title="Vaults" icon={KeyIcon} description="Credentials sessions can use without seeing them. Values never leave the gateway." padded={vaults.length === 0}>
      {vaults.length === 0 ? (
        <p className="text-fg-muted">No vaults are bound to this environment.</p>
      ) : (
        <ul>
          {vaults.map((vault) => (
            <li key={vault.name} className="Box-row">
              <div className="flex flex-wrap items-center gap-2">
                <KeyIcon size={16} className="text-fg-muted" />
                <span className="font-mono font-semibold">{vault.name}</span>
                <StatusBadge meta={vault.configured ? healthMeta("healthy") : healthMeta("unavailable")}>{vault.configured ? "Configured" : "Missing secrets"}</StatusBadge>
                {!vault.configured ? <span className="text-xs text-fg-danger">The gateway doesn&apos;t have every secret this vault references.</span> : null}
              </div>
              {vault.credentials.length > 0 ? (
                <div className="Table-container mt-3">
                  <table className="Table Table--condensed" aria-label={`Credentials in ${vault.name}`}>
                    <thead>
                      <tr>
                        <th scope="col">Used as</th>
                        <th scope="col">Sent to</th>
                        <th scope="col">Headers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vault.credentials.map((credential, index) => (
                        <tr key={index} className="align-top">
                          <td>
                            {credential.env ? (
                              <span>
                                <span className="text-fg-muted">Env </span>
                                <Code>{credential.env}</Code>
                              </span>
                            ) : credential.mcpServer ? (
                              <span>MCP server</span>
                            ) : (
                              <None />
                            )}
                          </td>
                          <td>
                            {credential.mcpServer ? (
                              <span className="font-mono text-xs break-all">{credential.mcpServer}</span>
                            ) : credential.hosts && credential.hosts.length > 0 ? (
                              <ChipList items={credential.hosts} mono />
                            ) : (
                              <None />
                            )}
                          </td>
                          <td>
                            {credential.headers && credential.headers.length > 0 ? (
                              <ChipList items={credential.headers} mono />
                            ) : credential.header ? (
                              <Chip mono>{credential.header}</Chip>
                            ) : (
                              <span className="text-fg-muted">Default</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Harness (tool policy)

function HarnessTab({ policy }: { readonly policy: OperatorToolPolicy }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Built-in tools" icon={ToolsIcon} description="Runtime tools sessions in this environment may use.">
          {policy.builtins === "all" ? (
            <div>
              <p className="font-semibold">All workload tools</p>
              <p className="mt-1 text-fg-muted">Sandboxed sessions may use every built-in runtime tool inside their sandbox.</p>
            </div>
          ) : policy.builtins.length > 0 ? (
            <div>
              <p className="mb-2 text-fg-muted">{formatNumber(policy.builtins.length)} session-safe tools (the shared-placement allowlist).</p>
              <ChipList items={policy.builtins} mono label="Built-in tools" />
            </div>
          ) : (
            <p className="text-fg-muted">No built-in tools.</p>
          )}
        </Card>
        <Card title="MCP servers" icon={McpIcon}>
          {policy.mcp === "any" ? (
            <div>
              <p className="font-semibold">Any MCP server inside the sandbox</p>
              <p className="mt-1 text-fg-muted">Local and remote servers run within the sandbox&apos;s network policy.</p>
            </div>
          ) : (
            <div>
              <p className="font-semibold">Remote http/sse MCP servers through the gateway</p>
              <p className="mt-1 text-fg-muted">The gateway&apos;s MCP adapter applies network policy and vault credentials. Local (stdio) servers are not allowed.</p>
            </div>
          )}
        </Card>
      </div>
      <Card title="Platform tools" icon={PackageIcon} description="Tools the gateway injects into sessions, by placement." padded={policy.platform.length === 0}>
        {policy.platform.length === 0 ? (
          <p className="text-fg-muted">None.</p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="Table" aria-label="Platform tools">
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Description</th>
                  <th scope="col">Placements</th>
                </tr>
              </thead>
              <tbody>
                {policy.platform.map((tool) => (
                  <tr key={tool.name} className="align-top">
                    <td className="font-mono text-xs font-semibold">{tool.name}</td>
                    <td className="text-fg-muted">{tool.description}</td>
                    <td>
                      <ChipList items={tool.placements.map((placement) => (placement === "shared" ? "Shared runtime" : "Sandbox"))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Enforced settings" icon={ChecklistIcon} description="Applied by the platform regardless of what callers ask for.">
        {policy.enforced.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 marker:text-fg-muted">
            {policy.enforced.map((setting) => (
              <li key={setting} className="break-words">
                {setting}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-fg-muted">None.</p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Customizations

function fileHref(environment: string, path: string): string {
  return hrefs.environment(environment, { tab: "customizations", file: path });
}

function CustomizationsTab({ environment, query }: { readonly environment: OperatorEnvironment; readonly query: Query }) {
  const customizations = environment.customizations;
  if (!customizations) {
    return (
      <div className="Box">
        <EmptyState icon={FileDirectoryFillIcon} title="No customizations" spacious>
          This environment deploys no customizations folder. Set <Code>customizations</Code> on the environment in the AppHost to deploy agents, skills, and instructions with it.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {customizations.problem ? (
        <Callout tone="danger" title="Sessions in this environment fail (policy_violation)">
          {customizations.problem}
        </Callout>
      ) : null}
      <Card title="Source" icon={FileDirectoryIcon}>
        <FieldGrid columns={2}>
          <Field label="Folder (as declared)" mono>
            {customizations.source}
          </Field>
          <Field label="Pinned digest" hint="The copy sessions use">
            {customizations.digest ? (
              <span className="inline-flex max-w-full items-center gap-1">
                <span className="min-w-0 font-mono text-xs break-all">{customizations.digest}</span>
                <CopyButton text={customizations.digest} label="Copy digest" className="size-6" />
              </span>
            ) : undefined}
          </Field>
        </FieldGrid>
      </Card>
      <CustomizationLists environment={environment.name} customizations={customizations} />
      <FilesCard environment={environment.name} customizations={customizations} query={query} />
    </div>
  );
}

function FileLink({ environment, path, children }: { readonly environment: string; readonly path: string | undefined; readonly children: ReactNode }) {
  if (!path) return <>{children}</>;
  return (
    <Link href={fileHref(environment, path)} replace title={`Open ${path}`} className="Link">
      {children}
    </Link>
  );
}

function CountTitle({ label, count }: { readonly label: string; readonly count: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      {label}
      <span className="Counter">{count}</span>
    </span>
  );
}

function CustomizationLists({ environment, customizations }: { readonly environment: string; readonly customizations: OperatorCustomizations }) {
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title={<CountTitle label="Agents" count={customizations.agents.length} />} icon={AgentIcon} padded={customizations.agents.length === 0}>
        {customizations.agents.length === 0 ? (
          <p className="text-fg-muted">None.</p>
        ) : (
          <ul>
            {customizations.agents.map((agent) => (
              <li key={agent.name} className="Box-row px-4 py-3">
                <p className="font-semibold">
                  <FileLink environment={environment} path={agent.file}>
                    {agent.name}
                  </FileLink>
                </p>
                {agent.description ? <p className="mt-0.5 text-xs text-fg-muted">{agent.description}</p> : null}
                {agent.model || (agent.tools ?? []).length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {agent.model ? (
                      <Chip mono title="Model">
                        {agent.model}
                      </Chip>
                    ) : null}
                    {(agent.tools ?? []).map((tool) => (
                      <Chip key={tool} mono title="Tool">
                        {tool}
                      </Chip>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={<CountTitle label="Skills" count={customizations.skills.length} />} icon={SparkleFillIcon} padded={customizations.skills.length === 0}>
        {customizations.skills.length === 0 ? (
          <p className="text-fg-muted">None.</p>
        ) : (
          <ul>
            {customizations.skills.map((skill) => (
              <li key={skill.name} className="Box-row px-4 py-3">
                <p className="font-semibold">
                  <FileLink environment={environment} path={skill.file}>
                    {skill.name}
                  </FileLink>
                </p>
                {skill.description ? <p className="mt-0.5 text-xs text-fg-muted">{skill.description}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={<CountTitle label="Instructions" count={customizations.instructions.length} />} icon={BookIcon} padded={customizations.instructions.length === 0}>
        {customizations.instructions.length === 0 ? (
          <p className="text-fg-muted">None.</p>
        ) : (
          <ul>
            {customizations.instructions.map((instruction) => (
              <li key={instruction.file} className="Box-row px-4 py-3 font-mono text-xs">
                <FileLink environment={environment} path={instruction.file}>
                  {instruction.file}
                </FileLink>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const KIND_ICONS = { agent: AgentIcon, skill: SparkleFillIcon, instruction: BookIcon, other: FileIcon } as const;

/** The deployed bundle as github.com's code view shows a repository: a file tree beside the open file. */
function FilesCard({ environment, customizations, query }: { readonly environment: string; readonly customizations: OperatorCustomizations; readonly query: Query }) {
  const files = customizations.files;
  const tree = useMemo(() => buildFileTree(files), [files]);
  const selectedPath = query["file"];
  const selected = files.find((file) => file.path === selectedPath);
  return (
    <Card title={<CountTitle label="Files" count={files.length} />} icon={FileCodeIcon} description={`${formatNumber(files.length)} files in the deployed bundle.`} padded={false}>
      {files.length === 0 ? (
        <p className="p-4 text-fg-muted">The folder is empty.</p>
      ) : (
        <div className="grid min-h-[24rem] lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label="Customization files" className="max-h-[36rem] overflow-y-auto border-b border-line p-2 lg:border-r lg:border-b-0">
            <FileTree nodes={tree} environment={environment} selected={selectedPath} />
          </nav>
          <div className="min-w-0">
            {selected ? (
              <FileViewer key={selected.path} environment={environment} file={selected} query={query} />
            ) : selectedPath ? (
              <EmptyState icon={FileIcon} title="File not in this bundle" compact>
                <Code>{selectedPath}</Code> isn&apos;t one of this environment&apos;s deployed files.
              </EmptyState>
            ) : (
              <EmptyState icon={FileIcon} title="Select a file" compact>
                Choose a file on the left to read it.
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function FileTree({ nodes, environment, selected }: { readonly nodes: readonly FileTreeNode[]; readonly environment: string; readonly selected: string | undefined }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([...nodes.filter((node) => !node.file).map((node) => node.path), ...(selected ? ancestorFolders(selected) : [])]));
  const toggle = (path: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const render = (list: readonly FileTreeNode[], depth: number): ReactNode => (
    <ul className="space-y-px">
      {list.map((node) => {
        if (!node.file) {
          const open = expanded.has(node.path);
          const FolderIcon = open ? FileDirectoryOpenFillIcon : FileDirectoryFillIcon;
          return (
            <li key={node.path}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(node.path)}
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
                className="flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm hover:bg-control-transparent-hover"
              >
                <ChevronRightIcon size={16} className={cx("shrink-0 text-fg-muted transition-transform duration-150", open && "rotate-90")} />
                <FolderIcon size={16} className="shrink-0 text-(--treeViewItem-leadingVisual-iconColor-rest)" />
                <span className="truncate">{node.name}</span>
              </button>
              {open ? render(node.children, depth + 1) : null}
            </li>
          );
        }
        const active = node.path === selected;
        const KindIcon = KIND_ICONS[node.file.kind] ?? FileCodeIcon;
        return (
          <li key={node.path}>
            <Link
              href={fileHref(environment, node.path)}
              replace
              aria-current={active ? "true" : undefined}
              style={{ paddingLeft: `${depth * 16 + 24}px` }}
              className={cx(
                "relative flex h-8 items-center gap-1.5 rounded-md pr-2 text-sm text-fg hover:bg-control-transparent-hover",
                active && "bg-control-transparent-selected font-semibold before:absolute before:inset-y-1.5 before:left-0 before:w-1 before:rounded-md before:bg-accent-emphasis",
              )}
            >
              <KindIcon size={16} className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="shrink-0 text-xs font-normal text-fg-muted tabular-nums">{formatBytes(node.file.size)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
  return <>{render(nodes, 0)}</>;
}

function FileViewer({ environment, file, query }: { readonly environment: string; readonly file: CustomizationFileInfo; readonly query: Query }) {
  const poll = usePoll(`environment-file:${environment}:${file.path}`, (signal) => getEnvironmentFile(environment, file.path, signal), { intervalMs: 0 });
  const setQuery = useQueryUpdater();
  const markdown = isMarkdownPath(file.path);
  const mode = query["view"] === "source" || !markdown ? "source" : "rendered";
  const readable = poll.data !== undefined && !poll.data.binary;
  return (
    <div className="min-w-0">
      <div className="file-header flex-wrap gap-y-1 rounded-none pr-2">
        {markdown && readable ? (
          <Segmented
            label="Show the file as"
            size="sm"
            value={mode}
            onChange={(value) => setQuery({ view: value === "source" ? "source" : undefined })}
            options={[
              { value: "rendered", label: "Preview" },
              { value: "source", label: "Code" },
            ]}
            className="font-sans"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate" title={file.path}>
          {file.path}
        </span>
        <span className="font-sans">
          <Chip>{file.kind}</Chip>
        </span>
        <span className="font-sans text-xs text-fg-muted tabular-nums">{formatBytes(file.size)}</span>
        {poll.data && !poll.data.binary && poll.data.content ? <CopyButton text={poll.data.content} label="Copy file contents" /> : null}
      </div>
      {poll.data === undefined && poll.error ? (
        <ErrorState title="Couldn't load this file" message={poll.error.message} onRetry={() => void poll.refresh()} retrying={poll.loading} />
      ) : poll.data === undefined ? (
        <div className="p-4" role="status" aria-label="Loading the file">
          <SkeletonLines lines={4} />
        </div>
      ) : poll.data.binary ? (
        <EmptyState icon={FileCodeIcon} title="Binary file not shown" compact>
          This file is {formatBytes(poll.data.size)}.
        </EmptyState>
      ) : (
        <>
          {poll.data.truncated ? (
            <Callout tone="attention" small className="m-3 mb-0">
              This file is {formatBytes(poll.data.size)}; the console shows only its beginning.
            </Callout>
          ) : null}
          {poll.data.content.length === 0 ? (
            <p className="p-4 text-fg-muted">This file is empty.</p>
          ) : mode === "rendered" ? (
            <RenderedMarkdown content={poll.data.content} />
          ) : (
            <CodeLines text={poll.data.content} label={file.path} />
          )}
        </>
      )}
    </div>
  );
}

function RenderedMarkdown({ content }: { readonly content: string }) {
  const parsed = useMemo(() => parseFrontmatter(content), [content]);
  return (
    <div className="space-y-4 p-4 md:p-6">
      {parsed.frontmatter.length > 0 ? (
        <div className="Table-container">
          <table className="Table Table--condensed" aria-label="Frontmatter">
            <thead>
              <tr>
                <th scope="col">Frontmatter</th>
                <th scope="col">
                  <span className="sr-only">Value</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {parsed.frontmatter.map((entry, index) => (
                <tr key={`${entry.key}-${index}`}>
                  <th scope="row" className="w-40 font-mono text-xs text-fg-muted">
                    {entry.key}
                  </th>
                  <td className="font-mono text-xs break-words whitespace-pre-wrap">{entry.value || <None />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <MarkdownView source={parsed.body} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

function SessionsTab({ environment }: { readonly environment: OperatorEnvironment }) {
  const filters = { environment: environment.name, limit: 50 };
  const poll = usePoll(`sessions${buildSearch(filters)}`, (signal) => listSessions(filters, signal));
  return (
    <Card
      title="Sessions"
      icon={CommentDiscussionIcon}
      description={`${formatNumber(environment.sessions.total)} total · ${formatNumber(environment.sessions.live)} live`}
      padded={false}
      actions={
        <Link href={hrefs.view("sessions", { environment: environment.name })} className="Link inline-flex items-center gap-1 text-sm">
          Open in Sessions
          <ArrowRightIcon size={16} />
        </Link>
      }
    >
      <PollContent poll={poll} skeleton={<TableSkeleton columns={6} rows={4} />} errorTitle="Couldn't load sessions">
        {(sessions) => (
          <SessionsTable
            sessions={sessions}
            empty={
              <EmptyState icon={CommentDiscussionIcon} title="No sessions in this environment" compact>
                Sessions appear here when clients create them in <Code>{environment.name}</Code>.
              </EmptyState>
            }
          />
        )}
      </PollContent>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="grid gap-6 xl:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="Box">
            <div className="Box-header">
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="p-4">
              <SkeletonLines lines={2} />
            </div>
          </div>
        ))}
      </div>
      <div className="Box">
        <div className="Box-header">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="p-4">
          <SkeletonLines lines={6} />
        </div>
      </div>
    </div>
  );
}
