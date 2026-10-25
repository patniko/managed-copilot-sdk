import type { OperatorEnvironment, OperatorEnvironments } from "@managed-copilot/protocol/operator";
import { ArrowRight, CalendarClock, Cpu, Layers, TriangleAlert } from "lucide-react";
import { cx } from "../lib/cx.js";
import { formatNumber, formatSize, summarizeNetwork } from "../lib/format.js";
import { useEnvironments } from "../lib/resources.js";
import { hrefs } from "../lib/routes.js";
import { ENVIRONMENT_TYPES, EnvironmentTypeChip, NetworkPolicyView } from "../components/common/Entities.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { Chip } from "../components/ui/Chip.js";
import { EmptyState, Skeleton } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";

export function EnvironmentsView() {
  const poll = useEnvironments();
  return (
    <Page
      title="Environments"
      documentTitle="Environments"
      icon={Layers}
      description="Declared environments and the policy ceilings sessions run under."
      poll={poll}
    >
      <PollContent poll={poll} skeleton={<EnvironmentsSkeleton />} errorTitle="Couldn't load environments">
        {(data) => <EnvironmentsBody data={data} />}
      </PollContent>
    </Page>
  );
}

function EnvironmentsBody({ data }: { readonly data: OperatorEnvironments }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Inline environments" description="What code may request without naming an environment (inline in the AppHost).">
          {data.inline ? (
            <div className="space-y-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-14 text-zinc-500">Types</span>
                {data.inline.types.map((type) => (
                  <EnvironmentTypeChip key={type} type={type} />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-14 text-zinc-500">Sizes</span>
                {data.inline.sizes && data.inline.sizes.length > 0 ? (
                  data.inline.sizes.map((size) => <Chip key={size}>{formatSize(size)}</Chip>)
                ) : (
                  <span className="text-zinc-400">Any size</span>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-zinc-400">Not allowed: code must name a declared environment.</p>
          )}
        </Card>
        <Card title="Default network" description="The deployment-wide default (network at the top level of the AppHost).">
          <NetworkPolicyView policy={data.defaultNetwork} />
        </Card>
      </div>
      {data.environments.length === 0 ? (
        <Card>
          <EmptyState icon={Layers} title="No environments are declared">
            Declare environments under <code className="font-mono text-zinc-300">environments</code> in the AppHost&apos;s addManagedCopilot options.
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {data.environments.map((environment) => (
            <li key={environment.name} className="min-w-0">
              <EnvironmentCard environment={environment} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EnvironmentCard({ environment }: { readonly environment: OperatorEnvironment }) {
  const type = ENVIRONMENT_TYPES[environment.type];
  const TypeIcon = type?.icon ?? Layers;
  const network = summarizeNetwork(environment.network);
  const problem = environment.customizations?.problem;
  const size = formatSize(environment.size, environment.resources);
  return (
    <Link
      href={hrefs.environment(environment.name)}
      className={cx(
        "group flex h-full flex-col rounded-2xl border bg-zinc-900/40 p-4 transition-colors hover:bg-zinc-900/70",
        problem ? "border-rose-400/30 hover:border-rose-400/50" : "border-zinc-800/80 hover:border-zinc-700",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-800/80 text-zinc-300 ring-1 ring-inset ring-white/10" title={type?.description}>
          <TypeIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[14px] font-semibold text-zinc-50">{environment.name}</h2>
          <p className="text-[12px] text-zinc-500">{type?.label ?? environment.type}</p>
        </div>
        <ArrowRight className="mt-1 size-4 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-300" aria-hidden />
      </div>
      {environment.description ? <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-zinc-400">{environment.description}</p> : null}
      {problem ? (
        <p className="mt-3 flex gap-2 rounded-lg border border-rose-400/30 bg-rose-400/[0.07] px-2.5 py-2 text-[12.5px] leading-relaxed text-rose-100">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-rose-300" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium">Sessions fail: </span>
            {problem}
          </span>
        </p>
      ) : null}
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12.5px]">
        <dt className="text-zinc-500">Models</dt>
        <dd className="min-w-0 truncate text-zinc-200" title={environment.models?.join(", ")}>
          {environment.models && environment.models.length > 0 ? environment.models.join(", ") : "Every model the caller can use"}
        </dd>
        <dt className="text-zinc-500">Network</dt>
        <dd className="min-w-0 truncate text-zinc-200" title={network?.hosts.join(", ") || network?.description}>
          {network?.label}
        </dd>
        {size ? (
          <>
            <dt className="text-zinc-500">Size</dt>
            <dd className="flex min-w-0 items-center gap-1.5 text-zinc-200">
              <Cpu className="size-3.5 text-zinc-500" aria-hidden />
              {size}
            </dd>
          </>
        ) : null}
        {environment.promoteTo ? (
          <>
            <dt className="text-zinc-500">Promotes to</dt>
            <dd className="font-mono text-zinc-200">{environment.promoteTo}</dd>
          </>
        ) : null}
      </dl>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-[12px]">
        <span className="text-zinc-300 tabular">
          {formatNumber(environment.sessions.total)} {environment.sessions.total === 1 ? "session" : "sessions"}
        </span>
        <span className="text-zinc-500">·</span>
        <span className={cx("tabular", environment.sessions.live > 0 ? "text-emerald-300" : "text-zinc-500")}>{formatNumber(environment.sessions.live)} live</span>
        {environment.scheduling ? (
          <Chip icon={CalendarClock} className="ml-auto" title="Agents may schedule follow-up work (scheduling: true)">
            Scheduling
          </Chip>
        ) : null}
      </div>
    </Link>
  );
}

function EnvironmentsSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading environments">
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-56 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
