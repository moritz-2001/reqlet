// Validates JSON body syntax and projects JSONC source into strict JSON without decoding payload values.
import type { Tree } from "@lezer/common";
import { parser } from "./json/parser.ts";

/** Parses complete JSON with comments and trailing commas, rejecting recovered/incomplete syntax.
 * Returned ranges address the original UTF-16 source, including comments and whitespace.
 * Throws SyntaxError with the first invalid source position; parsed values are never materialized.
 */
export function parseJsonSource(text: string): Tree {
  const tree = parser.parse(text);
  tree.iterate({
    enter(node) {
      // The editor keeps an unfinished block comment as one token while typing. Complete
      // source operations must reject it rather than silently stripping the rest of the body.
      const unfinishedComment = node.name === "BlockComment" && !isClosedBlockComment(text, node.from, node.to);
      if (node.type.isError || unfinishedComment) throw new SyntaxError(`Invalid JSON at position ${node.from}.`);
    },
  });
  return tree;
}

/** Replaces comments and trailing commas with whitespace, producing strict JSON.
 * Preserves string/number spelling, duplicate keys, line endings, and UTF-16 offsets.
 * Ordinary JSON is returned unchanged. Throws SyntaxError for malformed source.
 */
export function toStrictJson(text: string): string {
  return maskJsonExtensions(text, parseJsonSource(text), true);
}

/** Masks complete JSON comments before resolving template values, retaining source offsets.
 * Accepts incomplete JSON so bare environment placeholders can be resolved before validation.
 * An unfinished block comment remains unchanged; toStrictJson still rejects malformed results.
 */
export function stripJsonComments(text: string): string {
  return maskJsonExtensions(text, parser.parse(text), false);
}

function maskJsonExtensions(text: string, tree: Tree, trailingCommas: boolean): string {
  const parts: string[] = [];
  let from = 0;
  tree.iterate({
    enter(node) {
      const comment = node.name === "LineComment"
        || node.name === "BlockComment" && isClosedBlockComment(text, node.from, node.to);
      let trailingComma = false;
      if (trailingCommas && node.name === ",") {
        let following = node.node.nextSibling;
        while (following?.name === "LineComment" || following?.name === "BlockComment") {
          following = following.nextSibling;
        }
        trailingComma = following?.name === "}" || following?.name === "]";
      }
      if (!comment && !trailingComma) return;

      parts.push(text.slice(from, node.from), text.slice(node.from, node.to).replace(/[^\r\n]/g, " "));
      from = node.to;
    },
  });
  return from ? parts.join("") + text.slice(from) : text;
}

function isClosedBlockComment(text: string, from: number, to: number): boolean {
  return to - from >= 4 && text.slice(to - 2, to) === "*/";
}
