// ProtobufSource configures shared local models; catalogs are runtime-only editing data.
import { invoke, isTauri } from '@tauri-apps/api/core';

/** A reusable local protobuf project. */
export interface ProtobufSource {
  /** Stable identity shared by request bindings. */
  id: string;
  /** Label shown in the model picker. */
  name: string;
  /** Local project root; null requires relinking after import. */
  rootPath: string | null;
  /** Additional dependency roots in resolution order. */
  includePaths: string[];
}
/** Identifies editing assistance without changing transport. */
export interface ProtobufMessageBinding {
  /** Shared source identity, retained even if unavailable. */
  sourceId: string;
  /** Fully qualified message name without a leading dot. */
  messageName: string;
}
/** A normalized field used by completion, independent of native descriptors. */
export interface ProtoField {
  /** Original protobuf spelling, also accepted in JSON. */
  name: string;
  /** Canonical spelling inserted into JSON. */
  jsonName: string;
  /** Scalar kind or fully qualified message/enum identity. */
  type: string;
  /** Whether values are array elements. */
  repeated: boolean;
  /** Map value type; absent for ordinary fields. */
  mapValue?: string;
  /** Real exclusive group; absent for independent fields. */
  oneof?: string;
  /** Source documentation displayed with suggestions. */
  documentation: string;
}
/** Immutable graph shared by editors; names keep recursive models finite. */
export interface ProtobufCatalog {
  /** Ordinary message fields keyed by fully qualified identity. */
  messages: Record<string, ProtoField[]>;
  /** Optional source locations keyed by message identity; absent in older catalogs. */
  messageFiles?: Record<string, string>;
  /** Symbolic enum values keyed by fully qualified identity. */
  enums: Record<string, string[]>;
}
/** Runtime state; a failed reload can retain a stale catalog. */
export interface ProtobufSourceState {
  /** Last successful catalog; absent until successfully loaded. */
  catalog?: ProtobufCatalog;
  /** Current error or stale-catalog explanation; absent after success. */
  error?: string;
  /** Set during loading and cleared when the latest attempt finishes. */
  loading: boolean;
}
/** Resolved context passed through body presentation into the editor. */
export interface ProtobufContext {
  /** Shared catalog containing referenced types. */
  catalog: ProtobufCatalog;
  /** Root JSON message selected for this request. */
  messageName: string;
}
/** Loads a local project without changing its persisted configuration. */
export async function loadProtobufSource(source: ProtobufSource): Promise<ProtobufCatalog> {
  if (!isTauri()) throw new Error('Local protobuf folders require the desktop app.');
  if (!source.rootPath) throw new Error('Relink this protobuf folder.');
  return invoke('protobuf_load_source', { rootPath: source.rootPath, includePaths: source.includePaths });
}

/** Request-local presentation derived from a committed binding and shared load state. */
export interface ProtobufAssistance {
  /** Compact summary of the committed source and message, or the missing selection. */
  label: string;
  /** User-facing explanation of availability, loading, or recovery. */
  status: string;
  /** Whether recovery requires choosing a message or managing source configuration. */
  action: 'select' | 'manage';
  /** Active JSON assistance; absent when unavailable or disabled by the MIME type. */
  context?: ProtobufContext;
}

/** Derives feedback without owning loading or mutating the persisted selection. */
export function resolveProtobufAssistance(
  binding: ProtobufMessageBinding | undefined,
  sources: readonly ProtobufSource[],
  states: Record<string, ProtobufSourceState>,
  contentType: string,
): ProtobufAssistance {
  if (!binding) {
    return { label: 'None', status: 'Choose a protobuf message for JSON completion.', action: 'select' };
  }

  const source = sources.find(source => source.id === binding.sourceId);
  if (!source) {
    return {
      label: 'Unavailable source',
      status: 'This source was removed. Restore it with Undo or choose another source.',
      action: 'select',
    };
  }
  if (!source.rootPath) {
    return { label: source.name, status: 'Needs relinking: choose the local protobuf folder.', action: 'manage' };
  }

  const state = states[binding.sourceId];
  const catalog = state?.catalog;
  const context = catalog?.messages[binding.messageName]
    ? { catalog, messageName: binding.messageName } : undefined;
  if (state?.loading && !context) {
    return { label: source.name, status: 'Loading protobuf models…', action: 'manage' };
  }
  if (!context) {
    const status = state?.error ?? (binding.messageName
      ? 'Message unavailable. Choose another message or reload the source.' : 'Choose a message.');
    return { label: source.name, status, action: state?.error ? 'manage' : 'select' };
  }

  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  const json = mime === 'application/json' || mime.endsWith('+json');
  let status = 'Ready · Ctrl+Space for suggestions';
  if (!json) status = 'Inactive: select a JSON content type.';
  else if (state?.loading) status = 'Reloading; completion uses previous models.';
  else if (state?.error) status = 'Using previous models: reload failed.';

  return {
    label: `${source.name} / ${binding.messageName}`,
    status,
    action: state?.error ? 'manage' : 'select',
    context: json ? context : undefined,
  };
}
