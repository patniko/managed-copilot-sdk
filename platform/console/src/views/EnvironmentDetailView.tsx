import type { CustomizationFileInfo, OperatorCustomizations, OperatorEnvironment, OperatorToolPolicy, OperatorVaultRef } from "@managed-copilot/protocol/operator";
import { ArrowRight, Bot, BookOpen, Box, ChevronRight, FileCode, FileText, Folder, FolderOpen, KeyRound, Layers, ListChecks, ScrollText, Sparkles, Wrench } from "lucide-react";
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
import { Card, Field, FieldGrid, KeyValueTable } from "../components/ui/Card.js";
import { Chip, StatusBadge } from "../components/ui/Chip.js";
import { CodeBlock } from "../components/ui/CodeBlock.js";
import { Segmented, Tabs } from "../components/ui/Controls.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { TableSkeleton } from "../components/ui/DataTable.js";
import { Callout, EmptyState, ErrorState, None, Skeleton } from "../components/ui/Feedback.js";
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
      title={<span className="font-mono">{name}</span>}
      documentTitle={`${name} · Environments`}
      icon={Layers}
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
            { id: "policy", label: "Policy" },
            { id: "harness", label: "Harness" },
            { id: "customizations", label: "Customizations", count: environment?.customizations?.files.length, countTone: environment?.customizations?.problem ? "danger" : undefined },
            { id: "sessions", label: "Sessions", count: environment?.sessions.total },
          ]}
        />
      }
    >
      <PollContent
        poll={poll}
        skeleton={<DetailSkeleton />}
        errorTitle="Couldn't load this environment"
        notFound={() => (
          <EmptyState
            icon={Layers}
            title="Environment not found"
            action={
              <Link href={hrefs.view("environments")} className="text-[13px] font-medium text-sky-300 hover:underline hover:underline-offset-2">
                Back to environments
              </Link>
            }
          >
            No environment named <code className="font-mono text-zinc-300">{name}</code> is declared in this deployment.
          </EmptyState>
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
  const sandboxed = environment.type !== "shared";
  const env = Object.entries(environment.env ?? {});
  return (
    <div className="space-y-5">
      {environment.customizations?.problem ? (
        <Callout tone="danger" title="Sessions in this environment fail">
          {environment.customizations.problem}
        </Callout>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Models">
          {environment.models && environment.models.length > 0 ? (
            <ChipList items={environment.models} mono label="Allowed models" />
          ) : (
            <p className="text-[13px] text-zinc-300">Every model the caller&apos;s Copilot entitlement offers.</p>
          )}
        </Card>
        <Card title="Network ceiling" description="Callers can narrow this policy, never broaden it.">
          <NetworkPolicyView policy={environment.network} />
        </Card>
      </div>

      <Card title="Sandbox" icon={Box} description={sandboxed ? "What each session's sandbox is built from." : undefined}>
        {sandboxed ? (
          <div className="space-y-5">
            <FieldGrid columns={4}>
              <Field label="Size">{formatSize(environment.size, environment.resources)}</Field>
              <Field label="Idle timeout" hint="Before an idle sandbox may stop compute">
                {environment.idleTimeoutSeconds !== undefined ? formatDuration(environment.idleTimeoutSeconds) : <span className="text-zinc-500">Backend default</span>}
              </Field>
              <Field label="Warm instances">{environment.warm !== undefined ? formatNumber(environment.warm) : <span className="text-zinc-500">None</span>}</Field>
              <Field label="Inference">{environment.inference ? <span className="font-mono text-[12px]">Foundry: {environment.inference.foundry}</span> : <span className="text-zinc-500">Through GitHub Copilot</span>}</Field>
              <Field label="Image" wide>
                {environment.image ? (
                  <span className="inline-flex max-w-full items-center gap-1">
                    <span className="min-w-0 font-mono text-[12px] break-all">{environment.image}</span>
                    <CopyButton text={environment.image} label="Copy image" />
                  </span>
                ) : (
                  <span className="text-zinc-500">The platform&apos;s default sandbox image</span>
                )}
              </Field>
            </FieldGrid>
            <div className="grid gap-5 lg:grid-cols-3">
              <PackageList label="Python packages" items={environment.packages?.python} />
              <PackageList label="npm packages" items={environment.packages?.npm} />
              <PackageList label="System packages" items={environment.packages?.system} hint="Installed when the image is prepared" />
            </div>
            <div>
              <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Setup commands</h3>
              {environment.setupCommands && environment.setupCommands.length > 0 ? (
                <CodeBlock text={environment.setupCommands.join("\n")} label="Setup commands" copyLabel="Copy setup commands" maxHeight="sm" />
              ) : (
                <p className="text-[13px] text-zinc-500">None.</p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Environment variables</h3>
              {env.length > 0 ? (
                <KeyValueTable label="Environment variables" rows={env.map(([key, value]) => [key, value] as const)} />
              ) : (
                <p className="text-[13px] text-zinc-500">None. Secrets belong in vaults.</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-zinc-400">Shared environments have no sandbox: their sessions run on the shared runtime.</p>
        )}
      </Card>

      <VaultsCard vaults={environment.vaults} />

      <Card title="Automation and delivery">
        <FieldGrid columns={2}>
          <Field label="Agent scheduling" hint="scheduling: true lets agents schedule follow-up work">
            <YesNo value={environment.scheduling} yes="Allowed" no="Not allowed" />
          </Field>
          <Field label="Promotes to">
            {environment.promoteTo ? (
              <Link href={hrefs.environment(environment.promoteTo)} className="font-mono text-[12px] text-sky-300 hover:underline hover:underline-offset-2">
                {environment.promoteTo}
              </Link>
            ) : undefined}
          </Field>
          <Field label="Webhooks" hint="AppHost webhooks that receive this environment's events">
            {environment.webhooks.length > 0 ? (
              <span className="flex flex-wrap items-center gap-2">
                <ChipList items={environment.webhooks} mono />
                <Link href={hrefs.view("webhooks")} className="text-[12px] text-sky-300 hover:underline hover:underline-offset-2">
                  View deliveries
                </Link>
              </span>
            ) : (
              <span className="text-zinc-500">None</span>
            )}
          </Field>
          <Field label="AppHost schedules">
            {environment.schedules.length > 0 ? (
              <span className="flex flex-wrap items-center gap-2">
                <ChipList items={environment.schedules} mono />
                <Link href={hrefs.view("schedules")} className="text-[12px] text-sky-300 hover:underline hover:underline-offset-2">
                  View schedules
                </Link>
              </span>
            ) : (
              <span className="text-zinc-500">None</span>
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
      <h3 className="text-[12px] font-semibold text-zinc-300">{label}</h3>
      {hint ? <p className="text-[11.5px] text-zinc-500">{hint}</p> : null}
      <div className="mt-2">{items && items.length > 0 ? <ChipList items={items} mono label={label} /> : <span className="text-[13px] text-zinc-500">None</span>}</div>
    </div>
  );
}

function VaultsCard({ vaults }: { readonly vaults: readonly OperatorVaultRef[] }) {
  return (
    <Card title="Vaults" icon={KeyRound} description="Credentials sessions can use without seeing them. Values never leave the gateway." padded={vaults.length === 0}>
      {vaults.length === 0 ? (
        <p className="text-[13px] text-zinc-500">No vaults are bound to this environment.</p>
      ) : (
        <ul className="divide-y divide-zinc-800/70">
          {vaults.map((vault) => (
            <li key={vault.name} className="px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-semibold text-zinc-100">{vault.name}</span>
                <StatusBadge meta={vault.configured ? healthMeta("healthy") : healthMeta("unavailable")} size="xs">
                  {vault.configured ? "Configured" : "Missing secrets"}
                </StatusBadge>
                {!vault.configured ? <span className="text-[12px] text-rose-200/80">The gateway doesn&apos;t have every secret this vault references.</span> : null}
              </div>
              {vault.credentials.length > 0 ? (
                <div className="mt-2.5 overflow-x-auto rounded-lg border border-zinc-800/80">
                  <table className="w-full text-left text-[12.5px]" aria-label={`Credentials in ${vault.name}`}>
                    <thead className="bg-zinc-900/60 text-[11px] uppercase tracking-[0.06em] text-zinc-500">
                      <tr>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          Used as
                        </th>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          Sent to
                        </th>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          Headers
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {vault.credentials.map((credential, index) => (
                        <tr key={index} className="border-t border-zinc-800/60 align-top">
                          <td className="px-3 py-2">
                            {credential.env ? (
                              <span>
                                <span className="text-zinc-500">Env </span>
                                <code className="font-mono text-zinc-200">{credential.env}</code>
                              </span>
                            ) : credential.mcpServer ? (
                              <span className="text-zinc-300">MCP server</span>
                            ) : (
                              <None />
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {credential.mcpServer ? (
                              <span className="font-mono break-all text-zinc-200">{credential.mcpServer}</span>
                            ) : credential.hosts && credential.hosts.length > 0 ? (
                              <ChipList items={credential.hosts} mono />
                            ) : (
                              <None />
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {credential.headers && credential.headers.length > 0 ? (
                              <ChipList items={credential.headers} mono />
                            ) : credential.header ? (
                              <Chip mono>{credential.header}</Chip>
                            ) : (
                              <span className="text-zinc-500">Default</span>
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
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Built-in tools" icon={Wrench} description="Runtime tools sessions in this environment may use.">
          {policy.builtins === "all" ? (
            <div>
              <p className="text-[13px] font-medium text-zinc-100">All workload tools</p>
              <p className="mt-1 text-[12.5px] text-zinc-500">Sandboxed sessions may use every built-in runtime tool inside their sandbox.</p>
            </div>
          ) : policy.builtins.length > 0 ? (
            <div>
              <p className="mb-2 text-[12.5px] text-zinc-500">{formatNumber(policy.builtins.length)} session-safe tools (the shared-placement allowlist).</p>
              <ChipList items={policy.builtins} mono label="Built-in tools" />
            </div>
          ) : (
            <p className="text-[13px] text-zinc-400">No built-in tools.</p>
          )}
        </Card>
        <Card title="MCP servers" icon={Sparkles}>
          {policy.mcp === "any" ? (
            <div>
              <p className="text-[13px] font-medium text-zinc-100">Any MCP server inside the sandbox</p>
              <p className="mt-1 text-[12.5px] text-zinc-500">Local and remote servers run within the sandbox&apos;s network policy.</p>
            </div>
          ) : (
            <div>
              <p className="text-[13px] font-medium text-zinc-100">Remote http/sse MCP servers through the gateway</p>
              <p className="mt-1 text-[12.5px] text-zinc-500">The gateway&apos;s MCP adapter applies network policy and vault credentials. Local (stdio) servers are not allowed.</p>
            </div>
          )}
        </Card>
      </div>
      <Card title="Platform tools" icon={Box} description="Tools the gateway injects into sessions, by placement." padded={policy.platform.length === 0}>
        {policy.platform.length === 0 ? (
          <p className="text-[13px] text-zinc-500">None.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]" aria-label="Platform tools">
              <thead className="border-b border-zinc-800 text-[11px] uppercase tracking-[0.06em] text-zinc-500">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Tool
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Description
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Placements
                  </th>
                </tr>
              </thead>
              <tbody>
                {policy.platform.map((tool) => (
                  <tr key={tool.name} className="border-b border-zinc-800/60 align-top last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-zinc-100">{tool.name}</td>
                    <td className="px-3 py-2.5 text-zinc-400">{tool.description}</td>
                    <td className="px-4 py-2.5">
                      <ChipList items={tool.placements.map((placement) => (placement === "shared" ? "Shared runtime" : "Sandbox"))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Enforced settings" icon={ListChecks} description="Applied by the platform regardless of what callers ask for.">
        {policy.enforced.length > 0 ? (
          <ul className="space-y-1.5 text-[13px] text-zinc-300">
            {policy.enforced.map((setting) => (
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
      <Card>
        <EmptyState icon={FolderOpen} title="No customizations">
          This environment deploys no customizations folder. Set <code className="font-mono text-zinc-300">customizations</code> on the environment in the AppHost to deploy agents,
          skills, and instructions with it.
        </EmptyState>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      {customizations.problem ? (
        <Callout tone="danger" title="Sessions in this environment fail (policy_violation)">
          {customizations.problem}
        </Callout>
      ) : null}
      <Card title="Source">
        <FieldGrid columns={2}>
          <Field label="Folder (as declared)" mono>
            {customizations.source}
          </Field>
          <Field label="Pinned digest" hint="The copy sessions use">
            {customizations.digest ? (
              <span className="inline-flex max-w-full items-center gap-1">
                <span className="min-w-0 font-mono text-[12px] break-all">{customizations.digest}</span>
                <CopyButton text={customizations.digest} label="Copy digest" />
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
    <Link href={fileHref(environment, path)} replace title={`Open ${path}`} className="text-sky-300 hover:text-sky-200 hover:underline hover:underline-offset-2">
      {children}
    </Link>
  );
}

function CustomizationLists({ environment, customizations }: { readonly environment: string; readonly customizations: OperatorCustomizations }) {
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Card title={`Agents (${customizations.agents.length})`} icon={Bot} padded={customizations.agents.length === 0}>
        {customizations.agents.length === 0 ? (
          <p className="text-[13px] text-zinc-500">None.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {customizations.agents.map((agent) => (
              <li key={agent.name} className="px-4 py-3">
                <p className="text-[13px] font-semibold text-zinc-100">
                  <FileLink environment={environment} path={agent.file}>
                    {agent.name}
                  </FileLink>
                </p>
                {agent.description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400">{agent.description}</p> : null}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {agent.model ? <Chip mono title="Model">{agent.model}</Chip> : null}
                  {(agent.tools ?? []).map((tool) => (
                    <Chip key={tool} mono title="Tool">
                      {tool}
                    </Chip>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Skills (${customizations.skills.length})`} icon={Sparkles} padded={customizations.skills.length === 0}>
        {customizations.skills.length === 0 ? (
          <p className="text-[13px] text-zinc-500">None.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {customizations.skills.map((skill) => (
              <li key={skill.name} className="px-4 py-3">
                <p className="text-[13px] font-semibold text-zinc-100">
                  <FileLink environment={environment} path={skill.file}>
                    {skill.name}
                  </FileLink>
                </p>
                {skill.description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400">{skill.description}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Instructions (${customizations.instructions.length})`} icon={BookOpen} padded={customizations.instructions.length === 0}>
        {customizations.instructions.length === 0 ? (
          <p className="text-[13px] text-zinc-500">None.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {customizations.instructions.map((instruction) => (
              <li key={instruction.file} className="px-4 py-3 font-mono text-[12px] text-zinc-200">
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

const KIND_ICONS = { agent: Bot, skill: Sparkles, instruction: BookOpen, other: FileText } as const;

function FilesCard({ environment, customizations, query }: { readonly environment: string; readonly customizations: OperatorCustomizations; readonly query: Query }) {
  const files = customizations.files;
  const tree = useMemo(() => buildFileTree(files), [files]);
  const selectedPath = query["file"];
  const selected = files.find((file) => file.path === selectedPath);
  return (
    <Card title="Files" icon={ScrollText} description={`${formatNumber(files.length)} files in the deployed bundle.`} padded={false}>
      {files.length === 0 ? (
        <p className="p-4 text-[13px] text-zinc-500">The folder is empty.</p>
      ) : (
        <div className="grid min-h-[24rem] lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label="Customization files" className="max-h-[36rem] overflow-y-auto border-b border-zinc-800/70 p-2 lg:border-r lg:border-b-0">
            <FileTree nodes={tree} environment={environment} selected={selectedPath} />
          </nav>
          <div className="min-w-0 p-4">
            {selected ? (
              <FileViewer key={selected.path} environment={environment} file={selected} query={query} />
            ) : selectedPath ? (
              <EmptyState icon={FileText} title="File not in this bundle" compact>
                <code className="font-mono">{selectedPath}</code> isn&apos;t one of this environment&apos;s deployed files.
              </EmptyState>
            ) : (
              <EmptyState icon={FileText} title="Select a file" compact>
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
        const indent = { paddingLeft: `${depth * 14 + 8}px` };
        if (!node.file) {
          const open = expanded.has(node.path);
          const FolderIcon = open ? FolderOpen : Folder;
          return (
            <li key={node.path}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(node.path)}
                style={indent}
                className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] text-zinc-300 hover:bg-zinc-800/60"
              >
                <ChevronRight className={cx("size-3 shrink-0 text-zinc-500 transition-transform", open && "rotate-90")} aria-hidden />
                <FolderIcon className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                <span className="truncate">{node.name}</span>
              </button>
              {open ? render(node.children, depth + 1) : null}
            </li>
          );
        }
        const active = node.path === selected;
        const Icon = KIND_ICONS[node.file.kind] ?? FileCode;
        return (
          <li key={node.path}>
            <Link
              href={fileHref(environment, node.path)}
              replace
              aria-current={active ? "true" : undefined}
              style={{ paddingLeft: `${depth * 14 + 26}px` }}
              className={cx(
                "flex h-7 items-center gap-1.5 rounded-md pr-2 text-[12.5px]",
                active ? "bg-zinc-800 text-zinc-50 ring-1 ring-inset ring-white/10" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
              )}
            >
              <Icon className={cx("size-3.5 shrink-0", active ? "text-amber-300" : "text-zinc-500")} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="shrink-0 text-[10.5px] text-zinc-600 tabular">{formatBytes(node.file.size)}</span>
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
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[12.5px] text-zinc-100" title={file.path}>
          {file.path}
        </span>
        <Chip>{file.kind}</Chip>
        <span className="text-[12px] text-zinc-500 tabular">{formatBytes(file.size)}</span>
        <div className="ml-auto flex items-center gap-2">
          {markdown && poll.data && !poll.data.binary ? (
            <Segmented
              label="Show the file as"
              value={mode}
              onChange={(value) => setQuery({ view: value === "source" ? "source" : undefined })}
              options={[
                { value: "rendered", label: "Rendered" },
                { value: "source", label: "Source" },
              ]}
            />
          ) : null}
          {poll.data && !poll.data.binary && poll.data.content ? <CopyButton text={poll.data.content} label="Copy file contents" size="sm" variant="secondary" /> : null}
        </div>
      </div>
      {poll.data === undefined && poll.error ? (
        <ErrorState title="Couldn't load this file" message={poll.error.message} onRetry={() => void poll.refresh()} retrying={poll.loading} />
      ) : poll.data === undefined ? (
        <div className="space-y-2.5" role="status" aria-label="Loading the file">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : poll.data.binary ? (
        <Callout tone="neutral" icon={FileCode}>
          Binary file ({formatBytes(poll.data.size)}) — not shown.
        </Callout>
      ) : (
        <>
          {poll.data.truncated ? (
            <Callout tone="warning" className="mb-3">
              This file is {formatBytes(poll.data.size)}; the console shows only its beginning.
            </Callout>
          ) : null}
          {poll.data.content.length === 0 ? (
            <p className="text-[13px] text-zinc-500">This file is empty.</p>
          ) : mode === "rendered" ? (
            <RenderedMarkdown content={poll.data.content} />
          ) : (
            <CodeBlock text={poll.data.content} label={file.path} copyLabel="Copy file contents" maxHeight="lg" />
          )}
        </>
      )}
    </div>
  );
}

function RenderedMarkdown({ content }: { readonly content: string }) {
  const parsed = useMemo(() => parseFrontmatter(content), [content]);
  return (
    <div className="space-y-4">
      {parsed.frontmatter.length > 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60">
          <p className="border-b border-zinc-800 px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">Frontmatter</p>
          <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-3.5 py-3 text-[12.5px]">
            {parsed.frontmatter.map((entry, index) => (
              <div key={`${entry.key}-${index}`} className="contents">
                <dt className="font-mono text-zinc-500">{entry.key}</dt>
                <dd className="min-w-0 font-mono break-words whitespace-pre-wrap text-zinc-200">{entry.value || <None />}</dd>
              </div>
            ))}
          </dl>
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
      description={`${formatNumber(environment.sessions.total)} total · ${formatNumber(environment.sessions.live)} live`}
      padded={false}
      actions={
        <Link href={hrefs.view("sessions", { environment: environment.name })} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-sky-300 hover:underline hover:underline-offset-2">
          Open in Sessions
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      <PollContent poll={poll} skeleton={<TableSkeleton columns={6} rows={4} />} errorTitle="Couldn't load sessions">
        {(sessions) => (
          <SessionsTable
            sessions={sessions}
            empty={
              <EmptyState icon={Layers} title="No sessions in this environment" compact>
                Sessions appear here when clients create them in <code className="font-mono text-zinc-300">{environment.name}</code>.
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
    <div className="space-y-5" role="status" aria-label="Loading">
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}
