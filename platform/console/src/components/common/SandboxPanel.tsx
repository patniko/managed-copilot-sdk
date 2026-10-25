import type { OperatorSandbox } from "@managed-copilot/protocol/operator";
import type { SandboxSetupRecord, SandboxSetupStep } from "@managed-copilot/protocol";
import { Square } from "lucide-react";
import { formatBytes, formatDuration, formatMilliseconds, parseTime, shortId } from "../../lib/format.js";
import { confirmStopSandbox } from "../../lib/operatorActions.js";
import { sandboxStateMeta, setupStateMeta } from "../../lib/status.js";
import { Button } from "../ui/Button.js";
import { Card, Field, FieldGrid } from "../ui/Card.js";
import { Chip, StatusBadge } from "../ui/Chip.js";
import { CodeBlock, Disclosure } from "../ui/CodeBlock.js";
import { CopyButton } from "../ui/CopyButton.js";
import { Callout, None } from "../ui/Feedback.js";
import { ChipList, NetworkPolicyView, YesNo } from "./Entities.js";
import { AccountLabel, EnvironmentLink, IdText, RelativeTime, SessionLink } from "./Identity.js";

function Mono({ value, label }: { readonly value: string | undefined; readonly label: string }) {
  if (!value) return <None />;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="min-w-0 font-mono text-[12px] break-all">{value}</span>
      <CopyButton text={value} label={`Copy ${label}`} />
    </span>
  );
}

/** Every field of an `OperatorSandbox`, its activity, and its setup record. */
export function SandboxPanel({ sandbox, showSession = true }: { readonly sandbox: OperatorSandbox; readonly showSession?: boolean }) {
  const meta = sandboxStateMeta(sandbox.state);
  return (
    <div className="space-y-5">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            Sandbox <span className="font-mono text-[13px] font-normal text-zinc-400">{shortId(sandbox.id)}</span>
          </span>
        }
        actions={
          <>
            <StatusBadge meta={meta} />
            {sandbox.state === "running" ? (
              <Button size="sm" variant="danger" icon={Square} onClick={() => confirmStopSandbox(sandbox)}>
                Stop sandbox
              </Button>
            ) : null}
          </>
        }
      >
        {sandbox.error ? (
          <Callout tone="danger" title={sandbox.error.code ? `Failed: ${sandbox.error.code}` : "Failed"} className="mb-4">
            {sandbox.error.message}
          </Callout>
        ) : null}
        <FieldGrid columns={4}>
          <Field label="Sandbox ID">
            <IdText id={sandbox.id} label="sandbox ID" length={12} />
          </Field>
          {showSession ? (
            <Field label="Session">
              <SessionLink id={sandbox.sessionId} copy />
            </Field>
          ) : null}
          <Field label="Owner">
            <AccountLabel account={sandbox.owner} />
          </Field>
          <Field label="Environment">
            <EnvironmentLink name={sandbox.environment} />
          </Field>
          <Field label="Size">
            <Chip>{sandbox.size}</Chip>
          </Field>
          <Field label="Idle timeout">{formatDuration(sandbox.idleTimeoutSeconds)}</Field>
          <Field label="Subnet" mono>
            {sandbox.subnet}
          </Field>
          <Field label="Vaults">
            <ChipList items={sandbox.vaults} mono empty="None" />
          </Field>
          <Field label="Image" wide>
            <Mono value={sandbox.image} label="image" />
          </Field>
          <Field label="Pinned image ID" wide>
            <Mono value={sandbox.imageId} label="image ID" />
          </Field>
          <Field label="Network" wide>
            <NetworkPolicyView policy={sandbox.network} />
          </Field>
          <Field label="Created">
            <RelativeTime value={sandbox.createdAt} />
          </Field>
          <Field label="Updated">
            <RelativeTime value={sandbox.updatedAt} />
          </Field>
          <Field label="Started">{sandbox.startedAt ? <RelativeTime value={sandbox.startedAt} /> : undefined}</Field>
          <Field label="Stopped">{sandbox.stoppedAt ? <RelativeTime value={sandbox.stoppedAt} /> : undefined}</Field>
        </FieldGrid>
      </Card>

      <Card title="Activity" description="Tracked in memory while the gateway manages the sandbox.">
        {sandbox.activity ? (
          <FieldGrid columns={4}>
            <Field label="Runtime connections">
              <span className="tabular">{sandbox.activity.runtimes}</span>
            </Field>
            <Field label="Busy">
              <span className="tabular">{sandbox.activity.busy}</span>
            </Field>
            <Field label="Turn running">
              <YesNo value={sandbox.activity.turnRunning} />
            </Field>
            <Field label="Pending work">
              <span className="tabular">{sandbox.activity.pending}</span>
            </Field>
            <Field label="Last activity">
              <RelativeTime value={sandbox.activity.lastActivityAt} />
            </Field>
          </FieldGrid>
        ) : (
          <p className="text-[13px] text-zinc-500">No activity tracked right now.</p>
        )}
      </Card>

      <SetupCard setup={sandbox.setup} />
    </div>
  );
}

