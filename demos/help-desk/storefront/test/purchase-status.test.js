import assert from "node:assert/strict";
import { test } from "node:test";
import { latestEvent, statusLabel } from "../src/purchase-status.js";

const event = (at, description) => ({ at, description });
const PLACED = event("2026-11-12T15:02:00Z", "Order placed");

test("shows Processing until the payment provider reports on the order", () => {
  assert.equal(statusLabel([]), "Processing");
  assert.equal(statusLabel(undefined), "Processing");
  assert.equal(statusLabel([PLACED]), "Processing");
});

test("shows Pending while the payment clears", () => {
  assert.equal(statusLabel([PLACED, event("2026-11-12T15:02:05Z", "eCheck payment pending")]), "Pending");
  assert.equal(statusLabel([PLACED, event("2026-11-12T15:02:05Z", "Held for bank verification")]), "Pending");
});

test("shows Unlocked once the looks are in the game", () => {
  assert.equal(statusLabel([PLACED, event("2026-11-12T15:02:09Z", "Unlocked in Downhill")]), "Unlocked");
  assert.equal(statusLabel([PLACED, event("2026-11-12T15:02:09Z", "LOOKS UNLOCKED")]), "Unlocked");
});

test("shows Refunded once the money goes back", () => {
  assert.equal(statusLabel([PLACED, event("2026-11-12T16:40:00Z", "Refunded to the original payment method")]), "Refunded");
});

test("goes by the latest event, whatever order the events arrive in", () => {
  const unlocked = event("2026-11-12T15:02:09Z", "Unlocked in Downhill");
  assert.equal(latestEvent([unlocked, PLACED]), unlocked);
  assert.equal(statusLabel([unlocked, PLACED]), "Unlocked");
});
