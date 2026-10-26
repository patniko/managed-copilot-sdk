import type { OperatorEnvironment, OperatorEnvironments } from "@managed-copilot/protocol/operator";
import { AlertFillIcon, CalendarIcon, CommentDiscussionIcon, CpuIcon, DotFillIcon, GlobeIcon, ArrowUpRightIcon, StackIcon, AiModelIcon } from "@primer/octicons-react";
import { cx } from "../lib/cx.js";
import { formatNumber, formatSize, summarizeNetwork } from "../lib/format.js";
import { useEnvironments } from "../lib/resources.js";
import { hrefs } from "../lib/routes.js";
import { ENVIRONMENT_TYPES, EnvironmentTypeChip, NetworkPolicyView } from "../components/common/Entities.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Card } from "../components/ui/Card.js";
import { Chip } from "../components/ui/Chip.js";
import { Code, EmptyState, Skeleton, SkeletonLines } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";

export function EnvironmentsView() {
  const poll = useEnvironments();
  return (
    <Page title="Environments" documentTitle="Environments" description="Declared environments and the policy ceilings sessions run under." poll={poll}>
      <PollContent poll={poll} skeleton={<EnvironmentsSkeleton />} errorTitle="Couldn't load environments" boxed>
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
            <dl className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
              <dt className="text-xs font-semibold text-fg-muted">Types</dt>
              <dd className="flex flex-wrap gap-1.5">
                {data.inline.types.map((type) => (
                  <EnvironmentTypeChip key={type} type={type} />
                ))}
              </dd>
              <dt className="text-xs font-semibold text-fg-muted">Sizes</dt>
              <dd className="flex flex-wrap gap-1.5">
                {data.inline.sizes && data.inline.sizes.length > 0 ? data.inline.sizes.map((size) => <Chip key={size}>{formatSize(size)}</Chip>) : <span className="text-fg-muted">Any size</span>}
              </dd>
            </dl>
          ) : (
            <p className="text-fg-muted">Not allowed: code must name a declared environment.</p>
          )}
        </Card>
        <Card title="Default network" description="The deployment-wide default (network at the top level of the AppHost).">
          <NetworkPolicyView policy={data.defaultNetwork} />
        </Card>
      </div>
      <section aria-labelledby="declared-heading">
        <h2 id="declared-heading" className="mb-3 text-base font-semibold">
          Declared environments <span className="Counter ml-1 align-middle">{data.environments.length}</span>
        </h2>
        {data.environments.length === 0 ? (
          <div className="Box">
            <EmptyState icon={StackIcon} title="No environments are declared">
              Declare environments under <Code>environments</Code> in the AppHost&apos;s addManagedCopilot options.
            </EmptyState>
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {data.environments.map((environment) => (
              <li key={environment.name} className="min-w-0">
                <EnvironmentCard environment={environment} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A pinned-repository style card: name, type label, description, facts, and session counts. */
function EnvironmentCard({ environment }: { readonly environment: OperatorEnvironment }) {
  const type = ENVIRONMENT_TYPES[environment.type];
  const TypeIcon = type?.icon ?? StackIcon;
  const network = summarizeNetwork(environment.network);
  const problem = environment.customizations?.problem;
  const size = formatSize(environment.size, environment.resources);
  return (
    <Link
      href={hrefs.environment(environment.name)}
      className={cx("Box group flex h-full flex-col p-4 transition-colors duration-150 hover:bg-canvas-muted", problem && "border-line-danger")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <TypeIcon size={16} className="text-fg-muted" />
        <span className="min-w-0 truncate font-mono font-semibold text-fg-accent group-hover:underline">{environment.name}</span>
        <span className="Label Label--secondary ml-auto" title={type?.description}>
          {type?.label ?? environment.type}
        </span>
      </span>
      {environment.description ? <span className="mt-2 line-clamp-2 text-xs text-fg-muted">{environment.description}</span> : null}
      {problem ? (
        <span className="flash flash-error flash-sm mt-3 text-xs">
          <AlertFillIcon size={16} />
          <span className="flash-content">
            <span className="font-semibold">Sessions fail: </span>
            {problem}
          </span>
        </span>
      ) : null}
      <span className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <AiModelIcon size={16} />
          Models
        </span>
        <span className="min-w-0 truncate" title={environment.models?.join(", ")}>
          {environment.models && environment.models.length > 0 ? environment.models.join(", ") : "Every model the caller can use"}
        </span>
        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <GlobeIcon size={16} />
          Network
        </span>
        <span className="min-w-0 truncate" title={network?.hosts.join(", ") || network?.description}>
          {network?.label}
        </span>
        {size ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-fg-muted">
              <CpuIcon size={16} />
              Size
            </span>
            <span className="min-w-0 truncate">{size}</span>
          </>
        ) : null}
        {environment.promoteTo ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-fg-muted">
              <ArrowUpRightIcon size={16} />
              Promotes to
            </span>
            <span className="min-w-0 truncate font-mono">{environment.promoteTo}</span>
          </>
        ) : null}
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-4 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <CommentDiscussionIcon size={16} />
          {formatNumber(environment.sessions.total)} {environment.sessions.total === 1 ? "session" : "sessions"}
        </span>
        <span className="inline-flex items-center gap-1 tabular-nums">
          <DotFillIcon size={16} className={environment.sessions.live > 0 ? "text-fg-success" : undefined} />
          {formatNumber(environment.sessions.live)} live
        </span>
        {environment.scheduling ? (
          <span className="inline-flex items-center gap-1" title="Agents may schedule follow-up work (scheduling: true)">
            <CalendarIcon size={16} />
            Scheduling
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function EnvironmentsSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading environments">
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="Box">
            <div className="Box-header">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="p-4">
              <SkeletonLines lines={2} />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="Box h-48 p-4">
            <SkeletonLines lines={5} />
          </div>
        ))}
      </div>
    </div>
  );
}
