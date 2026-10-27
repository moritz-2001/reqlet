//! Serializable catalog projections. [`CatalogSnapshot`] keeps the original
//! editor payload while adding rich declarations connected by qualified names.

use crate::{
    Catalog, Declaration, Documentation, Field, FieldShape, MapKeyType, Presence, ScalarType,
    SourceLocation, ValueType,
    json::{self, JsonRepresentation},
};
use prost_reflect::Kind;
use serde::Serialize;
use std::collections::BTreeMap;

/// An owned, finite catalog graph suitable for IPC, JSON, and frontend storage.
///
/// Messages and enums retain the original editor payload shape. Rich metadata is
/// additive, and all graph edges use qualified names rather than recursive data.
/// Maps have deterministic key order; field vectors follow field-number order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    /// Ordinary messages by qualified name, including nested and imported types.
    pub messages: BTreeMap<String, Vec<FieldSnapshot>>,
    /// Enum symbol names, retaining aliases and declaration order for compatibility.
    pub enums: BTreeMap<String, Vec<String>>,
    /// Logical defining filename for each message in messages.
    pub message_files: BTreeMap<String, String>,
    /// Message-level semantics and source context, indexed like messages.
    pub message_details: BTreeMap<String, MessageSnapshot>,
    /// Enum numbers, aliases, declaration metadata, and reserved ranges.
    pub enum_details: BTreeMap<String, EnumSnapshot>,
    /// File-level metadata for all loaded source and dependency descriptors.
    pub files: BTreeMap<String, FileSnapshot>,
    /// Exact source text captured during compilation; absent entries have no text.
    pub file_sources: BTreeMap<String, String>,
    /// Services by qualified name, with method input/output references.
    pub services: BTreeMap<String, ServiceSnapshot>,
}

