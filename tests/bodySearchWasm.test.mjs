// Verifies the actual Wasm searcher's public contract against the existing cooperative JavaScript scanner.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  findLargeBodyMatch, LARGE_BODY_PAGE_SIZE, LARGE_BODY_QUERY_LIMIT,
} from "../src/components/largeBody.ts";
import { createBodySearcher } from "../src/wasm/bodySearcherRuntime.ts";

const wasmBytes = await readFile(new URL("../src/wasm/generated/body_search.wasm", import.meta.url));
const module = await WebAssembly.compile(wasmBytes);
const signal = new AbortController().signal;

test("searches literals with original UTF-16 offsets and clamps navigation boundaries", async () => {
  const text = "prefix [Needle].*+?^${}()|[]\\ 😀\r\n[NEEDLE] suffix";
  await withSearcher(text, async searcher => {
    for (const query of ["[needle]", ".*+?^${}()|[]\\", "😀\r\n", "not present", " "]) {
      for (const from of [-100, 0, 8, text.length, Infinity]) {
        await assertMatchesReference(searcher, text, query, from);
      }
    }
    assert.deepEqual(await searcher.find("[needle]", 0, 1, signal), { from: 7, to: 15 });
  });
});

test("navigates overlapping occurrences with inclusive forward starts and exclusive backward ends", async () => {
  const text = "aaaaa";
  await withSearcher(text, async searcher => {
    for (let from = 0; from <= text.length; from += 1) {
      await assertMatchesReference(searcher, text, "aaa", from);
    }
    assert.deepEqual(await searcher.find("aaa", 1, 1, signal), { from: 1, to: 4 });
    assert.deepEqual(await searcher.find("aaa", 4, -1, signal), { from: 1, to: 4 });
    // A wrapped occurrence may cross the original navigation boundary.
    assert.deepEqual(await searcher.find("aaa", 1, -1, signal), { from: 2, to: 5 });
    assert.deepEqual(await searcher.find("aaa", 4, 1, signal), { from: 0, to: 3 });
  });
});

test("preserves Unicode simple case folding without expansion or locale-specific folding", async () => {
  const groups = [
    ["K", "k", "K"], ["S", "s", "ſ"], ["Σ", "σ", "ς"], ["ß", "ẞ"],
    ["I", "i"], ["Ǆ", "ǅ", "ǆ"], ["Ꭰ", "ꭰ"], ["𐐀", "𐐨"], ["𞤀", "𞤢"],
  ];
  const text = groups.map(group => group.join(" ")).join(" | ") + " | İ ı ss ffi é e\u0301";
  await withSearcher(text, async searcher => {
    for (const query of [...groups.flat(), "İ", "ı", "SS", "ﬃ", "É", "E\u0301"]) {
      for (const from of [0, Math.floor(text.length / 2), text.length]) {
        await assertMatchesReference(searcher, text, query, from);
      }
    }
  });

  for (const [source, query] of [["ß ẞ", "ss"], ["ss", "ß"], ["İ ı", "i"], ["ﬃ", "ffi"], ["é", "e\u0301"]]) {
    await withSearcher(source, async searcher => {
      for (const direction of [1, -1]) assert.equal(await searcher.find(query, 0, direction, signal), null);
    });
  }
});

