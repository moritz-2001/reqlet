//! ProtoJSON views of protobuf declarations. [`JsonRepresentation`] describes
//! canonical output separately from accepted input without expanding the type graph.

use crate::{Field, FieldShape, MapKeyType, Message, ScalarType, ValueType};
use serde::Serialize;

/// A field or message's ProtoJSON shape and its permitted encodings.
///
/// This is descriptive schema metadata, not a JSON validator. Numeric ranges and
/// enum values are obtained from the referenced protobuf type. Serializer options
/// such as printing enum numbers or original field names are not canonical output.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JsonRepresentation {
    /// Semantic shape; named declarations remain references to the same catalog.
    pub shape: JsonShape,
    /// Encodings used by the standard ProtoJSON mapping, including non-finite floats.
    pub canonical: Vec<JsonForm>,
    /// Input encodings accepted in addition to any null behavior described below.
    pub accepted: Vec<JsonForm>,
    /// Whether null unsets a field, represents a present value, or is invalid here.
    pub null_behavior: JsonNullBehavior,
}

/// A finite semantic view of a protobuf value in JSON.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JsonShape {
    /// A primitive with its original protobuf numeric or scalar distinction.
    Scalar {
        /// Original protobuf scalar; its wire encoding does not change its JSON form.
        scalar: ScalarType,
    },
    /// An enum whose names, aliases, and numbers are resolved through the catalog.
    Enum {
        /// Fully qualified enum name without a leading dot.
        name: String,
    },
    /// An ordinary JSON object whose properties come from a message declaration.
    Message {
        /// Fully qualified message name without recursively embedding its fields.
        name: String,
    },
    /// An ordered JSON array; ordinary elements reject null.
    Array {
        /// Per-element mapping; dynamic Value and NullValue preserve null elements.
        element: Box<JsonRepresentation>,
    },
    /// A JSON object with arbitrary keys converted from a protobuf map key type.
    Map {
        /// Original map key type; JSON object keys themselves are always strings.
        key: MapKeyType,
        /// Per-entry mapping; null cannot stand for a missing ordinary map value.
        value: Box<JsonRepresentation>,
    },
    /// A google.protobuf.Any object with an @type URL and an embedded payload.
    /// Ordinary payloads merge their fields; specially mapped well-known types
    /// place their representation under a separate value property.
    Any,
    /// An RFC 3339 timestamp string; canonical output uses Z and 0/3/6/9 decimals.
    Timestamp,
    /// A seconds string ending in s; nanosecond precision is accepted.
    Duration,
    /// Comma-separated field paths with lowerCamelCase path components.
    FieldMask,
    /// A google.protobuf.Struct object with recursively arbitrary JSON values.
    DynamicObject,
    /// Any JSON value, as represented by google.protobuf.Value.
    DynamicValue,
    /// The present null sentinel represented by google.protobuf.NullValue.
    Null,
}

/// A concrete lexical form used by the ProtoJSON mapping.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JsonForm {
    /// A JSON true or false token.
    Boolean,
    /// An ordinary JSON string.
    String,
    /// A JSON number; integer types require an integral value within their range.
    Number,
    /// A decimal integer string used for canonical 64-bit output.
    DecimalString,
    /// A nonempty numeric string; exponent notation and zero fractional parts
    /// are accepted for integers, subject to the protobuf type's range.
    NumericString,
    /// Standard base64 with padding, used for canonical bytes output.
    Base64PaddedString,
    /// Standard or URL-safe base64, with optional padding, accepted for bytes.
    Base64String,
    /// An enum symbol; aliases parse, while output uses the first declared alias.
    EnumName,
    /// An enum's integer value; open enums can also serialize unknown numbers.
    EnumNumber,
    /// One of the exact strings NaN, Infinity, or -Infinity.
    SpecialFloatString,
    /// A JSON object.
    Object,
    /// A JSON array.
    Array,
    /// A JSON null token representing a present sentinel or dynamic value.
    Null,
    /// An RFC 3339 string; parsers accept offsets as well as canonical Z output.
    TimestampString,
    /// A signed decimal seconds string ending in s, with nanosecond precision.
    DurationString,
    /// A comma-separated string of JSON-form field paths.
    FieldMaskString,
}

/// Explains null separately from the non-null lexical encodings of a value.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JsonNullBehavior {
    /// Null is accepted as an absent field, including an empty list or map.
    Unset,
    /// Null is a present value, as with Value, NullValue, and scalar wrappers.
    Value,
    /// Null is invalid, as for ordinary repeated elements and map values.
    Rejected,
}

/// Describes a field's canonical and accepted ProtoJSON representations.
///
/// Unlike collection elements, a field accepts null as an unset value. The
/// special Value, NullValue, and wrapper mappings retain their null semantics.
pub fn field_representation(field: &Field) -> JsonRepresentation {
    let mut representation = match field.shape() {
        FieldShape::Singular(value) => value_representation(value),
        FieldShape::Repeated(value) => representation(
            JsonShape::Array {
                element: Box::new(collection_value_representation(value)),
            },
            vec![JsonForm::Array],
        ),
        FieldShape::Map { key, value } => representation(
            JsonShape::Map {
                key,
                value: Box::new(collection_value_representation(value)),
            },
            vec![JsonForm::Object],
        ),
    };
    if representation.null_behavior == JsonNullBehavior::Rejected {
        representation.null_behavior = JsonNullBehavior::Unset;
    }
    representation
}

