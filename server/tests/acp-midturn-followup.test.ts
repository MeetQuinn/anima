import assert from "node:assert/strict";
import test from "node:test";

import {
  acpFollowupAppliedText,
  appendAcpFollowupPrompt,
  discardAcpPromptPartialText,
  drainAcpTurnQueue,
  rollbackCancelledAcpPromptText,
  withAcpPromptInFlight,
} from "../providers/acp-midturn-followup.js";

test("acp follow-up applied text is provider-labeled", () => {
  assert.equal(
    acpFollowupAppliedText("Grok"),
    "Grok follow-up applied (interrupts active prompt)",
  );
  assert.equal(
    acpFollowupAppliedText("Kimi"),
    "Kimi follow-up applied (interrupts active prompt)",
  );
});

test("appendAcpFollowupPrompt queues and cancels only while a prompt is in flight", () => {
  const cancelled: string[] = [];
  const cancelSession = (sessionId: string): void => {
    cancelled.push(sessionId);
  };
  const turn = {
    acceptingFollowups: true,
    followups: [] as string[],
    text: [] as string[],
  };

  assert.equal(
    appendAcpFollowupPrompt({
      cancelSession,
      prompt: "later",
      promptInFlight: false,
      sessionId: "s1",
      turn,
    }),
    true,
  );
  assert.deepEqual(turn.followups, ["later"]);
  assert.deepEqual(cancelled, []);

  assert.equal(
    appendAcpFollowupPrompt({
      cancelSession,
      prompt: "now",
      promptInFlight: true,
      sessionId: "s1",
      turn,
    }),
    true,
  );
  assert.deepEqual(turn.followups, ["later", "now"]);
  assert.deepEqual(cancelled, ["s1"]);

  turn.acceptingFollowups = false;
  assert.equal(
    appendAcpFollowupPrompt({
      cancelSession,
      prompt: "nope",
      promptInFlight: true,
      sessionId: "s1",
      turn,
    }),
    false,
  );
});

test("cancelled prompt text rolls back to the checkpoint; other stop reasons keep text", () => {
  const turn = { text: ["keep", "stale"] };
  assert.equal(rollbackCancelledAcpPromptText(turn, 1, "cancelled"), true);
  assert.deepEqual(turn.text, ["keep"]);

  turn.text.push("more");
  assert.equal(rollbackCancelledAcpPromptText(turn, 1, "end_turn"), false);
  assert.deepEqual(turn.text, ["keep", "more"]);

  discardAcpPromptPartialText(turn, 1);
  assert.deepEqual(turn.text, ["keep"]);
});

test("drainAcpTurnQueue runs follow-ups after the primary prompt", async () => {
  const seen: string[] = [];
  const turn = {
    acceptingFollowups: true,
    followups: ["b", "c"],
    input: {},
    text: [] as string[],
  };
  await drainAcpTurnQueue({
    firstPrompt: "a",
    runOnePrompt: async (prompt) => {
      seen.push(prompt);
    },
    turn,
  });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(turn.acceptingFollowups, false);
});

test("withAcpPromptInFlight clears the flag on success and failure", async () => {
  let inFlight = false;
  await withAcpPromptInFlight(
    (value) => {
      inFlight = value;
    },
    async () => {
      assert.equal(inFlight, true);
      return 1;
    },
  );
  assert.equal(inFlight, false);

  await assert.rejects(
    withAcpPromptInFlight(
      (value) => {
        inFlight = value;
      },
      async () => {
        assert.equal(inFlight, true);
        throw new Error("boom");
      },
    ),
    /boom/,
  );
  assert.equal(inFlight, false);
});
