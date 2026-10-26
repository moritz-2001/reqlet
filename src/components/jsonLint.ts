// Reports one JSONC diagnostic while preserving the source offsets used by the editor.
import type { Text } from "@codemirror/state";
import type { LintSource } from "@codemirror/lint";
import { parseJsonSource } from "../json";

/** Validates the editor's JSON with comments and trailing commas through the shared body parser. */
export function jsonParseLinter(): LintSource {
  return view => {
    try {
      parseJsonSource(view.state.doc.toString());
      return [];
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;

      const position = errorPosition(error, view.state.doc);
      return [{ from: position, to: position, severity: "error", message: error.message }];
    }
  };
}

function errorPosition(error: SyntaxError, doc: Text): number {
  const position = error.message.match(/at position (\d+)/);
  if (position) return Math.min(Number(position[1]), doc.length);

  const lineColumn = error.message.match(/at line (\d+) column (\d+)/);
  if (lineColumn) {
    const line = doc.line(Math.min(Number(lineColumn[1]), doc.lines));
    return Math.min(line.from + Number(lineColumn[2]) - 1, doc.length);
  }
  return 0;
}
