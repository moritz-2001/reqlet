// Builds bounded, editable OpenAPI examples; OpenApiValueContext shares local reference resolution and diagnostics.

/** An OpenAPI object after the input document has been checked for safe JSON-compatible values. */
export type OpenApiObject = Record<string, unknown>;

/** JSON Schema allows true for any value and false for no value, alongside object schemas. */
export type OpenApiSchema = OpenApiObject | boolean;

/** Dependencies shared by sample generation without performing I/O or owning the parsed document. */
export interface OpenApiValueContext {
  /** Resolves object references, rejecting scalar targets. External references add a warning and return undefined. */
  resolve: (value: unknown, label: string) => OpenApiObject | undefined;
  /** Resolves object or boolean schemas, retaining adjacent keywords in OpenAPI 3.1. Undefined means absent or omitted. */
  resolveSchema: (value: unknown, label: string) => OpenApiSchema | undefined;
  /** Adds a deduplicated, user-visible explanation of an omitted or approximated feature. */
  warn: (message: string) => void;
}

/** Selects an explicit media/parameter example before generating a bounded value from its schema. */
export function openApiExample(source: OpenApiObject, context: OpenApiValueContext, label: string): unknown {
  const checked = (value: unknown) => {
    jsonLength(value, label, MAX_VALUE_LENGTH);
    return value;
  };
  if (hasOwn(source, "example")) return checked(source.example);
  if (isOpenApiObject(source.examples)) {
    for (const [name, rawExample] of Object.entries(source.examples)) {
      const example = context.resolve(rawExample, `${label} example ${name}`);
      if (example && hasOwn(example, "value")) return checked(example.value);
      if (example?.externalValue !== undefined) {
        context.warn(`${label}: external example files are not loaded; a schema sample is used when available.`);
      }
    }
  }
  return checked(sampleSchema(source.schema, context, label, new Set(), 0, { remaining: 1000, textRemaining: MAX_VALUE_LENGTH }));
}

/** Distinguishes JSON objects from arrays, scalars, and absent OpenAPI fields. */
export function isOpenApiObject(value: unknown): value is OpenApiObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Converts one scalar example to editable text, preserving false, zero, and explicit null. */
export function openApiScalar(value: unknown): string {
  if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) throw sampleSizeError("OpenAPI parameter");
  return value === undefined ? "" : value === null ? "null"
    : typeof value === "object" ? openApiJson(value, "OpenAPI parameter") : String(value);
}

/** Checks expanded JSON size before serializing so shared aliases or schema examples cannot allocate an unbounded string. */
export function openApiJson(value: unknown, label: string, pretty = false): string {
  if (value === undefined) return "";
  jsonLength(value, label, MAX_VALUE_LENGTH, pretty);
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

/** Checks document-owned keys without following object prototypes or requiring newer browser APIs. */
export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const MAX_SAMPLE_DEPTH = 8;
const MAX_SAMPLE_PROPERTIES = 100;
const MAX_VALUE_LENGTH = 2 * 1024 * 1024;

function sampleSchema(
  rawSchema: unknown,
  context: OpenApiValueContext,
  label: string,
  ancestors: ReadonlySet<OpenApiObject>,
  depth: number,
  budget: { remaining: number; textRemaining: number },
): unknown {
  if (--budget.remaining < 0) {
    context.warn("Schema sample generation reached its complexity limit; some nested values were omitted.");
    return undefined;
  }
  const schema = context.resolveSchema(rawSchema, `${label} schema`);
  if (schema === undefined || schema === false) return undefined;
  if (schema === true) return {};
  if (ancestors.has(schema) || depth >= MAX_SAMPLE_DEPTH) {
    context.warn(`${label}: recursive or deeply nested schema samples are truncated.`);
    return undefined;
  }
  const explicit = (value: unknown) => {
    budget.textRemaining -= jsonLength(value, label, budget.textRemaining);
    return value;
  };
  if (hasOwn(schema, "example")) return explicit(schema.example);
  if (Array.isArray(schema.examples) && schema.examples.length) return explicit(schema.examples[0]);
  if (hasOwn(schema, "default")) return explicit(schema.default);
  if (hasOwn(schema, "const")) return explicit(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return explicit(schema.enum[0]);

  const visited = new Set(ancestors).add(schema);
  const sample = (value: unknown, childLabel = label) => sampleSchema(value, context, childLabel, visited, depth + 1, budget);
  for (const keyword of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[keyword]) && schema[keyword].length) {
      context.warn(`${label}: a sample uses the first ${keyword} alternative; review it before sending.`);
      const value = sample(schema[keyword][0]);
      const ownProperties = sampleObject(schema, context, label, sample);
      return isOpenApiObject(value) && Object.keys(ownProperties).length
        ? Object.fromEntries([...Object.entries(value), ...Object.entries(ownProperties)]) : value;
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const values = schema.allOf.map(value => sample(value)).filter(value => value !== undefined);
    const ownProperties = sampleObject(schema, context, label, sample);
    if (values.every(isOpenApiObject)) {
      return Object.fromEntries([...values.flatMap(Object.entries), ...Object.entries(ownProperties)]);
    }
    context.warn(`${label}: allOf constraints cannot all be combined into a scalar sample; review it before sending.`);
    return values[0];
  }

  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== "null") ?? "null" : schema.type;
  switch (type ?? (schema.properties || schema.additionalProperties ? "object" : schema.items ? "array" : "string")) {
    case "object": return sampleObject(schema, context, label, sample);
    case "array": {
      const count = schema.maxItems === 0 ? 0 : Math.min(3, Math.max(1, finiteNumber(schema.minItems) ?? 1));
      const item = sample(schema.items, `${label} item`);
      return item === undefined ? [] : Array.from({ length: count }, () => item);
    }
    case "integer": return sampleNumber(schema, true);
    case "number": return sampleNumber(schema, false);
    case "boolean": return false;
    case "null": return null;
    case "string": return sampleString(schema, context, label);
    default:
      context.warn(`${label}: unsupported schema type ${String(type)} has no generated sample.`);
      return undefined;
  }
}

