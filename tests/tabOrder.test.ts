// Verifies the immutable order operation used by both tab-reordering interactions.
import { expect, it } from "vitest";
import { moveTab } from "../src/components/tabOrder";

it.each([
  ["a", "c", ["b", "a", "c"]],
  ["c", "a", ["c", "a", "b"]],
  ["a", null, ["b", "c", "a"]],
  ["b", "a", ["b", "a", "c"]],
  ["b", null, ["a", "c", "b"]],
] as const)("moves %s before %s while retaining descriptors and the input", (id, beforeId, expected) => {
  const reordered = moveTab(items, id, beforeId);
  expect(reordered.map(item => item.id)).toEqual(expected);
  expect(items.map(item => item.id)).toEqual(["a", "b", "c"]);
  expect(reordered.find(item => item.id === id)).toBe(items.find(item => item.id === id));
});

it.each([
  ["missing", "a"], ["a", "missing"], ["a", "a"], ["a", "b"], ["c", null],
] as const)("retains the original array for an ineffective move of %s before %s", (id, beforeId) => {
  expect(moveTab(items, id, beforeId)).toBe(items);
});

it("accepts empty and single-item lists", () => {
  const empty = Object.freeze([]);
  const single = Object.freeze([items[0]]);
  expect(moveTab(empty, "a", null)).toBe(empty);
  expect(moveTab(single, "a", null)).toBe(single);
});

const items = Object.freeze([
  Object.freeze({ id: "a", label: "A" }),
  Object.freeze({ id: "b", label: "B" }),
  Object.freeze({ id: "c", label: "C" }),
]);
