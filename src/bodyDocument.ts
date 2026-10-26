// BodyDocument retains an immutable editor revision without flattening its shared text storage on every edit.
import { Text } from "@codemirror/state";
import { markRaw } from "vue";

/** Request bodies are ordinary strings at interchange boundaries and immutable documents while editing. */
export type BodySource = string | BodyDocument;

/**
 * One complete, immutable body revision. Adjacent revisions share unchanged text
 * storage, so retaining the current body does not copy it after every keystroke.
 * The object identity is its revision token; editor views and undo history remain
 * outside the workspace. JSON export materializes the exact current source.
 */
export class BodyDocument {
  /** Persistent text shared with the editor transaction; consumers must never mutate its internals. */
  readonly text: Text;
  /** UTF-16 source length, available without producing a complete string. */
  readonly length: number;
  /** Lazily populated at Send, copy, export, or persistence; reused for this immutable revision. */
  private materialized: string | undefined;

  constructor(text: Text) {
    this.text = text;
    this.length = text.length;
    // Vue must observe replacement revisions, not walk CodeMirror's shared rope
    // nodes or proxy the private cache used when a string is explicitly requested.
    markRaw(this);
  }

  /** Materializes this revision once; later edits produce a different document. */
  toString(): string {
    return this.materialized ??= this.text.toString();
  }

  /** Keeps portable exports and legacy workspace serialization compatible with string bodies. */
  toJSON(): string {
    return this.toString();
  }
}

/** Distinguishes trusted live documents from strings and untrusted deserialized objects. */
export function isBodyDocument(value: unknown): value is BodyDocument {
  return value instanceof BodyDocument;
}

/** Captures exact current source for operations requiring a complete string. */
export function bodyText(source: BodySource): string {
  return typeof source === "string" ? source : source.toString();
}

/** Shares a live revision with an editor, normalizing imported string line endings only on entry. */
export function bodyEditorText(source: BodySource): Text {
  return isBodyDocument(source) ? source.text : Text.of(source.split(/\r\n?|\n/));
}