function stepDuration(step: SandboxSetupStep): string {
  const started = parseTime(step.startedAt);
  const finished = parseTime(step.finishedAt);
  return started !== undefined && finished !== undefined ? formatMilliseconds(Math.max(0, finished - started)) : "";
}

function SetupCard({ setup }: { readonly setup: SandboxSetupRecord | undefined }) {
  if (!setup) {
    return (
      <Card title="Setup">
        <p className="text-[13px] text-zinc-500">No setup record yet.</p>
      </Card>
    );
  }
  const resolved = [
    ...Object.entries(setup.resolved.python ?? {}).map(([name, version]) => `python ${name}==${version}`),
    ...Object.entries(setup.resolved.npm ?? {}).map(([name, version]) => `npm ${name}@${version}`),
  ];
  return (
    <Card
      title="Setup"
      description={
        setup.startedAt ? (
          <span>
            Started <RelativeTime value={setup.startedAt} />
            {setup.finishedAt ? (
              <>
                {" "}
                · finished <RelativeTime value={setup.finishedAt} />
              </>
            ) : null}
          </span>
        ) : undefined
      }
      actions={<StatusBadge meta={setupStateMeta(setup.state)} />}
      padded={false}
    >
      {setup.error ? (
        <Callout tone="danger" title="Setup failed" className="m-4 mb-0">
          {setup.error}
        </Callout>
      ) : null}
      {setup.steps.length === 0 ? (
        <p className="p-4 text-[13px] text-zinc-500">No setup steps: the environment needs no packages, files, or commands.</p>
      ) : (
        <ol className="divide-y divide-zinc-800/70">
          {setup.steps.map((step, index) => (
            <li key={`${step.kind}-${index}`} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-right text-[11px] text-zinc-600 tabular">{index + 1}</span>
                <Chip>{step.kind}</Chip>
                <code className="min-w-0 flex-1 font-mono text-[12px] break-all text-zinc-200">{step.name}</code>
                <StatusBadge meta={setupStateMeta(step.state)} size="xs" />
                {step.exitCode !== undefined ? (
                  <span className={step.exitCode === 0 ? "text-[12px] text-zinc-500" : "text-[12px] text-rose-300"}>exit {step.exitCode}</span>
                ) : null}
                {stepDuration(step) ? <span className="text-[12px] text-zinc-500 tabular">{stepDuration(step)}</span> : null}
              </div>
              {step.output ? (
                <Disclosure className="mt-2 ml-7" summary="Output (tail)" defaultOpen={step.state === "failed"}>
                  <CodeBlock text={step.output} label={`Output of ${step.name}`} copyLabel="Copy output" maxHeight="md" wrap={false} />
                </Disclosure>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {resolved.length > 0 || setup.files.length > 0 ? (
        <div className="grid gap-5 border-t border-zinc-800/70 p-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Resolved packages</h3>
            <ChipList items={resolved} mono empty="None" />
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Files written</h3>
            {setup.files.length > 0 ? (
              <ul className="space-y-1 text-[12px]">
                {setup.files.map((file) => (
                  <li key={file.path} className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-zinc-200" title={file.path}>
                      {file.path}
                    </span>
                    <span className="text-zinc-500 tabular">{formatBytes(file.size)}</span>
                    <span className="font-mono text-zinc-500" title={`sha256:${file.sha256}`}>
                      {file.sha256.slice(0, 12)}
                    </span>
                    <CopyButton text={file.sha256} label={`Copy SHA-256 of ${file.path}`} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[13px] text-zinc-500">None</span>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
