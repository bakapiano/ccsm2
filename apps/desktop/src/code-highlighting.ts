import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--green)",
  },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--orange)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--blue)" },
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    color: "var(--accent)",
    fontWeight: "600",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "var(--yellow)",
  },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
    color: "var(--blue)",
  },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--ink-mid)" },
  { tag: tags.invalid, color: "var(--red)" },
]);
