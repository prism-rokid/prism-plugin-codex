const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { __test } = require("../index.js");

test("foreground detail context is derived from the rollout token event", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-context-"));
  const rollout = path.join(dir, "rollout-2026-07-26T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
  try {
    fs.writeFileSync(rollout, `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 258400,
          last_token_usage: {
            input_tokens: 120100,
            output_tokens: 252,
            total_tokens: 120352,
          },
        },
      },
    })}\n`);

    const thread = __test.withRolloutContextMetadata({
      id: "11111111-1111-4111-8111-111111111111",
      rolloutPath: rollout,
      metadata: { model: "5.5" },
    });

    assert.deepEqual(__test.rolloutContextMetadata(rollout), {
      context_tokens_used: "120352",
      context_window_total: "258400",
      context_window_usage_percent: "47",
      context_window: "上下文窗口 258400",
    });
    assert.equal(thread.metadata.model, "5.5");
    assert.equal(thread.metadata.context_window_total, "258400");
    assert.equal(thread.metadata.context_tokens_used, "120352");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("historical thread metadata includes reasoning effort from the rollout turn context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-reasoning-"));
  const rollout = path.join(dir, "rollout-2026-07-26T00-00-00-22222222-2222-4222-8222-222222222222.jsonl");
  try {
    fs.writeFileSync(rollout, `${JSON.stringify({
      type: "turn_context",
      payload: {
        model: "gpt-5.6",
        collaboration_mode: { settings: { reasoning_effort: "high" } },
      },
    })}\n`);

    const thread = __test.withRolloutContextMetadata({
      id: "22222222-2222-4222-8222-222222222222",
      rolloutPath: rollout,
      metadata: {},
    });

    assert.equal(thread.metadata.model, "gpt-5.6");
    assert.equal(thread.metadata.reasoning_effort, "high");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("historical metadata keeps the first turn context when the rollout tail is large", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-large-rollout-metadata-"));
  const rollout = path.join(dir, "rollout-2026-09-22T20-45-27-01a0c926-55f7-79d2-96af-ae59b9e6e304.jsonl");
  try {
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/old", model: null } }),
      JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          collaboration_mode: { settings: { model: "gpt-5.6-sol", reasoning_effort: "high" } },
        },
      }),
      ...Array.from({ length: 1600 }, (_, index) => JSON.stringify({
        type: "event_msg",
        payload: { type: "item_completed", text: `${index} ${"x".repeat(120)}` },
      })),
    ].join("\n") + "\n");

    const thread = __test.withRolloutContextMetadata({
      id: "01a0c926-55f7-79d2-96af-ae59b9e6e304",
      rolloutPath: rollout,
      metadata: {},
    });

    assert.equal(thread.metadata.model, "gpt-5.6-sol");
    assert.equal(thread.metadata.reasoning_effort, "high");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
