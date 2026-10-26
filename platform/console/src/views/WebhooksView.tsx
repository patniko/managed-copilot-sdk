import type { OperatorWebhookDelivery, OperatorWebhookDeliveryState, OperatorWebhookSubscription } from "@managed-copilot/protocol/operator";
import { AlertIcon, CheckIcon, PaperAirplaneIcon, SyncIcon, WebhookIcon } from "@primer/octicons-react";
import { getWebhooks } from "../lib/api.js";
import { formatNumber } from "../lib/format.js";
import { confirmRetryDelivery } from "../lib/operatorActions.js";
import { usePoll } from "../lib/poll.js";
import { useQueryUpdater } from "../lib/router.js";
import { buildSearch, hrefs, type Query } from "../lib/routes.js";
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
import { EmptyState, None, Skeleton, SkeletonLines } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";

type Filter = "all" | OperatorWebhookDeliveryState;

function isDeliveryState(value: string | undefined): value is OperatorWebhookDeliveryState {
  return value !== undefined && (DELIVERY_STATES as readonly string[]).includes(value);
}

const SUBSCRIPTION_COLUMNS: readonly Column<OperatorWebhookSubscription>[] = [
  { id: "name", header: "Webhook", cell: (subscription) => <span className="font-mono text-xs font-semibold whitespace-nowrap">{subscription.name}</span> },
  {
    id: "url",
    header: "URL",
    cell: (subscription) => (
      <span className="inline-flex max-w-64 min-w-0 items-center gap-1">
        <span className="truncate font-mono text-xs" title={subscription.url}>
          {subscription.url}
        </span>
        <CopyButton text={subscription.url} label="Copy webhook URL" className="size-6" />
      </span>
    ),
  },
  {
    id: "environments",
    header: "Environments",
    cell: (subscription) => (
      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
        {subscription.environments.map((name) => (
          <Link key={name} href={hrefs.environment(name)} className="Link--primary font-mono text-xs">
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
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <CheckIcon size={16} className="text-fg-success" />
          Signed
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-fg-attention" title="Its signing secret isn't configured, so deliveries fail visibly until it is.">
          <AlertIcon size={16} />
          No signing secret
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
    { id: "webhook", header: "Webhook", cell: (delivery) => <span className="font-mono text-xs whitespace-nowrap">{delivery.webhook}</span> },
    {
      id: "event",
      header: "Event",
      cell: (delivery) => (
        <span className="inline-flex flex-col items-start gap-1">
          <StatusBadge meta={eventTypeMeta(delivery.eventType)}>
            <span className="font-mono">{delivery.eventType}</span>
          </StatusBadge>
          <span className="font-mono text-xs text-fg-muted" title={delivery.eventId}>
            {delivery.eventId.slice(0, 12)}
          </span>
        </span>
      ),
    },
    { id: "session", header: "Session", cell: (delivery) => <SessionLink id={delivery.sessionId} />, hideBelow: "2xl" },
    { id: "environment", header: "Environment", cell: (delivery) => <EnvironmentLink name={delivery.environment} />, hideBelow: "2xl" },
    { id: "owner", header: "Owner", cell: (delivery) => <AccountLabel account={delivery.owner} />, hideBelow: "2xl" },
    { id: "state", header: "State", cell: (delivery) => <StatusBadge meta={deliveryStateMeta(delivery.state)} /> },
    { id: "attempts", header: "Attempts", align: "right", cell: (delivery) => <span>{delivery.attempts}</span> },
    {
      id: "last",
      header: "Last response",
      cell: (delivery) =>
        delivery.lastStatus !== undefined || delivery.lastError ? (
          <span className="inline-flex max-w-72 flex-col">
            {delivery.lastStatus !== undefined ? <span className={delivery.lastStatus >= 400 ? "font-mono text-xs font-semibold text-fg-danger" : "font-mono text-xs"}>HTTP {delivery.lastStatus}</span> : null}
            {delivery.lastError ? (
              <span className="line-clamp-2 text-xs text-fg-muted" title={delivery.lastError}>
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
      cell: (delivery) => (delivery.nextAttemptAt && delivery.state !== "delivered" ? <RelativeTime value={delivery.nextAttemptAt} className="text-fg-muted" /> : <None />),
      hideBelow: "2xl",
    },
    { id: "created", header: "Created", cell: (delivery) => <RelativeTime value={delivery.createdAt} className="text-fg-muted" />, hideBelow: "2xl" },
    { id: "delivered", header: "Delivered", cell: (delivery) => (delivery.deliveredAt ? <RelativeTime value={delivery.deliveredAt} className="text-fg-muted" /> : <None />), hideBelow: "2xl" },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (delivery) =>
        delivery.state === "failed" ? (
          <Button size="sm" icon={SyncIcon} onClick={() => confirmRetryDelivery(delivery)}>
            Retry
          </Button>
        ) : null,
    },
  ];

  const total = counts ? Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0) : undefined;

  return (
    <Page wide title="Webhooks" documentTitle="Webhooks" description="AppHost webhook subscriptions and every delivery the platform attempted." poll={poll}>
      <PollContent
        poll={poll}
        boxed
        skeleton={
          <div className="space-y-6" role="status" aria-label="Loading webhooks">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="Box">
                <div className="Box-header">
                  <Skeleton className="h-4 w-40" />
                </div>
                <div className="p-4">
                  <SkeletonLines lines={index === 0 ? 3 : 6} />
                </div>
              </div>
            ))}
          </div>
        }
        errorTitle="Couldn't load webhooks"
      >
        {(data) => (
          <div className="space-y-6">
            <Card title="Subscriptions" icon={WebhookIcon} description="Declared under webhooks in the AppHost." padded={false}>
              <DataTable
                label="Webhook subscriptions"
                rows={data.subscriptions}
                columns={SUBSCRIPTION_COLUMNS}
                rowKey={(subscription) => subscription.name}
                empty={
                  <EmptyState icon={WebhookIcon} title="No webhooks are declared" compact>
                    Declare webhooks in the AppHost to receive platform events.
                  </EmptyState>
                }
              />
            </Card>
            <Card
              title="Deliveries"
              icon={PaperAirplaneIcon}
              padded={false}
              actions={
                <Segmented<Filter>
                  label="Filter deliveries by state"
                  size="sm"
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
                  empty={
                    <EmptyState icon={PaperAirplaneIcon} title={state ? `No ${deliveryStateMeta(state).label.toLowerCase()} deliveries` : "No deliveries yet"} compact>
                      {state ? "Choose another state to see more." : "Deliveries appear when subscribed events happen."}
                    </EmptyState>
                  }
                />
              )}
              {data.deliveries.length >= filters.limit ? (
                <p className="border-t border-line bg-canvas-muted px-4 py-2 text-xs text-fg-muted">Showing the newest {formatNumber(data.deliveries.length)} deliveries.</p>
              ) : null}
            </Card>
          </div>
        )}
      </PollContent>
    </Page>
  );
}
