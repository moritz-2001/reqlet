//! Navigable protobuf declarations. [`Message`] and its related handles share
//! the owning catalog rather than copying or recursively expanding its graph.
use crate::{Catalog, Declaration, json};
use prost_reflect::{
    Cardinality, EnumDescriptor, EnumValueDescriptor, ExtensionDescriptor, FieldDescriptor,
    FileDescriptor, Kind, MessageDescriptor, MethodDescriptor, OneofDescriptor, ServiceDescriptor,
    Syntax, Value,
};
use serde::Serialize;

/// A message and its source context in one immutable catalog snapshot.
#[derive(Clone, Debug)]
pub struct Message {
    /// Retains sources and indexes alongside this handle's descriptor pool.
    catalog: Catalog,
    /// The semantic authority for this message; never mutated independently.
    descriptor: MessageDescriptor,
}

impl Message {
    /// Unqualified protobuf declaration name.
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Fully qualified identity without a leading dot, suitable for persistence.
    pub fn full_name(&self) -> &str {
        self.descriptor.full_name()
    }

    /// Enumerates fields in ascending field-number order.
    pub fn fields(&self) -> impl Iterator<Item = Field> + '_ {
        self.descriptor
            .fields()
            .map(|descriptor| Field::new(&self.catalog, descriptor))
    }

    /// Finds a field by its original protobuf spelling.
    pub fn field(&self, name: &str) -> Option<Field> {
        self.descriptor
            .get_field_by_name(name)
            .map(|descriptor| Field::new(&self.catalog, descriptor))
    }

    /// Finds a field by its canonical JSON spelling, including custom json_name.
    pub fn field_by_json_name(&self, name: &str) -> Option<Field> {
        self.descriptor
            .get_field_by_json_name(name)
            .map(|descriptor| Field::new(&self.catalog, descriptor))
    }

    /// Finds a field by its wire-format tag number.
    pub fn field_by_number(&self, number: u32) -> Option<Field> {
        self.descriptor
            .get_field(number)
            .map(|descriptor| Field::new(&self.catalog, descriptor))
    }

    /// Enumerates immediately nested messages, excluding synthetic map entries.
    pub fn nested_messages(&self) -> impl Iterator<Item = Message> + '_ {
        self.descriptor
            .child_messages()
            .filter(|descriptor| !descriptor.is_map_entry())
            .map(|descriptor| Self::new(&self.catalog, descriptor))
    }

    /// Enumerates enums declared directly inside this message.
    pub fn nested_enums(&self) -> impl Iterator<Item = Enum> + '_ {
        self.descriptor
            .child_enums()
            .map(|descriptor| Enum::new(&self.catalog, descriptor))
    }

    /// The enclosing message; None means this is a top-level declaration.
    pub fn parent_message(&self) -> Option<Message> {
        self.descriptor
            .parent_message()
            .map(|descriptor| Self::new(&self.catalog, descriptor))
    }

    /// Enumerates real exclusive groups, excluding proto3-optional scaffolding.
    pub fn oneofs(&self) -> impl Iterator<Item = Oneof> + '_ {
        self.descriptor
            .oneofs()
            .filter(|descriptor| !descriptor.is_synthetic())
            .map(|descriptor| Oneof::new(&self.catalog, descriptor))
    }

    /// Finds source comments and optional coordinates for this declaration.
    pub fn declaration(&self) -> Declaration {
        Declaration::new(
            &self.catalog,
            self.descriptor.parent_file(),
            self.descriptor.path(),
        )
    }

    /// Enumerates field value types, extension value types, and RPC signatures
    /// referring to this message. Map values refer through their ordinary field.
    pub fn references(&self) -> impl Iterator<Item = Reference> + '_ {
        self.catalog.references(self.full_name())
    }

    /// Describes protobuf JSON encoding without expanding recursive references.
    pub fn json_representation(&self) -> json::JsonRepresentation {
        json::message_representation(self)
    }

    /// Exposes options, reserved ranges, extensions, and other descriptor detail.
    pub fn descriptor(&self) -> &MessageDescriptor {
        &self.descriptor
    }

    pub(crate) fn new(catalog: &Catalog, descriptor: MessageDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// A field of an ordinary message, retaining its original catalog snapshot.
#[derive(Clone, Debug)]
pub struct Field {
    /// Keeps source context and type navigation in the same immutable snapshot.
    catalog: Catalog,
    /// Validated field metadata, including its parent and wire identity.
    descriptor: FieldDescriptor,
}

impl Field {
    /// Original protobuf spelling, also accepted by protobuf JSON readers.
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Canonical JSON property spelling, honoring an explicit json_name option.
    pub fn json_name(&self) -> &str {
        self.descriptor.json_name()
    }

    /// Fully qualified field identity, including its enclosing message.
    pub fn full_name(&self) -> &str {
        self.descriptor.full_name()
    }

    /// Wire-format tag number, unique within the enclosing message.
    pub fn number(&self) -> u32 {
        self.descriptor.number()
    }

    /// Distinguishes single values, arrays, and maps without synthetic entry types.
    pub fn shape(&self) -> FieldShape {
        let kind = self.descriptor.kind();
        if let Kind::Message(entry) = &kind
            && self.descriptor.is_map()
        {
            return FieldShape::Map {
                key: MapKeyType::from_kind(entry.map_entry_key_field().kind()),
                value: ValueType::new(&self.catalog, entry.map_entry_value_field().kind()),
            };
        }

        let value = ValueType::new(&self.catalog, kind);
        if self.descriptor.is_list() {
            FieldShape::Repeated(value)
        } else {
            FieldShape::Singular(value)
        }
    }

    /// Whether protobuf tracks absence separately from the effective field value.
    ///
    /// Explicit presence does not imply a source-level `optional` keyword:
    /// message fields and real oneof members also support presence.
    pub fn presence(&self) -> Presence {
        if self.descriptor.cardinality() == Cardinality::Required {
            Presence::Required
        } else if self.descriptor.supports_presence() {
            Presence::Explicit
        } else {
            Presence::Untracked
        }
    }

    /// The real exclusive group; None means independent presence, including
    /// proto3 optional fields represented by synthetic oneofs in descriptors.
    pub fn oneof(&self) -> Option<Oneof> {
        self.descriptor
            .containing_oneof()
            .filter(|descriptor| !descriptor.is_synthetic())
            .map(|descriptor| Oneof::new(&self.catalog, descriptor))
    }

    /// Returns only an explicitly declared default, not an editor starter value.
    /// None means no explicit default was recorded in the field descriptor.
    pub fn explicit_default(&self) -> Option<Value> {
        self.descriptor
            .field_descriptor_proto()
            .default_value
            .as_ref()
            .map(|_| self.descriptor.default_value())
    }

    /// Whether the field's standard deprecated option is set.
    pub fn deprecated(&self) -> bool {
        self.descriptor
            .field_descriptor_proto()
            .options
            .as_ref()
            .is_some_and(|options| options.deprecated.unwrap_or(false))
    }

    /// Navigates to the ordinary message declaring this field.
    pub fn parent_message(&self) -> Message {
        Message::new(&self.catalog, self.descriptor.parent_message().clone())
    }

    /// Finds source comments and optional coordinates for this field.
    pub fn declaration(&self) -> Declaration {
        Declaration::new(
            &self.catalog,
            self.descriptor.parent_file(),
            self.descriptor.path(),
        )
    }

    /// Describes the complete JSON shape, including collection and null rules.
    pub fn json_representation(&self) -> json::JsonRepresentation {
        json::field_representation(self)
    }

    /// Exposes original options, defaults, packing, and other protobuf metadata.
    pub fn descriptor(&self) -> &FieldDescriptor {
        &self.descriptor
    }

    pub(crate) fn new(catalog: &Catalog, descriptor: FieldDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// A field's collection structure after normalizing synthetic protobuf map entries.
#[derive(Clone, Debug)]
pub enum FieldShape {
    /// A single scalar, enum, or message value.
    Singular(ValueType),
    /// An ordered sequence of values of one type.
    Repeated(ValueType),
    /// A collection represented as an object in protobuf JSON.
    Map {
        /// Restricts keys to the scalar types protobuf permits for maps.
        key: MapKeyType,
        /// Describes each entry's value, never a synthetic map-entry message.
        value: ValueType,
    },
}

/// A scalar or a reference to another declaration in the same snapshot.
#[derive(Clone, Debug)]
pub enum ValueType {
    /// A protobuf scalar, retaining its exact wire-format kind.
    Scalar(ScalarType),
    /// A navigable message reference; recursive types are never expanded eagerly.
    Message(Message),
    /// A navigable enum reference, preserving aliases and numeric values.
    Enum(Enum),
}

impl ValueType {
    pub(crate) fn new(catalog: &Catalog, kind: Kind) -> Self {
        match kind {
            Kind::Message(descriptor) => Self::Message(Message::new(catalog, descriptor)),
            Kind::Enum(descriptor) => Self::Enum(Enum::new(catalog, descriptor)),
            kind => Self::Scalar(ScalarType::from_kind(kind)),
        }
    }
}

/// The exact scalar kind, preserving distinctions relevant to protobuf encoding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScalarType {
    /// An IEEE-754 64-bit floating-point number.
    Double,
    /// An IEEE-754 32-bit floating-point number.
    Float,
    /// A signed 32-bit varint.
    Int32,
    /// A signed 64-bit varint.
    Int64,
    /// An unsigned 32-bit varint.
    Uint32,
    /// An unsigned 64-bit varint.
    Uint64,
    /// A signed 32-bit integer with ZigZag encoding.
    Sint32,
    /// A signed 64-bit integer with ZigZag encoding.
    Sint64,
    /// An unsigned fixed-width 32-bit integer.
    Fixed32,
    /// An unsigned fixed-width 64-bit integer.
    Fixed64,
    /// A signed fixed-width 32-bit integer.
    Sfixed32,
    /// A signed fixed-width 64-bit integer.
    Sfixed64,
    /// A boolean value.
    Bool,
    /// UTF-8 text.
    String,
    /// An arbitrary byte sequence.
    Bytes,
}

impl ScalarType {
    fn from_kind(kind: Kind) -> Self {
        match kind {
            Kind::Double => Self::Double,
            Kind::Float => Self::Float,
            Kind::Int32 => Self::Int32,
            Kind::Int64 => Self::Int64,
            Kind::Uint32 => Self::Uint32,
            Kind::Uint64 => Self::Uint64,
            Kind::Sint32 => Self::Sint32,
            Kind::Sint64 => Self::Sint64,
            Kind::Fixed32 => Self::Fixed32,
            Kind::Fixed64 => Self::Fixed64,
            Kind::Sfixed32 => Self::Sfixed32,
            Kind::Sfixed64 => Self::Sfixed64,
            Kind::Bool => Self::Bool,
            Kind::String => Self::String,
            Kind::Bytes => Self::Bytes,
            Kind::Message(_) | Kind::Enum(_) => unreachable!("validated scalar kind"),
        }
    }
}

/// A legal protobuf map key kind; JSON writes all map keys as property strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MapKeyType {
    /// A signed 32-bit varint key.
    Int32,
    /// A signed 64-bit varint key.
    Int64,
    /// An unsigned 32-bit varint key.
    Uint32,
    /// An unsigned 64-bit varint key.
    Uint64,
    /// A signed 32-bit ZigZag-encoded key.
    Sint32,
    /// A signed 64-bit ZigZag-encoded key.
    Sint64,
    /// An unsigned fixed-width 32-bit key.
    Fixed32,
    /// An unsigned fixed-width 64-bit key.
    Fixed64,
    /// A signed fixed-width 32-bit key.
    Sfixed32,
    /// A signed fixed-width 64-bit key.
    Sfixed64,
    /// A boolean key, written as "true" or "false" in JSON.
    Bool,
    /// An arbitrary string key.
    String,
}

impl MapKeyType {
    fn from_kind(kind: Kind) -> Self {
        match kind {
            Kind::Int32 => Self::Int32,
            Kind::Int64 => Self::Int64,
            Kind::Uint32 => Self::Uint32,
            Kind::Uint64 => Self::Uint64,
            Kind::Sint32 => Self::Sint32,
            Kind::Sint64 => Self::Sint64,
            Kind::Fixed32 => Self::Fixed32,
            Kind::Fixed64 => Self::Fixed64,
            Kind::Sfixed32 => Self::Sfixed32,
            Kind::Sfixed64 => Self::Sfixed64,
            Kind::Bool => Self::Bool,
            Kind::String => Self::String,
            _ => unreachable!("validated protobuf map key"),
        }
    }
}

/// Whether a field's absence has meaning beyond its effective value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Presence {
    /// Absence is not independently tracked, including repeated and map fields.
    Untracked,
    /// Absence is tracked, including message fields and real oneof members.
    Explicit,
    /// A proto2 required field whose presence is required for initialization.
    Required,
}

