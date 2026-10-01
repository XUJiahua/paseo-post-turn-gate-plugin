import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { CompletionSupervisor } from "./supervisor.ts";
import { startRecoveryConnection } from "./startup.ts";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), "startup condition was not reached");
}

test("startup recovery connects without hooks, retries, reconnects, and stops on cleanup", async () => {
  let connected = false;
  let connects = 0;
  let reconciles = 0;
  let closed = false;
  const client = {
    connect: async () => {
      connects++;
      if (connects === 1) throw new Error("not ready");
      connected = true;
    },
    getConnectionState: () => ({ status: connected ? "connected" : "disconnected" }),
    close: async () => { closed = true; connected = false; },
  } as unknown as PaseoClient;
  const recovery = startRecoveryConnection({
    url: "ws://127.0.0.1:7791/ws", retryMs: 5, createClient: () => client,
    supervisor: { accept: (event: { type: string }) => { assert.equal(event.type, "reconcile"); reconciles++; } } as unknown as CompletionSupervisor,
  });
  try {
    await until(() => reconciles === 1);
    assert.ok(connects >= 2);
    assert.equal(reconciles, 1);
    connected = false;
    await until(() => reconciles === 2);
    assert.equal(reconciles, 2);
  } finally { await recovery.close(); }
  const count = connects;
  await delay(15);
  assert.equal(connects, count);
  assert.equal(closed, true);
});

test("no late reconciliation if cleanup happens during connect", async () => {
  let resolve!: () => void;
  let reconciles = 0;
  const client = {
    connect: () => new Promise<void>((done) => { resolve = done; }),
    getConnectionState: () => ({ status: "disconnected" }), close: async () => {},
  } as unknown as PaseoClient;
  const recovery = startRecoveryConnection({
    url: "ws://localhost:7791/ws", createClient: () => client,
    supervisor: { accept: () => reconciles++ } as unknown as CompletionSupervisor,
  });
  await recovery.close();
  resolve();
  await delay(0);
  assert.equal(reconciles, 0);
});

test("startup never guesses or accepts a remote/credential-bearing endpoint", () => {
  for (const url of ["ws://example.com/ws", "http://localhost/ws", "ws://user:secret@localhost/ws", "ws://localhost/ws?token=secret"]) {
    assert.throws(() => startRecoveryConnection({ url, supervisor: {} as CompletionSupervisor }));
  }
});
