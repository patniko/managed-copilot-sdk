#!/usr/bin/env node
// Owner: core workstream. Spawned by the stock SDK via RuntimeConnection.forStdio({ path: <this file> }).
// Reads BridgeConfig from MANAGED_COPILOT_BRIDGE, ignores the runtime flags the SDK appends
// (--headless, --no-auto-update, --stdio, ...), and relays framed JSON-RPC between stdio and the gateway.
// Must start no local agent and never print credentials.
process.stderr.write("[managed-copilot bridge] not implemented yet\n");
process.exit(1);
