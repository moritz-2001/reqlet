// Formats JSONC source while preserving payload tokens, comments, and trailing commas.
import { parseJsonSource } from "../json.ts";

/** Returns indented JSON without rounding large numbers or rewriting strings and comments.
 * Throws SyntaxError for invalid JSON so callers can leave the original body untouched.
 * An optional inclusive UTF-16 output budget throws JsonFormatLimitError instead of
 * returning partial text. Omitting it leaves explicit formatting unbounded.
 */
export function formatJson(text: string, maxLength = Infinity): string {
  if (!(maxLength >= 0)) throw new RangeError("The formatted output limit must be nonnegative.");

  const tokens: { name: string; from: number; to: number }[] = [];
  parseJsonSource(text).iterate({
    enter(node) {
      if (!node.node.firstChild) tokens.push({ name: node.name, from: node.from, to: node.to });
    },
  });
  let depth = 0;
  let formatted = "";
  // A number defers newline/indentation allocation until a token consumes it;
  // trailing generated whitespace is discarded and does not count toward output.
  // Keeping it separate also prevents separators from trimming comment text.
  let spacing: number | " " | undefined;
  const newline = () => {
    spacing = formatted ? depth : undefined;
  };
  const append = (value: string) => {
    const spacingLength = typeof spacing === "number" ? 1 + spacing * 2 : spacing?.length ?? 0;
    if (formatted.length + spacingLength + value.length > maxLength) throw new JsonFormatLimitError(maxLength);

    const whitespace = typeof spacing === "number" ? `\n${"  ".repeat(spacing)}` : spacing ?? "";
    formatted += whitespace + value;
    spacing = undefined;
  };

  for (const [index, token] of tokens.entries()) {
    const value = text.slice(token.from, token.to);
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const nextInlineComment = next && isComment(next.name) && !hasNewline(text.slice(token.to, next.from));
    if (value === "{" || value === "[") {
      append(value);
      depth += 1;
      if (next?.name !== "}" && next?.name !== "]") newline();
    } else if (value === "}" || value === "]") {
      depth -= 1;
      if (previous?.name !== "{" && previous?.name !== "[") newline();
      append(value);
    } else if (value === ",") {
      append(",");
      if (nextInlineComment) spacing = " ";
      else newline();
    } else if (value === ":") {
      append(":");
      spacing = " ";
    } else if (isComment(token.name)) {
      if (previous && hasNewline(text.slice(previous.to, token.from))) newline();
      else if (formatted && spacing === undefined && !/\s$/.test(formatted)) spacing = " ";
      append(value);
      if (token.name === "LineComment" || next && hasNewline(text.slice(token.to, next.from))) newline();
      else if (next && ![",", ":", "}", "]"].includes(next.name)) spacing = " ";
    } else {
      append(value);
    }
  }

  return formatted;
}

/** The caller's formatted-output budget was exceeded; no partial formatted body is returned. */
export class JsonFormatLimitError extends RangeError {
  constructor(maxLength: number) {
    super(`Formatted JSON exceeds ${maxLength} UTF-16 code units.`);
    this.name = "JsonFormatLimitError";
  }
}

function isComment(name: string): boolean {
  return name === "LineComment" || name === "BlockComment";
}

function hasNewline(text: string): boolean {
  return /[\r\n]/.test(text);
}