impl CatalogSnapshot {
    /// Copies catalog metadata into a serializable graph with stable name references.
    pub fn from_catalog(catalog: &Catalog) -> Self {
        let mut messages = BTreeMap::new();
        let mut message_files = BTreeMap::new();
        let mut message_details = BTreeMap::new();
        for message in catalog.messages() {
            let name = message.full_name().to_owned();
            let descriptor = message.descriptor();
            let declaration = message.declaration();
            let proto = descriptor.descriptor_proto();
            let oneofs = message
                .oneofs()
                .map(|oneof| OneofSnapshot {
                    name: oneof.descriptor().name().into(),
                    fields: oneof
                        .descriptor()
                        .fields()
                        .map(|field| field.name().into())
                        .collect(),
                    declaration: declaration_snapshot(oneof.declaration()),
                })
                .collect();
            messages.insert(name.clone(), message.fields().map(field_snapshot).collect());
            message_files.insert(name.clone(), declaration.file.name().into());
            message_details.insert(
                name,
                MessageSnapshot {
                    declaration: declaration_snapshot(declaration),
                    deprecated: proto
                        .options
                        .as_ref()
                        .and_then(|options| options.deprecated)
                        .unwrap_or(false),
                    oneofs,
                    nested_messages: descriptor
                        .child_messages()
                        .filter(|child| !child.is_map_entry())
                        .map(|child| child.full_name().into())
                        .collect(),
                    nested_enums: descriptor
                        .child_enums()
                        .map(|child| child.full_name().into())
                        .collect(),
                    reserved_names: proto.reserved_name.clone(),
                    reserved_ranges: proto
                        .reserved_range
                        .iter()
                        .map(|range| ReservedRangeSnapshot {
                            start: i64::from(range.start()),
                            end_exclusive: i64::from(range.end()),
                        })
                        .collect(),
                    json: json::message_representation(&message),
                },
            );
        }

        let mut enums = BTreeMap::new();
        let mut enum_details = BTreeMap::new();
        for enumeration in catalog.enums() {
            let descriptor = enumeration.descriptor();
            let proto = descriptor.enum_descriptor_proto();
            let values: Vec<_> = enumeration
                .values()
                .map(|value| EnumValueSnapshot {
                    name: value.name().into(),
                    number: value.number(),
                    deprecated: value
                        .descriptor()
                        .enum_value_descriptor_proto()
                        .options
                        .as_ref()
                        .and_then(|options| options.deprecated)
                        .unwrap_or(false),
                    declaration: declaration_snapshot(value.declaration()),
                })
                .collect();
            enums.insert(
                enumeration.full_name().into(),
                values.iter().map(|value| value.name.clone()).collect(),
            );
            enum_details.insert(
                enumeration.full_name().into(),
                EnumSnapshot {
                    declaration: declaration_snapshot(enumeration.declaration()),
                    values,
                    deprecated: proto
                        .options
                        .as_ref()
                        .and_then(|options| options.deprecated)
                        .unwrap_or(false),
                    allow_alias: proto
                        .options
                        .as_ref()
                        .and_then(|options| options.allow_alias)
                        .unwrap_or(false),
                    reserved_names: proto.reserved_name.clone(),
                    reserved_ranges: proto
                        .reserved_range
                        .iter()
                        .map(|range| ReservedRangeSnapshot {
                            start: i64::from(range.start()),
                            end_exclusive: i64::from(range.end()) + 1,
                        })
                        .collect(),
                },
            );
        }

        let mut files = BTreeMap::new();
        let mut file_sources = BTreeMap::new();
        for file in catalog.files() {
            let descriptor = file.descriptor();
            let proto = descriptor.file_descriptor_proto();
            if let Some(source) = file.source() {
                file_sources.insert(file.name().into(), source.into());
            }
            files.insert(
                file.name().into(),
                FileSnapshot {
                    package: proto.package.clone().unwrap_or_default(),
                    syntax: proto.syntax.clone().unwrap_or_else(|| "proto2".into()),
                    dependencies: proto.dependency.clone(),
                    public_dependencies: dependency_names(
                        &proto.dependency,
                        &proto.public_dependency,
                    ),
                    weak_dependencies: dependency_names(&proto.dependency, &proto.weak_dependency),
                    messages: descriptor
                        .messages()
                        .filter(|message| !message.is_map_entry())
                        .map(|message| message.full_name().into())
                        .collect(),
                    enums: descriptor
                        .enums()
                        .map(|enumeration| enumeration.full_name().into())
                        .collect(),
                    services: descriptor
                        .services()
                        .map(|service| service.full_name().into())
                        .collect(),
                },
            );
        }

        let services = catalog
            .services()
            .map(|service| {
                let deprecated = service
                    .descriptor()
                    .service_descriptor_proto()
                    .options
                    .as_ref()
                    .and_then(|options| options.deprecated)
                    .unwrap_or(false);
                let methods = service
                    .methods()
                    .map(|method| MethodSnapshot {
                        name: method.name().into(),
                        input: method.input().full_name().into(),
                        output: method.output().full_name().into(),
                        client_streaming: method.client_streaming(),
                        server_streaming: method.server_streaming(),
                        deprecated: method
                            .descriptor()
                            .method_descriptor_proto()
                            .options
                            .as_ref()
                            .and_then(|options| options.deprecated)
                            .unwrap_or(false),
                        declaration: declaration_snapshot(method.declaration()),
                    })
                    .collect();
                (
                    service.full_name().into(),
                    ServiceSnapshot {
                        methods,
                        deprecated,
                        declaration: declaration_snapshot(service.declaration()),
                    },
                )
            })
            .collect();

        Self {
            messages,
            enums,
            message_files,
            message_details,
            enum_details,
            files,
            file_sources,
            services,
        }
    }
}

/// Field metadata compatible with the original editor catalog, plus rich semantics.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSnapshot {
    /// Original name in the protobuf declaration.
    pub name: String,
    /// Canonical JSON property name, including any explicit json_name override.
    pub json_name: String,
    /// Legacy scalar or qualified type name; maps retain their synthetic entry name.
    pub r#type: String,
    /// Whether the JSON representation is an array; maps are false for compatibility.
    pub repeated: bool,
    /// Map value scalar or qualified type name; None means this is not a map.
    pub map_value: Option<String>,
    /// Real exclusive group name; None excludes proto3 optional's synthetic group.
    pub oneof: Option<String>,
    /// Legacy leading comments, prefixed with Deprecated. when the option is set.
    pub documentation: String,
    /// Wire tag number unique within the containing message.
    pub number: u32,
    /// Whether protobuf tracks presence or requires the field.
    pub presence: Presence,
    /// Structured deprecated option, independent from the legacy comment prefix.
    pub deprecated: bool,
    /// Original map key scalar; None means this is not a map.
    pub map_key_type: Option<MapKeyType>,
    /// Collection structure with qualified references and no synthetic map entries.
    pub shape: FieldShapeSnapshot,
    /// Source-language explicit default; None means the declaration has no default.
    pub explicit_default: Option<String>,
    /// Structured comments and optional source coordinates.
    pub declaration: DeclarationSnapshot,
    /// Canonical output and accepted input representations in ProtoJSON.
    pub json: JsonRepresentation,
}

