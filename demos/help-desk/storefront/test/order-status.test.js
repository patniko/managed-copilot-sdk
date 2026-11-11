import assert from "node:assert/strict";
import { test } from "node:test";
import { latestScan, statusLabel } from "../src/order-status.js";

const scan = (at, description, location = "Reno, NV") => ({ at, location, description });
const SHIPPED = scan("2026-11-02T09:00:00Z", "Shipped from the Contoso warehouse");

test("shows Processing until the carrier scans the package", () => {
  assert.equal(statusLabel([]), "Processing");
  assert.equal(statusLabel(undefined), "Processing");
});

test("shows In transit while the package moves", () => {
  assert.equal(statusLabel([SHIPPED]), "In transit");
  assert.equal(statusLabel([SHIPPED, scan("2026-11-03T14:00:00Z", "Departed FedEx hub", "Memphis, TN")]), "In transit");
  assert.equal(statusLabel([SHIPPED, scan("2026-11-03T14:00:00Z", "Arrived at regional facility", "Phoenix, AZ")]), "In transit");
});

test("shows Delivered once the carrier delivers it", () => {
  assert.equal(statusLabel([SHIPPED, scan("2026-11-04T16:20:00Z", "Delivered, front door", "Denver, CO")]), "Delivered");
  assert.equal(statusLabel([SHIPPED, scan("2026-11-04T16:20:00Z", "DELIVERED - MAILBOX", "Austin, TX")]), "Delivered");
});

test("shows Delayed when the carrier holds the package", () => {
  assert.equal(statusLabel([SHIPPED, scan("2026-11-03T08:00:00Z", "Weather delay: held at facility", "Denver, CO")]), "Delayed");
  assert.equal(statusLabel([SHIPPED, scan("2026-11-03T08:00:00Z", "Exception: address needs attention", "Boise, ID")]), "Delayed");
});

test("goes by the latest scan, whatever order the scans arrive in", () => {
  const delivered = scan("2026-11-04T16:20:00Z", "Delivered, front door", "Denver, CO");
  assert.equal(latestScan([delivered, SHIPPED]), delivered);
  assert.equal(statusLabel([delivered, SHIPPED]), "Delivered");
});