function sampleObject(
  schema: OpenApiObject,
  context: OpenApiValueContext,
  label: string,
  sample: (value: unknown, childLabel?: string) => unknown,
): OpenApiObject {
  const properties = isOpenApiObject(schema.properties) ? Object.entries(schema.properties) : [];
  if (properties.length > MAX_SAMPLE_PROPERTIES) {
    context.warn(`${label}: only the first ${MAX_SAMPLE_PROPERTIES} schema properties are sampled.`);
  }
  const entries: [string, unknown][] = [];
  for (const [name, rawProperty] of properties.slice(0, MAX_SAMPLE_PROPERTIES)) {
    const property = context.resolveSchema(rawProperty, `${label}.${name} schema`);
    if (isOpenApiObject(property) && property.readOnly === true) continue;
    const value = sample(rawProperty, `${label}.${name}`);
    if (value !== undefined) entries.push([name, value]);
  }
  if (!properties.length && isOpenApiObject(schema.additionalProperties)) {
    const additional = context.resolveSchema(schema.additionalProperties, `${label}.key schema`);
    // Boolean map schemas declare no keys; references keep the same empty-object
    // sample as inline true/false instead of inventing a dictionary entry.
    if (isOpenApiObject(additional)) {
      const value = sample(additional, `${label}.key`);
      if (value !== undefined) entries.push(["key", value]);
    }
  }
  return Object.fromEntries(entries);
}

function sampleNumber(schema: OpenApiObject, integer: boolean): number {
  const minimum = finiteNumber(schema.minimum) ?? 0;
  const exclusive = finiteNumber(schema.exclusiveMinimum);
  let value = exclusive !== undefined ? exclusive + 1 : minimum + (schema.exclusiveMinimum === true ? 1 : 0);
  if (integer) value = Math.ceil(value);
  const multiple = finiteNumber(schema.multipleOf);
  if (multiple !== undefined && multiple > 0) value = Math.ceil(value / multiple) * multiple;
  const maximum = finiteNumber(schema.maximum);
  if (maximum !== undefined && value > maximum) value = maximum;
  return Number.isFinite(value) ? value : 0;
}

function sampleString(schema: OpenApiObject, context: OpenApiValueContext, label: string): string | undefined {
  if (schema.format === "binary" || schema.contentEncoding === "binary") {
    context.warn(`${label}: binary payloads cannot be imported into a text request body.`);
    return undefined;
  }
  const formats: Record<string, string> = {
    date: "2020-01-01", "date-time": "2020-01-01T00:00:00Z", email: "user@example.com",
    uuid: "00000000-0000-4000-8000-000000000000", uri: "https://example.com", hostname: "example.com",
    ipv4: "127.0.0.1", ipv6: "::1", byte: "c3RyaW5n",
  };
  let value = typeof schema.format === "string" && hasOwn(formats, schema.format) ? formats[schema.format] : "string";
  const minimum = Math.min(256, Math.max(0, finiteNumber(schema.minLength) ?? 0));
  const maximum = finiteNumber(schema.maxLength);
  if (value.length < minimum) value = value.padEnd(minimum, "x");
  if (maximum !== undefined && maximum >= 0) value = value.slice(0, maximum);
  if (schema.pattern !== undefined) context.warn(`${label}: generated text may need editing to satisfy its pattern.`);
  return value;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function jsonLength(value: unknown, label: string, limit: number, pretty = false): number {
  let length = 0;
  let remainingNodes = 100_000;
  const ancestors = new Set<object>();
  const add = (count: number) => {
    length += count;
    if (length > limit) throw sampleSizeError(label);
  };
  const string = (text: string) => {
    add(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) add(2);
      else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code >= 0xd800 && code <= 0xdbff
        && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        add(2);
        index++;
      }
      else add(code >= 0xd800 && code <= 0xdfff ? 6 : 1);
    }
  };
  function visit(current: unknown, depth: number): void {
    if (--remainingNodes < 0 || depth > 64) throw new Error(`${label}: the expanded JSON sample is too complex; use a smaller example.`);
    if (typeof current === "string") { string(current); return; }
    if (current === null || typeof current !== "object") { add(String(current ?? null).length); return; }
    if (ancestors.has(current)) throw new Error(`${label}: recursive values cannot be serialized as JSON.`);
    ancestors.add(current);
    const entries = Array.isArray(current) ? current.map(item => [undefined, item] as const) : Object.entries(current);
    add(2);
    for (const [index, [key, child]] of entries.entries()) {
      if (index) add(1);
      if (pretty) add(1 + (depth + 1) * 2);
      if (key !== undefined) { string(key); add(pretty ? 2 : 1); }
      visit(child, depth + 1);
    }
    if (pretty && entries.length) add(1 + depth * 2);
    ancestors.delete(current);
  }
  visit(value, 0);
  return length;
}

function sampleSizeError(label: string): Error {
  return new Error(`${label}: generated sample exceeds the 2 MiB size limit. Use a smaller example before importing.`);
}
