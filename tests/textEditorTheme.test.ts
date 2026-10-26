// Verifies that mounting the editor theme produces CSS accepted by the DOM parser.
import type {} from "vitest/jsdom";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import { editorTheme } from "../src/components/textEditor";

it("mounts the editor theme without CSS parsing errors", () => {
  const errors: Error[] = [];
  const recordError = (error: Error & { type?: string }) => {
    if (error.type === "css-parsing") errors.push(error);
  };
  const host = document.createElement("div");
  document.body.append(host);
  jsdom.virtualConsole.on("jsdomError", recordError);

  let view: EditorView | undefined;
  try {
    view = new EditorView({ parent: host, extensions: [editorTheme] });
    expect(errors).toEqual([]);
  } finally {
    view?.destroy();
    host.remove();
    jsdom.virtualConsole.off("jsdomError", recordError);
  }
});
