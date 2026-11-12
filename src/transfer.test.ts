import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bufferMinutes,
  displayGap,
  earliestConnection,
  sameLegPairs,
} from "./transfer.ts";

const t = (hhmm: string) => ({ eta: `2026-11-07T${hhmm}:00+08:00` });

test("same-stop buffer is 3 minutes and ignores the walk time", () => {
  assert.equal(bufferMinutes(true, 5), 3);
  assert.equal(bufferMinutes(true, 0), 3);
});

test("different stops use the walk time, and a bad value falls back to 5", () => {
  assert.equal(bufferMinutes(false, 8), 8);
  assert.equal(bufferMinutes(false, 0), 0);
  assert.equal(bufferMinutes(false, Number.NaN), 5);
  assert.equal(bufferMinutes(false, -1), 5);
});

test("earliest next boarding that clears the buffer wins", () => {
  const alight = [t("10:00"), t("10:20")];
  const board = [t("10:02"), t("10:04"), t("10:30")];
  const hit = earliestConnection(alight, board, 3);
  assert.ok(hit);
  assert.equal(hit?.boardEta, "2026-11-07T10:04:00+08:00");
  assert.equal(hit?.alightEta, "2026-11-07T10:00:00+08:00");
  assert.equal(displayGap(hit?.gapMin ?? 0, 3), 4);
});

test("no connection when every next bus is inside the buffer", () => {
  const hit = earliestConnection([t("10:00")], [t("10:02")], 3);
  assert.equal(hit, null);
});

test("nth alighting pairs with nth boarding only when it is later", () => {
  const pairs = sameLegPairs(
    [t("10:00"), t("10:20")],
    [t("10:15"), t("10:10")],
  );
  assert.deepEqual(pairs, [{ board: "2026-11-07T10:00:00+08:00", alight: "2026-11-07T10:15:00+08:00" }]);
});
