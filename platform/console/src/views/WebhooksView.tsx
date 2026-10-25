import type { OperatorWebhookDelivery, OperatorWebhookDeliveryState, OperatorWebhookSubscription } from "@managed-copilot/protocol/operator";
import { RotateCcw, Send, Webhook } from "lucide-react";
import { getWebhooks } from "../lib/api.js";
import { formatNumber } from "../lib/format.js";
import { confirmRetryDelivery } from "../lib/operatorActions.js";
import { usePoll } from "../lib/poll.js";
import { useQueryUpdater } from "../lib/router.js";
import { buildSearch, type Query } from "../lib/routes.js";
import { DELIVERY_STATES, deliveryStateMeta, eventTypeMeta } from "../lib/status.js";
import { ChipList } from "../components/common/Entities.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime, SessionLink } from "../components/common/Identity.js";
import { Page, PollContent } from "../components/layout/Page.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { StatusBadge } from "../components/ui/Chip.js";
import { Segmented } from "../components/ui/Controls.js";
import { CopyButton } from "../components/ui/CopyButton.js";
import { DataTable, TableSkeleton, type Column } from "../components/ui/DataTable.js";
import { EmptyState, None, Skeleton } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";
import { hrefs } from "../lib/routes.js";

type Filter = "all" | OperatorWebhookDeliveryState;

function isDeliveryState(value: string | undefined): value is OperatorWebhookDeliveryState {
  return value !== undefined && (DELIVERY_STATES as readonly string[]).includes(value);
}

const SUBSCRIPTION_COLUMNS: readonly Column<OperatorWebhookSubscription>[] = [
  { id: "name", header: "Webhook", cell: (subscription) => <span className="font-mono text-[12.5px] font-medium whitespace-nowrap text-zinc-100">{subscription.name}</span> },
  {
    id: "url",
    header: "URL",
    cell: (subscription) => (
      <span className="inline-flex max-w-96 min-w-0 items-center gap-1">
        <span className="truncate font-mono text-[12px] text-zinc-300" title={subscription.url}>
          {subscription.url}
        </span>
        <CopyButton text={subscription.url} label="Copy webhook URL" />
      </span>
    ),
  },
  {
    id: "environments",
    header: "Environments",
    cell: (subscription) => (
      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
        {subscription.environments.map((name) => (
          <Link key={name} href={hrefs.environment(name)} className="font-mono text-[12px] text-zinc-200 hover:text-sky-200 hover:underline hover:underline-offset-2">
            {name}
          </Link>
        ))}
      </span>
    ),
  },
  { id: "events", header: "Events", cell: (subscription) => <ChipList items={subscription.events} mono /> },
  {
    id: "signed",
    header: "Signing",
    cell: (subscription) =>
      subscription.signed ? (
        <span className="text-[12.5px] text-emerald-300">✓ Signed</span>
      ) : (
        <span className="text-[12.5px] text-amber-300" title="Its signing secret isn't configured, so deliveries fail visibly until it is.">
          ✗ No signing secret
        </span>
      ),
  },
];