/// Serializable collection structure with an unambiguous map representation.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FieldShapeSnapshot {
    /// A single protobuf value.
    Singular {
        /// Scalar type or qualified declaration reference for the field.
        value: ValueTypeSnapshot,
    },
    /// A sequence of protobuf values.
    Repeated {
        /// Scalar type or qualified declaration reference for every element.
        value: ValueTypeSnapshot,
    },
    /// A protobuf map without its generated entry message.
    Map {
        /// Protobuf scalar accepted as each map key.
        key: MapKeyType,
        /// Scalar type or qualified declaration reference for every entry value.
        value: ValueTypeSnapshot,
    },
}

/// A scalar or a named edge in the serialized declaration graph.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ValueTypeSnapshot {
    /// An exact protobuf primitive, including wire-level numeric distinctions.
    Scalar {
        /// The protobuf primitive declared on this value.
        scalar: ScalarType,
    },
    /// A message resolved through CatalogSnapshot.messages.
    Message {
        /// Fully qualified message name without a leading dot.
        name: String,
    },
    /// An enum resolved through CatalogSnapshot.enumDetails.
    Enum {
        /// Fully qualified enum name without a leading dot.
        name: String,
    },
}

/// Context shared by all declarations with optional original-source coordinates.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationSnapshot {
    /// Logical protobuf import name, also the key in files and fileSources.
    pub file: String,
    /// Descriptor field/index path identifying this declaration even without source info.
    pub descriptor_path: Vec<i32>,
    /// Leading, trailing, and detached comments kept separate and unmodified.
    pub documentation: Documentation,
    /// One-based lines and zero-based UTF-8 byte columns; None means no source info.
    pub location: Option<SourceLocation>,
}

/// Message-level metadata whose fields remain in CatalogSnapshot.messages.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSnapshot {
    /// Comments, defining file, and optional location of the message declaration.
    pub declaration: DeclarationSnapshot,
    /// Whether the message's deprecated option is set.
    pub deprecated: bool,
    /// Real exclusive field groups, excluding proto3 optional implementation groups.
    pub oneofs: Vec<OneofSnapshot>,
    /// Directly nested ordinary messages, each resolved by qualified name.
    pub nested_messages: Vec<String>,
    /// Directly nested enums, each resolved by qualified name.
    pub nested_enums: Vec<String>,
    /// Field names the schema reserves against reuse.
    pub reserved_names: Vec<String>,
    /// Reserved field-number intervals using a consistently exclusive upper bound.
    pub reserved_ranges: Vec<ReservedRangeSnapshot>,
    /// ProtoJSON object or special well-known-type representation.
    pub json: JsonRepresentation,
}

/// A real oneof and its participating field names.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneofSnapshot {
    /// Group name within its containing message.
    pub name: String,
    /// Protobuf field names belonging to this exclusive group.
    pub fields: Vec<String>,
    /// Comments, defining file, and optional location of the group declaration.
    pub declaration: DeclarationSnapshot,
}

/// Rich enum information preserving aliases and declaration-order names.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumSnapshot {
    /// Comments, defining file, and optional location of the enum declaration.
    pub declaration: DeclarationSnapshot,
    /// Values in declaration order, including every declared alias.
    pub values: Vec<EnumValueSnapshot>,
    /// Whether the enum's deprecated option is set.
    pub deprecated: bool,
    /// Whether multiple symbols may explicitly share a numeric value.
    pub allow_alias: bool,
    /// Symbol names reserved against reuse by later schema versions.
    pub reserved_names: Vec<String>,
    /// Reserved numeric intervals; even enum's inclusive bounds are normalized.
    pub reserved_ranges: Vec<ReservedRangeSnapshot>,
}

/// One declared enum name; equal numbers on different entries represent aliases.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumValueSnapshot {
    /// Symbol as declared in the source, not a qualified enum type name.
    pub name: String,
    /// Wire value, shared with other entries when aliases are enabled.
    pub number: i32,
    /// Whether the value's deprecated option is set.
    pub deprecated: bool,
    /// Comments, defining file, and optional location of this symbol.
    pub declaration: DeclarationSnapshot,
}

/// A reserved integer interval with the same bound semantics for all declarations.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservedRangeSnapshot {
    /// First reserved number, included in the interval.
    pub start: i64,
    /// First unreserved number after the interval; i64 accommodates i32::MAX + 1.
    pub end_exclusive: i64,
}

