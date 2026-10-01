import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { wasDelivered } from "./delivery.ts";

function fake(pages: object[]) {
  const requests: Array<{ direction?: string; cursor?: unknown }> = [];
  const paseo = { agents: { ref: () => ({ timeline: { refetch: async (options: object) => {
    requests.push(options);
    return pages.shift();
  } } }) } } as unknown as PluginHookContext["paseo"];
  return { paseo, requests };
}

test("delivery evidence can be older than the tail page", async () => {
  const { paseo, requests } = fake([
    { epoch: "e", hasOlder: true, startCursor: { epoch: "e", seq: 501 }, entries: [] },
    { epoch: "e", hasOlder: false, entries: [{ item: { type: "user_message", clientMessageId: "m" } }] },
  ]);
  assert.equal(await wasDelivered(paseo, "a", "m"), true);
  assert.equal(requests[1].direction, "before");
  assert.deepEqual(requests[1].cursor, { epoch: "e", seq: 501 });
});

test("timeline gaps, epoch changes and bounded searches never prove non-delivery", async () => {
  for (const page of [
    { epoch: "e", gap: true, hasOlder: true, entries: [] },
    { epoch: "new", entries: [] },
    { epoch: "e", hasOlder: true, startCursor: { epoch: "e", seq: 10 }, entries: [] },
  ]) {
    const { paseo } = fake([
      { epoch: "e", hasOlder: true, startCursor: { epoch: "e", seq: 10 }, entries: [] }, page,
    ]);
    assert.equal(await wasDelivered(paseo, "a", "m", 2), false);
  }
});