test("matches the JavaScript oracle for every mapping in the pinned official simple-fold data", async () => {
  const data = await readFile(new URL("../crates/body-search/CaseFolding.txt", import.meta.url), "utf8");
  const mappings = data.split("\n").flatMap(line => {
    const [source, status, target] = line.split("#", 1)[0].split(";").map(value => value.trim());
    return status === "C" || status === "S"
      ? [[String.fromCodePoint(parseInt(source, 16)), String.fromCodePoint(parseInt(target, 16))]] : [];
  });
  let text = "";
  const cases = mappings.map(([source, target]) => {
    const sourceFrom = text.length;
    text += source + " " + target + " | ";
    return { source, target, sourceFrom, targetFrom: sourceFrom + source.length + 1 };
  });
  await withSearcher(text, async searcher => {
    for (const { source, target, sourceFrom, targetFrom } of cases) {
      const expectedForward = await findLargeBodyMatch(text, source, targetFrom, 1, signal);
      assert.deepEqual(await searcher.find(source, targetFrom, 1, signal), expectedForward,
        `Forward folding ${JSON.stringify(source)} to ${JSON.stringify(target)}`);
      const end = sourceFrom + source.length;
      const expectedBackward = await findLargeBodyMatch(text, target, end, -1, signal);
      assert.deepEqual(await searcher.find(target, end, -1, signal), expectedBackward,
        `Backward folding ${JSON.stringify(target)} to ${JSON.stringify(source)}`);
    }
  });
});

test("finds chunk-spanning and maximum-length literals in both directions and after wrapping", async () => {
  const first = LARGE_BODY_PAGE_SIZE - 3;
  const second = LARGE_BODY_PAGE_SIZE * 2 - 2;
  const text = "x".repeat(first) + "[NeEdLe]" + "x".repeat(second - first - 8) + "[NEEDLE]" + "x".repeat(100);
  await withSearcher(text, async searcher => {
    for (const from of [0, first, first + 8, LARGE_BODY_PAGE_SIZE, second, second + 8, text.length]) {
      await assertMatchesReference(searcher, text, "[needle]", from);
    }
  });

  const query = "a".repeat(LARGE_BODY_QUERY_LIMIT - 1) + "b";
  const longText = "a".repeat(LARGE_BODY_PAGE_SIZE * 2 - 1) + "B";
  await withSearcher(longText, async searcher => {
    for (const from of [0, LARGE_BODY_PAGE_SIZE, longText.length - 1, longText.length]) {
      await assertMatchesReference(searcher, longText, query, from);
    }
  });
});

test("preserves matches and complete code points across the worker's larger scan chunks", async () => {
  const chunk = 256 * 1024;
  const first = chunk - 3;
  const pair = chunk * 2 - 1;
  const text = "x".repeat(first) + "[Needle]" + "x".repeat(pair - first - 8) + "😀Needle\r\n";
  await withSearcher(text, async searcher => {
    for (const query of ["[needle]", "😀needle", "\ud83d", "\ude00", "\r\n"]) {
      for (const from of [0, first, chunk - 1, chunk, chunk + 1, pair, pair + 1, text.length]) {
        await assertMatchesReference(searcher, text, query, from);
      }
    }
  });
});

test("never turns a split surrogate pair into a lone-surrogate match", async () => {
  const pairStart = LARGE_BODY_PAGE_SIZE - 1;
  const text = "x".repeat(pairStart) + "😀x😀\r\ny\r\n\ud83dX\ude00";
  await withSearcher(text, async searcher => {
    for (const query of ["\ud83d", "\ude00", "😀", "😀x", "x😀", "\ud83dX", "X\ude00", "\r\n", "\n"]) {
      for (const from of [0, pairStart, pairStart + 1, pairStart + 2, pairStart + 4, pairStart + 7, text.length]) {
        await assertMatchesReference(searcher, text, query, from);
      }
    }
  });

  await withSearcher("😀", async searcher => {
    for (const query of ["\ud83d", "\ude00"]) {
      for (const from of [0, 1, 2]) {
        for (const direction of [1, -1]) assert.equal(await searcher.find(query, from, direction, signal), null);
      }
    }
  });
});

test("bounds queries in UTF-16 units and preserves null results before cancellation for empty work", async () => {
  const controller = new AbortController();
  controller.abort();
  await withSearcher("😀".repeat(LARGE_BODY_QUERY_LIMIT / 2), async searcher => {
    assert.deepEqual(await searcher.find("😀".repeat(LARGE_BODY_QUERY_LIMIT / 2), 0, 1, signal), {
      from: 0, to: LARGE_BODY_QUERY_LIMIT,
    });
    for (const query of ["", "x".repeat(LARGE_BODY_QUERY_LIMIT + 1), "😀".repeat(LARGE_BODY_QUERY_LIMIT / 2 + 1)]) {
      for (const direction of [1, -1]) {
        assert.equal(await searcher.find(query, 0, direction, controller.signal), null);
      }
    }
  });
  await withSearcher("", async searcher => {
    assert.equal(await searcher.find("needle", 0, 1, controller.signal), null);
  });
});

