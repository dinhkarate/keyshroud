// keyshroud.dev/docs is committed under site/docs: it has to match what docs/*.md builds into.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("site/docs is what `npm run site` builds from docs/", () => {
  const result = spawnSync(process.execPath, ["scripts/build-site-docs.mjs", "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