/// Import relationships and top-level declarations of one descriptor file.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    /// Declared protobuf package, or the empty string for the global package.
    pub package: String,
    /// Source syntax, defaulting to proto2 when the descriptor omits it.
    pub syntax: String,
    /// All imported logical filenames in declaration order.
    pub dependencies: Vec<String>,
    /// Imports re-exported to users of this file.
    pub public_dependencies: Vec<String>,
    /// Imports marked weak in the descriptor.
    pub weak_dependencies: Vec<String>,
    /// Top-level ordinary message names; nested messages are reached through details.
    pub messages: Vec<String>,
    /// Top-level enum names; nested enums are reached through message details.
    pub enums: Vec<String>,
    /// Top-level qualified service names.
    pub services: Vec<String>,
}

/// A service with methods in declaration order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    /// Comments, defining file, and optional location of the service.
    pub declaration: DeclarationSnapshot,
    /// Whether the service's deprecated option is set.
    pub deprecated: bool,
    /// RPC methods with named request and response edges.
    pub methods: Vec<MethodSnapshot>,
}

/// An RPC signature and its independently streamed request and response directions.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodSnapshot {
    /// Method name within its containing service.
    pub name: String,
    /// Fully qualified request message name.
    pub input: String,
    /// Fully qualified response message name.
    pub output: String,
    /// Whether the client sends a stream instead of one request message.
    pub client_streaming: bool,
    /// Whether the server sends a stream instead of one response message.
    pub server_streaming: bool,
    /// Whether the method's deprecated option is set.
    pub deprecated: bool,
    /// Comments, defining file, and optional location of this method.
    pub declaration: DeclarationSnapshot,
}

fn field_snapshot(field: Field) -> FieldSnapshot {
    let descriptor = field.descriptor();
    let proto = descriptor.field_descriptor_proto();
    let deprecated = proto
        .options
        .as_ref()
        .and_then(|options| options.deprecated)
        .unwrap_or(false);
    let declaration = field.declaration();
    let documentation = if deprecated {
        format!("Deprecated. {}", declaration.documentation.leading)
    } else {
        declaration.documentation.leading.clone()
    };
    let (shape, map_key_type, map_value) = match field.shape() {
        FieldShape::Singular(value) => (
            FieldShapeSnapshot::Singular {
                value: value_snapshot(value),
            },
            None,
            None,
        ),
        FieldShape::Repeated(value) => (
            FieldShapeSnapshot::Repeated {
                value: value_snapshot(value),
            },
            None,
            None,
        ),
        FieldShape::Map { key, value } => {
            let Kind::Message(entry) = descriptor.kind() else {
                unreachable!("validated protobuf maps use entry messages")
            };
            (
                FieldShapeSnapshot::Map {
                    key,
                    value: value_snapshot(value),
                },
                Some(key),
                Some(kind_name(entry.map_entry_value_field().kind())),
            )
        }
    };
    FieldSnapshot {
        name: field.name().into(),
        json_name: field.json_name().into(),
        r#type: kind_name(descriptor.kind()),
        repeated: descriptor.is_list(),
        map_value,
        oneof: field.oneof().map(|oneof| oneof.descriptor().name().into()),
        documentation,
        number: field.number(),
        presence: field.presence(),
        deprecated,
        map_key_type,
        shape,
        explicit_default: proto.default_value.clone(),
        declaration: declaration_snapshot(declaration),
        json: json::field_representation(&field),
    }
}

fn value_snapshot(value: ValueType) -> ValueTypeSnapshot {
    match value {
        ValueType::Scalar(scalar) => ValueTypeSnapshot::Scalar { scalar },
        ValueType::Message(message) => ValueTypeSnapshot::Message {
            name: message.full_name().into(),
        },
        ValueType::Enum(enumeration) => ValueTypeSnapshot::Enum {
            name: enumeration.full_name().into(),
        },
    }
}

fn declaration_snapshot(declaration: Declaration) -> DeclarationSnapshot {
    DeclarationSnapshot {
        file: declaration.file.name().into(),
        descriptor_path: declaration.descriptor_path,
        documentation: declaration.documentation,
        location: declaration.location,
    }
}

fn kind_name(kind: Kind) -> String {
    match kind {
        Kind::Message(message) => message.full_name().into(),
        Kind::Enum(enumeration) => enumeration.full_name().into(),
        scalar => format!("{scalar:?}").to_lowercase(),
    }
}

fn dependency_names(dependencies: &[String], indices: &[i32]) -> Vec<String> {
    indices
        .iter()
        .filter_map(|index| usize::try_from(*index).ok())
        .filter_map(|index| dependencies.get(index).cloned())
        .collect()
}