test("cancels pending scans without poisoning later requests or other response bodies", async () => {
  const text = "x".repeat(LARGE_BODY_PAGE_SIZE * 48) + "Needle";
  await withSearcher(text, async searcher => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(searcher.find("needle", 0, 1, alreadyAborted.signal), { name: "AbortError" });

    const controller = new AbortController();
    const pending = searcher.find("missing", 0, 1, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });

    await withSearcher("other NEEDLE body", async other => {
      assert.deepEqual(await other.find("needle", 0, 1, signal), { from: 6, to: 12 });
      assert.deepEqual(await searcher.find("needle", 0, 1, signal), { from: text.length - 6, to: text.length });
      for (const query of ["x".repeat(4096), "needle", "absent", "x", "NEEDLE"]) {
        await assertMatchesReference(searcher, text, query, text.length);
      }
    });
  });
});

test("keeps overlapping request ownership separate and invalidates scans when the body is disposed", async () => {
  const text = "x".repeat(LARGE_BODY_PAGE_SIZE * 6) + "Needle";
  await withSearcher(text, async searcher => {
    const controller = new AbortController();
    const stale = searcher.find("missing", 0, 1, controller.signal);
    const current = searcher.find("needle", 0, 1, signal);
    controller.abort();
    await assert.rejects(stale, { name: "AbortError" });
    assert.deepEqual(await current, { from: text.length - 6, to: text.length });

    const disposed = searcher.find("missing", 0, 1, signal);
    searcher.dispose();
    await assert.rejects(disposed, { name: "AbortError" });
    await assert.rejects(searcher.find("needle", 0, 1, signal), { name: "AbortError" });
  });
});

test("matches varied deterministic bodies, query slices, and navigation boundaries", async () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const { text, queries, offsets } = generatedFixture(seed);
    await withSearcher(text, async searcher => {
      for (let index = 0; index < queries.length; index += 1) {
        await assertMatchesReference(searcher, text, queries[index], offsets[index]);
      }
    });
  }
});

async function withSearcher(text, run) {
  const searcher = await createBodySearcher(module, text);
  try {
    await run(searcher);
  } finally {
    searcher.dispose();
  }
}

async function assertMatchesReference(searcher, text, query, from) {
  for (const direction of [1, -1]) {
    const expected = await findLargeBodyMatch(text, query, from, direction, signal);
    assert.deepEqual(await searcher.find(query, from, direction, signal), expected,
      JSON.stringify({ query, from, direction, bodyLength: text.length }));
  }
}

function generatedFixture(seed) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const tokens = ["a", "A", "b", "B", "😀", "\ud83d", "\ude00", "\r\n", "[", ".*", "Σ", "ς", "K", "k", "ſ", "S", "𐐀", "𐐨", "İ", "ı", "ß", "ẞ", "é", "e\u0301"];
  const parts = Array.from({ length: 80 + next() % 160 }, () => tokens[next() % tokens.length]);
  const prefix = seed % 10 === 0 ? "z".repeat(LARGE_BODY_PAGE_SIZE - 30 + next() % 60) : "";
  const text = prefix + parts.join("");
  const start = prefix.length + next() % (text.length - prefix.length);
  const queries = [text.slice(start, start + 1 + next() % 12), tokens[next() % tokens.length], "not-present", "aA", "😀", "\ud83d"];
  const offsets = [start, prefix.length + next() % (text.length - prefix.length), 0, text.length, start + 1, text.length];
  return { text, queries, offsets };
}