/// An enum declaration retaining names, numeric aliases, and source context.
#[derive(Clone, Debug)]
pub struct Enum {
    /// Retains the original snapshot for members, sources, and reverse references.
    catalog: Catalog,
    /// The validated enum declaration, including options and reserved ranges.
    descriptor: EnumDescriptor,
}

impl Enum {
    /// Unqualified protobuf declaration name.
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Fully qualified identity without a leading dot.
    pub fn full_name(&self) -> &str {
        self.descriptor.full_name()
    }

    /// Enumerates members in declaration order, preserving every numeric alias.
    pub fn values(&self) -> impl Iterator<Item = EnumValue> + '_ {
        // Descriptor iteration sorts by number and does not preserve alias order.
        // Original declaration order determines the canonical JSON alias.
        self.descriptor
            .enum_descriptor_proto()
            .value
            .iter()
            .map(|value| {
                let descriptor = self
                    .descriptor
                    .get_value_by_name(value.name())
                    .expect("validated enum member belongs to its descriptor");
                EnumValue::new(&self.catalog, descriptor)
            })
    }

    /// Finds one symbolic member; numeric aliases remain separate declarations.
    pub fn value(&self, name: &str) -> Option<EnumValue> {
        self.descriptor
            .get_value_by_name(name)
            .map(|descriptor| EnumValue::new(&self.catalog, descriptor))
    }

    /// Enclosing message, or None for a top-level enum.
    pub fn parent_message(&self) -> Option<Message> {
        self.descriptor
            .parent_message()
            .map(|descriptor| Message::new(&self.catalog, descriptor))
    }

    /// Finds source comments and optional coordinates for this declaration.
    pub fn declaration(&self) -> Declaration {
        Declaration::new(
            &self.catalog,
            self.descriptor.parent_file(),
            self.descriptor.path(),
        )
    }

    /// Enumerates fields and extension value types referring to this enum.
    pub fn references(&self) -> impl Iterator<Item = Reference> + '_ {
        self.catalog.references(self.full_name())
    }

    /// Exposes complete enum options and reserved names or ranges.
    pub fn descriptor(&self) -> &EnumDescriptor {
        &self.descriptor
    }

    pub(crate) fn new(catalog: &Catalog, descriptor: EnumDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// One symbolic enum member; aliases with equal numbers remain distinct handles.
#[derive(Clone, Debug)]
pub struct EnumValue {
    /// Keeps member source context paired with the containing enum snapshot.
    catalog: Catalog,
    /// Original declaration, preserving its name even for a numeric alias.
    descriptor: EnumValueDescriptor,
}

impl EnumValue {
    /// Symbolic member name used in protobuf JSON.
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Wire-format numeric value, which may be shared with alias members.
    pub fn number(&self) -> i32 {
        self.descriptor.number()
    }

    /// Whether this member's standard deprecated option is set.
    pub fn deprecated(&self) -> bool {
        self.descriptor
            .enum_value_descriptor_proto()
            .options
            .as_ref()
            .is_some_and(|options| options.deprecated.unwrap_or(false))
    }

    /// Navigates to the enum that declares this member.
    pub fn parent_enum(&self) -> Enum {
        Enum::new(&self.catalog, self.descriptor.parent_enum().clone())
    }

    /// Finds source comments and optional coordinates for this enum member.
    pub fn declaration(&self) -> Declaration {
        Declaration::new(
            &self.catalog,
            self.descriptor.parent_file(),
            self.descriptor.path(),
        )
    }

    /// Exposes original enum-member options and descriptor metadata.
    pub fn descriptor(&self) -> &EnumValueDescriptor {
        &self.descriptor
    }

    pub(crate) fn new(catalog: &Catalog, descriptor: EnumValueDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// A real exclusive field group; synthetic proto3-optional groups are hidden.
#[derive(Clone, Debug)]
pub struct Oneof {
    /// Retains the group's declaration and member snapshot.
    catalog: Catalog,
    /// Validated non-synthetic oneof descriptor.
    descriptor: OneofDescriptor,
}

impl Oneof {
    /// Unqualified group name within its enclosing message.
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Enumerates this group's mutually exclusive fields in descriptor order.
    pub fn fields(&self) -> impl Iterator<Item = Field> + '_ {
        self.descriptor
            .fields()
            .map(|descriptor| Field::new(&self.catalog, descriptor))
    }

    /// Finds source comments and optional coordinates for this group.
    pub fn declaration(&self) -> Declaration {
        Declaration::new(
            &self.catalog,
            self.descriptor.parent_file(),
            self.descriptor.path(),
        )
    }

    /// Exposes original group options and descriptor metadata.
    pub fn descriptor(&self) -> &OneofDescriptor {
        &self.descriptor
    }

    fn new(catalog: &Catalog, descriptor: OneofDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// A logical protobuf source or dependency file in an immutable snapshot.
#[derive(Clone, Debug)]
pub struct File {
    /// Owns optional captured text shared by every declaration from this file.
    catalog: Catalog,
    /// File identity and import graph, without exposing machine-local paths.
    descriptor: FileDescriptor,
}

impl File {
    /// Compiler-relative import name, such as "company/users.proto".
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Package declared by this file; the empty string denotes no package.
    pub fn package(&self) -> &str {
        self.descriptor.package_name()
    }

    /// Protobuf syntax recorded in this file's descriptor.
    pub fn syntax(&self) -> Syntax {
        self.descriptor.syntax()
    }

    /// Exact captured UTF-8 source. None means text was not available, as with
    /// descriptor-only construction or descriptor-backed built-in dependencies.
    pub fn source(&self) -> Option<&str> {
        self.catalog.source(self.name())
    }

    /// Enumerates direct imports in their descriptor order.
    pub fn dependencies(&self) -> impl Iterator<Item = File> + '_ {
        self.descriptor
            .dependencies()
            .map(|descriptor| Self::new(&self.catalog, descriptor))
    }

    /// Enumerates top-level messages; nested messages are reached through parents.
    pub fn messages(&self) -> impl Iterator<Item = Message> + '_ {
        self.descriptor
            .messages()
            .filter(|descriptor| !descriptor.is_map_entry())
            .map(|descriptor| Message::new(&self.catalog, descriptor))
    }

    /// Enumerates only the file's top-level enum declarations.
    pub fn enums(&self) -> impl Iterator<Item = Enum> + '_ {
        self.descriptor
            .enums()
            .map(|descriptor| Enum::new(&self.catalog, descriptor))
    }

    /// Enumerates service declarations from this file.
    pub fn services(&self) -> impl Iterator<Item = Service> + '_ {
        self.descriptor
            .services()
            .map(|descriptor| Service::new(&self.catalog, descriptor))
    }

    /// Exposes import modifiers, file options, and the original file descriptor.
    pub fn descriptor(&self) -> &FileDescriptor {
        &self.descriptor
    }

    pub(crate) fn new(catalog: &Catalog, descriptor: FileDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// A protobuf service and its RPC method declarations.
#[derive(Clone, Debug)]
pub struct Service {
    /// Shares source and request/response message context with the catalog.
    catalog: Catalog,
    /// Validated service metadata including custom options.
    descriptor: ServiceDescriptor,
}

impl Service {
    /// Unqualified service declaration name.
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Fully qualified service identity without a leading dot.
    pub fn full_name(&self) -> &str {
        self.descriptor.full_name()
    }

    /// Enumerates RPC methods in declaration order.
    pub fn methods(&self) -> impl Iterator<Item = Method> + '_ {
        self.descriptor
            .methods()
            .map(|descriptor| Method::new(&self.catalog, descriptor))
    }

    /// Finds an RPC method by its unqualified name.
    pub fn method(&self, name: &str) -> Option<Method> {
        self.descriptor
            .methods()
            .find(|descriptor| descriptor.name() == name)
            .map(|descriptor| Method::new(&self.catalog, descriptor))
    }

    /// Finds source comments and optional coordinates for this service.
    pub fn declaration(&self) -> Declaration {
        Declaration::new(
            &self.catalog,
            self.descriptor.parent_file(),
            self.descriptor.path(),
        )
    }

    /// Exposes service-level custom options and descriptor metadata.
    pub fn descriptor(&self) -> &ServiceDescriptor {
        &self.descriptor
    }

    pub(crate) fn new(catalog: &Catalog, descriptor: ServiceDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// An RPC signature, including streaming directions and navigable message types.
#[derive(Clone, Debug)]
pub struct Method {
    /// Keeps both endpoint message types and method source in one snapshot.
    catalog: Catalog,
    /// Original RPC signature and options.
    descriptor: MethodDescriptor,
}

impl Method {
    /// Unqualified method name within its service.
    pub fn name(&self) -> &str {
        self.descriptor.name()
    }

    /// Fully qualified identity including the service name.
    pub fn full_name(&self) -> &str {
        self.descriptor.full_name()
    }

    /// Navigates to the request message type.
    pub fn input(&self) -> Message {
        Message::new(&self.catalog, self.descriptor.input())
    }

    /// Navigates to the response message type.
    pub fn output(&self) -> Message {
        Message::new(&self.catalog, self.descriptor.output())
    }

    /// Whether the client may send a stream of request messages.
    pub fn client_streaming(&self) -> bool {
        self.descriptor.is_client_streaming()
    }

    /// Whether the server may send a stream of response messages.
    pub fn server_streaming(&self) -> bool {
        self.descriptor.is_server_streaming()
    }

    /// Navigates to the service declaring this method.
    pub fn parent_service(&self) -> Service {
        Service::new(&self.catalog, self.descriptor.parent_service().clone())
    }

    /// Finds source comments and optional coordinates for this method.
    pub fn declaration(&self) -> Declaration {
        Declaration::new(
            &self.catalog,
            self.descriptor.parent_file(),
            self.descriptor.path(),
        )
    }

    /// Exposes complete RPC options and original signature metadata.
    pub fn descriptor(&self) -> &MethodDescriptor {
        &self.descriptor
    }

    pub(crate) fn new(catalog: &Catalog, descriptor: MethodDescriptor) -> Self {
        Self {
            catalog: catalog.clone(),
            descriptor,
        }
    }
}

/// A declaration using a message or enum as a value or RPC endpoint type.
///
/// Extension references describe their value type, not the message they extend.
/// Map values reference the ordinary map field, never a synthetic entry field.
#[derive(Clone, Debug)]
pub enum Reference {
    /// A singular, repeated, or map-value field of an ordinary message.
    Field(Field),
    /// An extension whose value uses this type; inspect its original descriptor.
    Extension(ExtensionDescriptor),
    /// An RPC using this type for its request messages.
    MethodInput(Method),
    /// An RPC using this type for its response messages.
    MethodOutput(Method),
}
