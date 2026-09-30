import assert from "node:assert/strict";
import { test } from "node:test";
import type { Paseo } from "./gate.ts";
import { IDLE, IDLE_OR_ERROR, sendIfIdle } from "./dispatch.ts";

function fakePaseo(status: string | null) {
  const log: string[] = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => (status === null ? null : { agent: { id, status } }),
        send: async (text: string, options: { messageId: string }) => void log.push(`send ${options.messageId} ${text}`),
      }),
    },
  } as unknown as Paseo;
  return { paseo, log };
}

const message = { text: "fix it", messageId: "ptg:r:fix:1" };

test("sends only in an accepted status, recording before the send", async () => {
  const idle = fakePaseo("idle");
  assert.equal(await sendIfIdle(idle.paseo, "a", message, { accept: IDLE, beforeSend: () => idle.log.push("record") }), "sent");
  assert.deepEqual(idle.log, ["record", "send ptg:r:fix:1 fix it"]);

  const failed = fakePaseo("error");
  assert.equal(await sendIfIdle(failed.paseo, "a", message, { accept: IDLE }), "busy");
  assert.equal(await sendIfIdle(failed.paseo, "a", message, { accept: IDLE_OR_ERROR }), "sent");

  const running = fakePaseo("running");
  assert.equal(await sendIfIdle(running.paseo, "a", message, { accept: IDLE_OR_ERROR, beforeSend: () => running.log.push("record") }), "busy");
  assert.deepEqual(running.log, [], "a busy agent is neither recorded nor sent to");

  assert.equal(await sendIfIdle(fakePaseo(null).paseo, "a", message, { accept: IDLE }), "gone");
});
