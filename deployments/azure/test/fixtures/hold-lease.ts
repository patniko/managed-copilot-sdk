// Holds the lease from a separate process: prints {"generation":N} once held, then waits to be killed.
import { Lease } from "../../src/lease/lease.js";

const lease = Lease.tryAcquire(process.argv[2]!, { holder: `child-${process.pid}`, stamp: "1" });
process.stdout.write(`${JSON.stringify({ generation: lease?.generation ?? null })}\n`);
setInterval(() => lease?.heartbeat(), 50);
