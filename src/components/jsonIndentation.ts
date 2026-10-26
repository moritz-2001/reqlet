// Infers local JSON indentation from CodeMirror syntax; JsonNewlineEdit describes one undoable edit.
import { jsonLanguage } from "./jsonLanguage";
import type { Tree } from "@lezer/common";

/** One replacement in the original source and its resulting collapsed selection. */
export interface JsonNewlineEdit {
  /** Inclusive UTF-16 offset of the replaced text in the original body. */
  readonly from: number;
  /** Exclusive UTF-16 offset; equal to from for a simple insertion. */
  readonly to: number;
  /** Replacement text, including line breaks and inferred indentation. */
  readonly insert: string;
  /** Collapsed UTF-16 caret position in the resulting body. */
  readonly caret: number;
}

/** Calculates Enter without changing source outside the returned range.
 * The tree must describe this exact LF-normalized source, using UTF-16 editor offsets.
 * Selected text is excluded from structural and indentation evidence.
 */
export function jsonNewlineEdit(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  tree: Tree,
): JsonNewlineEdit {
  const removed = selectionEnd - selectionStart;
  const source = removed ? text.slice(0, selectionStart) + text.slice(selectionEnd) : text;
  const retainedTree = removed ? jsonLanguage.parser.parse(source) : tree;
  const sourceLines = indexSourceLines(source);
  const position = selectionStart;
  const line = lineAt(sourceLines, position);
  const context = sourceContext(source, retainedTree, position, sourceLines);
  const retainedTokens = context.tokens;
  const unit = indentationUnit(context.lines, context.active, position);
  const frame = context.active[context.active.length - 1];
  const previous = [...retainedTokens].reverse().find(token => token.to <= position);
  const following = retainedTokens.find(token => token.from >= position);
  const inString = retainedTokens.some(token => containsStringCaret(source, token, position));
  const inComment = retainedTokens.some(token => containsCommentCaret(source, token, position));
  const afterOpener = previous?.kind === "punctuation" && "{[".includes(source[previous.from]!)
    && /^[ \t]*$/.test(source.slice(previous.to, position));
  const beforeCloser = following?.kind === "punctuation" && frame?.close === source[following.from]!
    && /^[ \t]*$/.test(source.slice(position, following.from));
  let from = position;
  let to = position;
  let prefix = line.prefix;
  let closingLine = "";

  if (!inString && !inComment) {
    // Horizontal whitespace after the caret belongs to the new line, not to its content.
    to += source.slice(position).match(/^[ \t]*/)![0].length;
    if (frame && lineAt(sourceLines, frame.from).from === line.from) {
      prefix = childPrefix(frame, context.lines, unit, position);
    }
    if (frame && afterOpener) {
      from = previous!.to;
      prefix = childPrefix(frame, context.lines, unit, position);
      if (beforeCloser) closingLine = `\n${containerPrefix(frame, unit)}`;
    } else if (frame && beforeCloser) {
      prefix = containerPrefix(frame, unit);
    } else if (previous && "]}".includes(source[previous.from]!) && previous.kind === "punctuation"
      && /^[ \t]*$/.test(source.slice(previous.to, position))) {
      const completed = context.containers.find(container => container.end === previous.from);
      if (completed) prefix = containerPrefix(completed, unit);
    }
  }

  const insert = `\n${prefix}${closingLine}`;
  return { from, to: to + removed, insert, caret: from + 1 + prefix.length };
}

// Containers retain identity so line evidence can be ranked by the caret's enclosing scopes.
interface Container {
  from: number;
  end?: number;
  close: string;
  prefix: string;
  // Structural depth and the first token's depth differ for containers opened inline.
  depth: number;
  lineDepth: number;
}

interface ContentLine {
  from: number;
  prefix: string;
  depth: number;
  parent?: Container;
}

// These are parser leaf ranges used only to inspect neighbors, never a separate tokenizer.
interface SyntaxToken {
  kind: "string" | "key" | "punctuation" | "value" | "line-comment" | "block-comment";
  from: number;
  to: number;
}

// Index each logical line once. Repeated backward newline searches for parser nodes
// otherwise make an Enter in a long minified document quadratic in source length.
interface SourceLine {
  from: number;
  prefix: string;
}

