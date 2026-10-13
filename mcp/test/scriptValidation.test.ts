import assert from "node:assert/strict";
import { test } from "node:test";
import { findTopLevelReturn } from "../src/device/tools/scriptValidation.ts";

test("findTopLevelReturn locates a return at the script top level", () => {
  const location = findTopLevelReturn("var apps = app.getInstalledApps();\nreturn apps;");

  assert.deepEqual(location, { line: 2, column: 1 });
});

test("findTopLevelReturn does not reject return inside a function", () => {
  const location = findTopLevelReturn("function pick() {\n  return 'ok';\n}\nlog(pick());");

  assert.equal(location, undefined);
});

test("findTopLevelReturn ignores comments, strings and regular expression literals", () => {
  const location = findTopLevelReturn([
    "var text = 'return';",
    "// return from comment",
    "var pattern = /return/g;",
    "log(text, pattern);"
  ].join("\n"));

  assert.equal(location, undefined);
});

test("findTopLevelReturn still catches a return statement after a top-level branch", () => {
  const location = findTopLevelReturn("if (device.width > 0) return device.width;");

  assert.deepEqual(location, { line: 1, column: 23 });
});