/// Describes a message without expanding referenced declarations.
///
/// Well-known types are recognized by their qualified protobuf names. Empty is
/// an ordinary message; Any must therefore embed Empty's fields without value.
pub fn message_representation(message: &Message) -> JsonRepresentation {
    use JsonForm as Form;
    let wrapper = match message.full_name() {
        "google.protobuf.DoubleValue" => Some(ScalarType::Double),
        "google.protobuf.FloatValue" => Some(ScalarType::Float),
        "google.protobuf.Int64Value" => Some(ScalarType::Int64),
        "google.protobuf.UInt64Value" => Some(ScalarType::Uint64),
        "google.protobuf.Int32Value" => Some(ScalarType::Int32),
        "google.protobuf.UInt32Value" => Some(ScalarType::Uint32),
        "google.protobuf.BoolValue" => Some(ScalarType::Bool),
        "google.protobuf.StringValue" => Some(ScalarType::String),
        "google.protobuf.BytesValue" => Some(ScalarType::Bytes),
        _ => None,
    };
    if let Some(scalar) = wrapper {
        let mut result = scalar_representation(scalar);
        result.null_behavior = JsonNullBehavior::Value;
        return result;
    }

    match message.full_name() {
        "google.protobuf.Any" => representation(JsonShape::Any, vec![Form::Object]),
        "google.protobuf.Timestamp" => {
            representation(JsonShape::Timestamp, vec![Form::TimestampString])
        }
        "google.protobuf.Duration" => {
            representation(JsonShape::Duration, vec![Form::DurationString])
        }
        "google.protobuf.FieldMask" => {
            representation(JsonShape::FieldMask, vec![Form::FieldMaskString])
        }
        "google.protobuf.Struct" => representation(JsonShape::DynamicObject, vec![Form::Object]),
        "google.protobuf.ListValue" => representation(
            JsonShape::Array {
                element: Box::new(dynamic_value()),
            },
            vec![Form::Array],
        ),
        "google.protobuf.Value" => dynamic_value(),
        name => representation(JsonShape::Message { name: name.into() }, vec![Form::Object]),
    }
}

fn value_representation(value: ValueType) -> JsonRepresentation {
    match value {
        ValueType::Scalar(scalar) => scalar_representation(scalar),
        ValueType::Message(message) => message_representation(&message),
        ValueType::Enum(value) if value.full_name() == "google.protobuf.NullValue" => {
            let mut result = representation(JsonShape::Null, vec![JsonForm::Null]);
            result.accepted = vec![JsonForm::Null, JsonForm::EnumName, JsonForm::EnumNumber];
            result.null_behavior = JsonNullBehavior::Value;
            result
        }
        ValueType::Enum(value) => {
            let mut canonical = vec![JsonForm::EnumName];
            if value.descriptor().parent_file().syntax() == prost_reflect::Syntax::Proto3 {
                canonical.push(JsonForm::EnumNumber);
            }
            let mut result = representation(
                JsonShape::Enum {
                    name: value.full_name().into(),
                },
                canonical,
            );
            result.accepted = vec![JsonForm::EnumName, JsonForm::EnumNumber];
            result
        }
    }
}

fn collection_value_representation(value: ValueType) -> JsonRepresentation {
    let mut result = value_representation(value);
    // Null wrapper fields are allowed, but wrappers inside collections cannot
    // represent absent elements. Value and NullValue retain present sentinels.
    if matches!(result.shape, JsonShape::Scalar { .. }) {
        result.null_behavior = JsonNullBehavior::Rejected;
    }
    result
}

fn scalar_representation(scalar: ScalarType) -> JsonRepresentation {
    use JsonForm as Form;
    let (canonical, accepted) = match scalar {
        ScalarType::Double | ScalarType::Float => (
            vec![Form::Number, Form::SpecialFloatString],
            vec![Form::Number, Form::NumericString, Form::SpecialFloatString],
        ),
        ScalarType::Int64
        | ScalarType::Uint64
        | ScalarType::Sint64
        | ScalarType::Fixed64
        | ScalarType::Sfixed64 => (
            vec![Form::DecimalString],
            vec![Form::Number, Form::NumericString],
        ),
        ScalarType::Int32
        | ScalarType::Uint32
        | ScalarType::Sint32
        | ScalarType::Fixed32
        | ScalarType::Sfixed32 => (vec![Form::Number], vec![Form::Number, Form::NumericString]),
        ScalarType::Bool => (vec![Form::Boolean], vec![Form::Boolean]),
        ScalarType::String => (vec![Form::String], vec![Form::String]),
        ScalarType::Bytes => (vec![Form::Base64PaddedString], vec![Form::Base64String]),
    };
    JsonRepresentation {
        shape: JsonShape::Scalar { scalar },
        canonical,
        accepted,
        null_behavior: JsonNullBehavior::Rejected,
    }
}

fn representation(shape: JsonShape, canonical: Vec<JsonForm>) -> JsonRepresentation {
    JsonRepresentation {
        shape,
        accepted: canonical.clone(),
        canonical,
        null_behavior: JsonNullBehavior::Rejected,
    }
}

fn dynamic_value() -> JsonRepresentation {
    let mut result = representation(
        JsonShape::DynamicValue,
        vec![
            JsonForm::Null,
            JsonForm::Boolean,
            JsonForm::Number,
            JsonForm::String,
            JsonForm::Object,
            JsonForm::Array,
        ],
    );
    result.null_behavior = JsonNullBehavior::Value;
    result
}
