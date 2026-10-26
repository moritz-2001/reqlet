// Resolves the tolerant JSON tree against a catalog; completion edits only the token at the caret.
import { syntaxTree } from '@codemirror/language';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { SyntaxNode } from '@lezer/common';
import type { ProtobufContext, ProtoField } from '../protobuf';

/** Installs synchronous, editor-local assistance for a resolved protobuf message. */
export function protobufCompletion(model: ProtobufContext) {
  return autocompletion({ override: [context => completeProtobuf(context, model)] });
}

/** Maps an incomplete JSON caret context to local replacement ranges and suggestions. */
export function completeProtobuf(context: CompletionContext, model: ProtobufContext): CompletionResult | null {
  const { state, pos } = context;
  const prefix = state.sliceDoc(0, pos);
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);
  if (node.name === 'LineComment' || node.name === 'BlockComment' && (pos < node.to
    || state.sliceDoc(node.to - 2, node.to) !== '*/')) return null;

  const placeholderStart = prefix.lastIndexOf('{{');
  if (placeholderStart > prefix.lastIndexOf('}}')) {
    const marker = tree.resolveInner(placeholderStart + 1, -1);
    if (marker.to >= pos && marker.name !== 'LineComment' && marker.name !== 'BlockComment') return null;
  }

  let object: SyntaxNode | null = node;
  while (object && object.name !== 'Object') object = object.parent;
  if (!object) return null;

  const path: string[] = [];
  for (let parent = object.parent; parent; parent = parent.parent) {
    if (parent.name === 'Property') {
      const key = parent.getChild('PropertyName');
      if (key) path.unshift(readKey(state.sliceDoc(key.from, key.to)));
    }
  }
  let type = model.messageName;
  let map = false;
  for (const key of path) {
    if (map) { map = false; continue; }
    const field = model.catalog.messages[type]?.find(f => f.name === key || f.jsonName === key);
    if (!field) return null;
    type = field.mapValue || field.type;
    map = !!field.mapValue;
  }
  if (isSpecial(type) && type !== 'google.protobuf.Any') return null;
  const fields = map ? [] : type === 'google.protobuf.Any' ? [{ name: '@type', jsonName: '@type', type: 'string', repeated: false, documentation: 'Type URL of the embedded message.' }] : model.catalog.messages[type];
  if (!fields) return null;

  let property: SyntaxNode | null = node;
  while (property && property.name !== 'Property' && property.from !== object.from) property = property.parent;
  const key = property?.name === 'Property' ? property.getChild('PropertyName') : null;
  const keyMode = !key || pos <= key.to;
  if (!keyMode && key) {
    const separator = property?.getChild(':');
    if (!separator || pos < separator.to) return null;
    const field = fields.find(f => f.name === readKey(state.sliceDoc(key.from, key.to)) || f.jsonName === readKey(state.sliceDoc(key.from, key.to)));
    const valueType = map ? type : field?.type;
    if (!valueType) return null;
    const values = model.catalog.enums[valueType] ?? (valueType === 'bool' ? ['true', 'false'] : []);
    if (!values.length) return null;
    // Array elements own their token ranges; the enclosing property owns only the array.
    const value = ['String', 'True', 'False', 'Null', 'Number'].includes(node.name) ? node
      : property?.getChild('String') ?? property?.getChild('True') ?? property?.getChild('False');
    const match = context.matchBefore(/\w*/);
    const from = value?.from ?? match?.from ?? pos;
    const to = value?.to ?? pos;
    const quoted = state.sliceDoc(from, from + 1) === '"';
    return {
      // Filtering reads only the prefix before the caret. Acceptance replaces the whole token.
      from: Math.min(quoted ? from + 1 : from, pos), to: pos,
      options: values.map(label => ({
        label, type: 'enum',
        apply(view) {
          const insert = valueType === 'bool' ? label : JSON.stringify(label);
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
        },
      })),
    };
  }
  if (map) return null;

  const used = new Set<string>();
  const groups = new Set<string>();
  for (let child = object.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'Property' || (child.from === property?.from && child.to === property?.to)) continue;
    const name = child.getChild('PropertyName');
    if (!name) continue;
    const field = fields.find(f => f.name === readKey(state.sliceDoc(name.from, name.to)) || f.jsonName === readKey(state.sliceDoc(name.from, name.to)));
    if (field) {
      used.add(field.name);
      if (field.oneof && (['google.protobuf.NullValue', 'google.protobuf.Value'].includes(field.type)
        || !child.getChild('Null'))) groups.add(field.oneof);
    }
  }
  // A completed block comment may end exactly at the caret. It is never part of a key replacement.
  const token = node.name === 'BlockComment' ? null : context.matchBefore(/"?[^"\s{},:]*"?/);
  const keyStart = key?.from ?? token?.from ?? pos;
  return {
    from: Math.min(keyStart + (state.sliceDoc(keyStart, keyStart + 1) === '"' ? 1 : 0), pos), to: pos,
    options: fields.filter(f => !used.has(f.name) && (!f.oneof || !groups.has(f.oneof))).map(field => ({
      label: field.jsonName, detail: field.type, info: field.documentation,
      apply(view) {
        const from = keyStart;
        const to = key?.to ?? token?.to ?? pos;
        const existingValue = !!(key && property?.getChild(':'));
        const value = initialValue(field, model);
        const insert = existingValue ? JSON.stringify(field.jsonName) : `${JSON.stringify(field.jsonName)}: ${value}`;
        const inside = !existingValue && ['""', '{}', '[]'].includes(value);
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length - (inside ? 1 : 0) }, userEvent: 'input.complete' });
      },
      type: 'property',
    })),
  };
}
function readKey(text: string): string {
  try { return JSON.parse(text); } catch { return text.replace(/^"|"$/g, ''); }
}
function isSpecial(type: string) { return type.startsWith('google.protobuf.') && type !== 'google.protobuf.Empty'; }
function initialValue(field: ProtoField, model: ProtobufContext): string {
  if (field.repeated) return '[]';
  if (field.mapValue) return '{}';
  if (field.type === 'bool' || field.type === 'google.protobuf.BoolValue') return 'false';
  if (['google.protobuf.Struct', 'google.protobuf.Any'].includes(field.type)) return '{}';
  if (field.type === 'google.protobuf.ListValue') return '[]';
  if (['google.protobuf.Value', 'google.protobuf.NullValue'].includes(field.type)) return 'null';
  if (['google.protobuf.DoubleValue', 'google.protobuf.FloatValue', 'google.protobuf.Int32Value', 'google.protobuf.UInt32Value'].includes(field.type)) return '0';
  if (model.catalog.enums[field.type]) return JSON.stringify(model.catalog.enums[field.type]![0] ?? '');
  if (model.catalog.messages[field.type] && !isSpecial(field.type)) return '{}';
  if (/^(u?int|sint|fixed|sfixed)32$|^(float|double)$/.test(field.type)) return '0';
  return '""';
}