export function WebhooksView({ query }: { readonly query: Query }) {
  const state = isDeliveryState(query["state"]) ? query["state"] : undefined;
  const filters = { state, limit: 200 };
  const poll = usePoll(`webhooks${buildSearch(filters)}`, (signal) => getWebhooks(filters, signal), { keepPreviousData: true });
  const setQuery = useQueryUpdater();
  const counts = poll.data?.counts;

  const deliveryColumns: readonly Column<OperatorWebhookDelivery>[] = [
    { id: "id", header: "Delivery", cell: (delivery) => <IdText id={delivery.id} label="delivery ID" /> },
    { id: "webhook", header: "Webhook", cell: (delivery) => <span className="font-mono text-[12px] whitespace-nowrap text-zinc-200">{delivery.webhook}</span> },
    {
      id: "event",
      header: "Event",
      cell: (delivery) => (
        <span className="inline-flex flex-col items-start gap-0.5">
          <StatusBadge meta={eventTypeMeta(delivery.eventType)} size="xs">
            <span className="font-mono">{delivery.eventType}</span>
          </StatusBadge>
          <span className="font-mono text-[11px] text-zinc-500" title={delivery.eventId}>
            {delivery.eventId.slice(0, 12)}
          </span>
        </span>
      ),
    },
    { id: "session", header: "Session", cell: (delivery) => <SessionLink id={delivery.sessionId} />, hideBelow: "xl" },
    { id: "environment", header: "Environment", cell: (delivery) => <EnvironmentLink name={delivery.environment} />, hideBelow: "2xl" },
    { id: "owner", header: "Owner", cell: (delivery) => <AccountLabel account={delivery.owner} />, hideBelow: "2xl" },
    { id: "state", header: "State", cell: (delivery) => <StatusBadge meta={deliveryStateMeta(delivery.state)} size="xs" /> },
    { id: "attempts", header: "Attempts", align: "right", cell: (delivery) => <span className="text-zinc-300">{delivery.attempts}</span> },
    {
      id: "last",
      header: "Last response",
      cell: (delivery) =>
        delivery.lastStatus !== undefined || delivery.lastError ? (
          <span className="inline-flex max-w-72 flex-col">
            {delivery.lastStatus !== undefined ? <span className={delivery.lastStatus >= 400 ? "font-mono text-[12px] text-rose-300" : "font-mono text-[12px] text-zinc-300"}>HTTP {delivery.lastStatus}</span> : null}
            {delivery.lastError ? (
              <span className="line-clamp-2 text-[12px] text-zinc-400" title={delivery.lastError}>
                {delivery.lastError}
              </span>
            ) : null}
          </span>
        ) : (
          <None />
        ),
    },
    {
      id: "next",
      header: "Next attempt",
      cell: (delivery) => (delivery.nextAttemptAt && delivery.state !== "delivered" ? <RelativeTime value={delivery.nextAttemptAt} className="text-zinc-400" /> : <None />),
      hideBelow: "xl",
    },
    { id: "created", header: "Created", cell: (delivery) => <RelativeTime value={delivery.createdAt} className="text-zinc-400" />, hideBelow: "2xl" },
    { id: "delivered", header: "Delivered", cell: (delivery) => (delivery.deliveredAt ? <RelativeTime value={delivery.deliveredAt} className="text-zinc-400" /> : <None />), hideBelow: "2xl" },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (delivery) =>
        delivery.state === "failed" ? (
          <Button size="xs" icon={RotateCcw} onClick={() => confirmRetryDelivery(delivery)}>
            Retry
          </Button>
        ) : null,
    },
  ];

  const total = counts ? Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0) : undefined;

  return (
    <Page title="Webhooks" documentTitle="Webhooks" icon={Webhook} description="AppHost webhook subscriptions and every delivery the platform attempted." poll={poll}>
      <PollContent
        poll={poll}
        skeleton={
          <div className="space-y-5" role="status" aria-label="Loading webhooks">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-72 rounded-2xl" />
          </div>
        }
        errorTitle="Couldn't load webhooks"
      >
        {(data) => (
          <div className="space-y-5">
            <Card title="Subscriptions" icon={Webhook} description="Declared under webhooks in the AppHost." padded={false}>
              <DataTable
                label="Webhook subscriptions"
                rows={data.subscriptions}
                columns={SUBSCRIPTION_COLUMNS}
                rowKey={(subscription) => subscription.name}
                empty={
                  <EmptyState icon={Webhook} title="No webhooks are declared" compact>
                    Declare webhooks in the AppHost to receive platform events.
                  </EmptyState>
                }
              />
            </Card>
            <Card
              title="Deliveries"
              icon={Send}
              padded={false}
              actions={
                <Segmented<Filter>
                  label="Filter deliveries by state"
                  value={state ?? "all"}
                  onChange={(value) => setQuery({ state: value === "all" ? undefined : value })}
                  options={[
                    { value: "all", label: "All", count: total },
                    ...DELIVERY_STATES.map((value) => ({ value, label: deliveryStateMeta(value).label, count: counts?.[value] ?? 0 })),
                  ]}
                />
              }
            >
              {poll.stale ? (
                <TableSkeleton columns={8} rows={4} />
              ) : (
                <DataTable
                  label="Webhook deliveries"
                  rows={data.deliveries}
                  columns={deliveryColumns}
                  rowKey={(delivery) => delivery.id}
                  rowClassName={(delivery) => (delivery.state === "failed" ? "bg-rose-400/[0.03]" : undefined)}
                  empty={
                    <EmptyState icon={Send} title={state ? `No ${deliveryStateMeta(state).label.toLowerCase()} deliveries` : "No deliveries yet"} compact>
                      {state ? "Choose another state to see more." : "Deliveries appear when subscribed events happen."}
                    </EmptyState>
                  }
                />
              )}
              {data.deliveries.length >= filters.limit ? (
                <p className="border-t border-zinc-800/70 px-4 py-2.5 text-[12.5px] text-zinc-500">Showing the newest {formatNumber(data.deliveries.length)} deliveries.</p>
              ) : null}
            </Card>
          </div>
        )}
      </PollContent>
    </Page>
  );
}
