import type { OperatorSchedule, OperatorWebhookDelivery } from "@managed-copilot/protocol/operator";
import { pauseSchedule, probeSandboxes, resumeSchedule, retryWebhookDelivery, stopSandbox } from "./api.js";
import { shortId } from "./format.js";
import { requestGuardedAction } from "./guarded.js";

/** Guarded operator actions. Each dialog states exactly what will happen; the gateway audits every one. */

export function confirmStopSandbox(sandbox: { readonly id: string; readonly sessionId: string }): void {
  requestGuardedAction({
    title: "Stop this sandbox?",
    description: `Stops compute for sandbox ${shortId(sandbox.id)} after its current work drains. Its files and state are kept; the session restarts it on next use.`,
    confirmLabel: "Stop sandbox",
    tone: "danger",
    run: () => stopSandbox(sandbox.sessionId),
    successTitle: "Stopping the sandbox",
    fallbackMessage: `Sandbox ${shortId(sandbox.id)} stops once its work drains.`,
    failureTitle: "Couldn't stop the sandbox",
  });
}

export function confirmProbeSandboxes(provider: string | undefined): void {
  requestGuardedAction({
    title: "Check the sandbox backend now?",
    description: `Asks the ${provider ?? "sandbox"} backend whether it can run sandboxes and records the result. Running sandboxes are not affected.`,
    confirmLabel: "Check now",
    run: () => probeSandboxes(),
    successTitle: "Sandbox backend checked",
    fallbackMessage: "See the result under Infrastructure → Sandbox backend.",
    failureTitle: "Couldn't check the sandbox backend",
  });
}

export function confirmPauseSchedule(schedule: Pick<OperatorSchedule, "id" | "name">): void {
  requestGuardedAction({
    title: `Pause “${schedule.name}”?`,
    description: "No new runs start while the schedule is paused; a run already in progress continues. You can resume it here at any time.",
    confirmLabel: "Pause schedule",
    reason: { label: "Reason", placeholder: "Why it's paused (recorded with the action)" },
    run: (reason) => pauseSchedule(schedule.id, reason),
    successTitle: "Schedule paused",
    fallbackMessage: `“${schedule.name}” won't start new runs until it's resumed.`,
    failureTitle: "Couldn't pause the schedule",
  });
}

export function confirmResumeSchedule(schedule: Pick<OperatorSchedule, "id" | "name" | "pausedReason">): void {
  requestGuardedAction({
    title: `Resume “${schedule.name}”?`,
    description: `The schedule becomes active again and starts runs at its next scheduled time.${schedule.pausedReason ? ` It was paused because: ${schedule.pausedReason}` : ""}`,
    confirmLabel: "Resume schedule",
    run: () => resumeSchedule(schedule.id),
    successTitle: "Schedule resumed",
    fallbackMessage: `“${schedule.name}” is active again.`,
    failureTitle: "Couldn't resume the schedule",
  });
}

export function confirmRetryDelivery(delivery: Pick<OperatorWebhookDelivery, "id" | "webhook" | "eventType" | "attempts">): void {
  requestGuardedAction({
    title: "Retry this delivery?",
    description: `Makes one more attempt to deliver ${delivery.eventType} (delivery ${shortId(delivery.id)}) to the ${delivery.webhook} webhook, after ${delivery.attempts} failed ${
      delivery.attempts === 1 ? "attempt" : "attempts"
    }. If an earlier attempt reached the receiver, it may see the event twice.`,
    confirmLabel: "Retry delivery",
    run: () => retryWebhookDelivery(delivery.id),
    successTitle: "Delivery queued",
    fallbackMessage: `Delivery ${shortId(delivery.id)} will be attempted again shortly.`,
    failureTitle: "Couldn't retry the delivery",
  });
}
