// Defines the shared JSONC editor language; jsonLanguage retains the tree used by folds and completion.
import {
  continuedIndent, foldInside, foldNodeProp, indentNodeProp, LanguageSupport, LRLanguage,
} from "@codemirror/language";
import { styleTags, tags } from "@lezer/highlight";
import { parser } from "../json/parser";

/** JSON syntax with line/block comments and one optional trailing comma per container. */
export const jsonLanguage = LRLanguage.define({
  name: "json",
  parser: parser.configure({
    props: [
      styleTags({
        String: tags.string,
        Number: tags.number,
        "True False": tags.bool,
        PropertyName: tags.propertyName,
        Null: tags.null,
        LineComment: tags.lineComment,
        BlockComment: tags.blockComment,
        ", :": tags.separator,
        "[ ]": tags.squareBracket,
        "{ }": tags.brace,
      }),
      indentNodeProp.add({
        Object: continuedIndent({ except: /^\s*\}/ }),
        Array: continuedIndent({ except: /^\s*\]/ }),
      }),
      foldNodeProp.add({ "Object Array": foldInside }),
    ],
  }),
  languageData: {
    closeBrackets: { brackets: ["[", "{", '"'] },
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    indentOnInput: /^\s*[\}\]]$/,
  },
});

/** Installs the same incremental language used by JSON indentation, folds, and completion. */
export function json(): LanguageSupport {
  return new LanguageSupport(jsonLanguage);
}