function sourceContext(source: string, tree: Tree, position: number, sourceLines: readonly SourceLine[]) {
  const stack: Container[] = [];
  const containers: Container[] = [];
  const lines: ContentLine[] = [];
  const tokens: SyntaxToken[] = [];
  let currentLine = -1;
  let lineDepth = 0;

  tree.iterate({
    enter(node) {
      const isContainer = node.name === "Object" || node.name === "Array";
      if (isContainer) {
        const line = lineAt(sourceLines, node.from);
        const close = node.name === "Object" ? "}" : "]";
        const container = {
          from: node.from,
          end: source[node.to - 1] === close ? node.to - 1 : undefined,
          close, prefix: line.prefix, depth: stack.length,
          lineDepth: line.from === currentLine ? lineDepth : stack.length,
        };
        containers.push(container);
        stack.push(container);
      }
      if (node.node.firstChild || node.from === node.to) return;

      const value = source.slice(node.from, node.to);
      const kind = node.name === "LineComment" ? "line-comment"
        : node.name === "BlockComment" ? "block-comment"
        : node.name === "String" || node.type.isError && value.startsWith('"') ? "string"
        : node.name === "PropertyName" ? "key"
        : "{}[],:".includes(node.name) ? "punctuation" : "value";
      // Lezer can recover an unfinished quote as an error followed by structural nodes.
      // Keep the rest of that logical line in string context for the newline fallback.
      const end = kind === "string" && node.type.isError && value === '"'
        ? (source.indexOf("\n", node.to) < 0 ? source.length : source.indexOf("\n", node.to)) : node.to;
      tokens.push({ kind, from: node.from, to: end });
      // Comment indentation describes prose, so it must not set the surrounding JSON style.
      if (kind === "line-comment" || kind === "block-comment") return;

      const line = lineAt(sourceLines, node.from);
      const opener = node.name === "{" || node.name === "[";
      const closer = node.name === "}" || node.name === "]";
      const depth = stack.length - (opener || closer ? 1 : 0);
      if (line.from !== currentLine) {
        currentLine = line.from;
        lineDepth = depth;
        if (!closer) lines.push({
          from: node.from, prefix: line.prefix, depth,
          parent: stack[stack.length - (opener ? 2 : 1)],
        });
      } else if (closer) {
        lineDepth = Math.min(lineDepth, depth);
      }
    },
    leave(node) {
      if (node.name === "Object" || node.name === "Array") stack.pop();
    },
  });
  const active = containers.filter(container => container.from < position
    && (container.end === undefined ? tree.length >= position : container.end >= position));
  return { active, containers, lines, tokens };
}

function indentationUnit(lines: readonly ContentLine[], active: readonly Container[], position: number): string {
  const evidence = lines.flatMap(line => {
    const parent = line.parent;
    if (!parent || !line.prefix.startsWith(parent.prefix)) return [];

    const unit = repeatedUnit(line.prefix.slice(parent.prefix.length), line.depth - parent.lineDepth);
    return unit ? [{ ...line, unit }] : [];
  });
  for (const parent of [...active].reverse()) {
    const local = nearest(evidence.filter(line => line.parent === parent), position);
    if (local) return local.unit;
  }

  const global = nearest(evidence, position);
  if (global) return global.unit;

  const inferred = nearest(lines.flatMap(line => {
    const unit = repeatedUnit(line.prefix, line.depth);
    return unit ? [{ ...line, unit }] : [];
  }), position);
  return inferred?.unit ?? "  ";
}

function childPrefix(container: Container, lines: readonly ContentLine[], unit: string, position: number): string {
  const existing = nearest(lines.filter(line => line.parent === container
    && line.prefix.length > 0 && line.prefix !== container.prefix), position);
  return existing?.prefix ?? containerPrefix(container, unit) + unit;
}

function containerPrefix(container: Container, unit: string): string {
  return container.prefix + unit.repeat(container.depth - container.lineDepth);
}

function repeatedUnit(prefix: string, levels: number): string | undefined {
  if (levels <= 0 || !prefix.length || prefix.length % levels !== 0) return undefined;

  const unit = prefix.slice(0, prefix.length / levels);
  return unit.repeat(levels) === prefix ? unit : undefined;
}

function nearest<T extends { from: number }>(values: readonly T[], position: number): T | undefined {
  return values.reduce<T | undefined>((best, value) => {
    const distance = Math.abs(value.from - position);
    const bestDistance = best ? Math.abs(best.from - position) : Infinity;
    return distance < bestDistance || (distance === bestDistance && value.from < best!.from) ? value : best;
  }, undefined);
}

function indexSourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  do {
    lines.push({ from, prefix: source.slice(from).match(/^[ \t]*/)![0] });
    from = source.indexOf("\n", from) + 1;
  } while (from > 0);
  return lines;
}

function lineAt(lines: readonly SourceLine[], position: number): SourceLine {
  let low = 0;
  let high = lines.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.from <= position) low = middle;
    else high = middle;
  }
  return lines[low]!;
}

function containsStringCaret(source: string, token: SyntaxToken, position: number): boolean {
  if ((token.kind !== "key" && token.kind !== "string") || position <= token.from || position > token.to) return false;
  if (position < token.to) return true;

  // A token ending at the caret may be an unfinished string, including an escaped final quote.
  let escaped = false;
  for (let offset = token.from + 1; offset < token.to; offset += 1) {
    const char = source[offset]!;
    if (!escaped && char === '"') return false;
    escaped = !escaped && char === "\\";
  }
  return true;
}

function containsCommentCaret(source: string, token: SyntaxToken, position: number): boolean {
  if (position <= token.from || position > token.to) return false;
  if (token.kind === "line-comment") return true;

  return token.kind === "block-comment" && (position < token.to
    || source.slice(token.to - 2, token.to) !== "*/");
}
