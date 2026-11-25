import assert from "node:assert/strict";
import test from "node:test";
import { nextContext, readContext, senderHistory } from "../antigravity-to-claude/server/context.mjs";
import * as ide from "../claude-to-antigravity/server/context.mjs";

test("both installed halves relay the same history and spend the smaller remaining budget", () => {
  const inbound = nextContext(undefined, "codex", "antigravity", 4, "one");
  const outbound = nextContext(readContext(JSON.stringify(inbound), "antigravity"), "antigravity", "claude", 2, "two");
  assert.equal(outbound.remaining_hops, 1);
  const leaf = ide.nextContext(ide.readContext(JSON.stringify(outbound), "claude"), "claude", "antigravity", 4, "three");
  assert.equal(leaf.remaining_hops, 0);
  assert.deepEqual(leaf.hops.map(h => h.id), ["one", "two", "three"]);
  assert.throws(() => nextContext(leaf, "antigravity", "codex", 9), /budget exhausted/);
});

test("legacy conversion preserves sender IDs and invalid authority fails closed on either half", () => {
  const legacy = senderHistory(["codex:a", "claude:b"], "antigravity", 1);
  assert.deepEqual(legacy.hops.map(h => h.to), ["claude", "antigravity"]);
  for (const decode of [readContext, ide.readContext]) {
    for (const value of [{ ...legacy, version: 2 }, { ...legacy, remaining_hops: -1 },
      { ...legacy, hops: [legacy.hops[0], legacy.hops[0]] },
      { ...legacy, hops: [{ from: "other", to: "claude", id: "x" }] }]) {
      assert.throws(() => decode(JSON.stringify(value)), /Invalid AGENT_BRIDGE_CONTEXT/);
    }
    assert.throws(() => decode(JSON.stringify(legacy), "codex"), /last hop/);
  }
});
