// Inspects the query text written in a request URL without resolving variables or normalizing its encoding.
import type { RequestInputMode } from "./request";

/** One literal URL parameter, kept in source order rather than merged by name. */
export interface UrlQueryParameter {
  /** Name exactly as written, including percent escapes, plus signs, and placeholders. */
  name: string;
  /** Text after the first equals sign; undefined means the parameter has no equals sign. */
  value: string | undefined;
}

/** Read-only query projection used for display and selecting its original URL source. */
export interface UrlQuery {
  /** First character after the URL's query marker, for focusing the editable source. */
  start: number;
  /** First fragment character or end of source; the fragment is never part of the query. */
  end: number;
  /** Nonempty source segments in order; duplicate and unnamed parameters remain distinct. */
  parameters: UrlQueryParameter[];
}

/** Reads saved URL syntax in its input mode; transport preparation owns its resolved meaning. */
export function inspectUrlQuery(source: string, inputMode: RequestInputMode = "template"): UrlQuery | undefined {
  // A placeholder name may itself contain URL delimiters. Treat complete placeholders
  // as opaque only in template mode. Imported inputs and captured replay use literal
  // URL syntax, where delimiters inside braces retain their ordinary URL meaning.
  const delimiterPattern = inputMode === "literal" ? /[?#&=]/g : /\{\{[^{}]*\}\}|[?#&=]/g;
  const delimiters = [...source.matchAll(delimiterPattern)]
    .filter(match => match[0].length === 1)
    .map(match => ({ value: match[0], offset: match.index! }));
  const queryMarker = delimiters.find(delimiter => delimiter.value === "?" || delimiter.value === "#");
  if (queryMarker?.value !== "?") return undefined;

  const start = queryMarker.offset + 1;
  const end = delimiters.find(delimiter => delimiter.value === "#" && delimiter.offset >= start)?.offset ?? source.length;
  const queryDelimiters = delimiters.filter(delimiter => delimiter.offset >= start && delimiter.offset < end);
  const boundaries = [start - 1, ...queryDelimiters.filter(delimiter => delimiter.value === "&").map(delimiter => delimiter.offset), end];
  const parameters: UrlQueryParameter[] = [];
  for (let index = 1; index < boundaries.length; index++) {
    const segmentStart = boundaries[index - 1] + 1;
    const segmentEnd = boundaries[index];
    if (segmentStart === segmentEnd) continue;

    const equals = queryDelimiters.find(delimiter => delimiter.value === "="
      && delimiter.offset >= segmentStart && delimiter.offset < segmentEnd)?.offset;
    parameters.push({
      name: source.slice(segmentStart, equals ?? segmentEnd),
      value: equals === undefined ? undefined : source.slice(equals + 1, segmentEnd),
    });
  }

  return { start, end, parameters };
}
