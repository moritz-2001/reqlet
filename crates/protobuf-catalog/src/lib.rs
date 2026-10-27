//! Immutable protobuf project snapshots. [`Catalog`] owns descriptors, captured
//! sources, and reference indexes; cloneable declaration handles retain that
//! same snapshot even after the caller reloads or drops its original catalog.
//!
//! ```no_run
//! # #[cfg(feature = "compile")]
//! # fn example() -> Result<(), Box<dyn std::error::Error>> {
//! use protobuf_catalog::{compile, FieldShape, ValueType};
//!
//! let catalog = compile::load(&compile::Project {
//!     root: "models".into(),
//!     include_paths: vec!["third_party".into()],
//! })?;
//! if let Some(message) = catalog.message("company.users.CreateUserRequest") {
//!     for field in message.fields() {
//!         if let FieldShape::Singular(ValueType::Message(child)) = field.shape() {
//!             println!("{} references {}", field.json_name(), child.full_name());
//!         }
//!     }
//! }
//! # Ok(())
//! # }
//! ```

#[cfg(feature = "compile")]
pub mod compile;
pub mod json;
mod model;
pub mod snapshot;
mod source;

pub use model::{
    Enum, EnumValue, Field, FieldShape, File, MapKeyType, Message, Method, Oneof, Presence,
    Reference, ScalarType, Service, ValueType,
};
pub use prost_reflect;
pub use source::{Declaration, Documentation, SourceLocation};

use prost_reflect::{
    DescriptorError, DescriptorPool, ExtensionDescriptor, FieldDescriptor, Kind, MethodDescriptor,
};
use std::{collections::BTreeMap, fmt, sync::Arc};

/// An immutable protobuf graph with source context and reverse references.
///
/// Handles returned by queries share this snapshot, including captured source.
/// Names have no leading dot and remain suitable for storage across reloads;
/// handles always refer to their original snapshot. Synthetic map-entry messages
/// are excluded from the convenient API and remain available through descriptors.
#[derive(Clone)]
pub struct Catalog {
    /// Shared immutable storage keeps navigation cheap and prevents reloads from
    /// pairing an old descriptor with newer source text or reference indexes.
    inner: Arc<CatalogInner>,
}

impl Catalog {
    /// Decodes an encoded FileDescriptorSet, preserving custom descriptor options.
    ///
    /// Original source text is unavailable. Descriptor source locations and
    /// documentation remain accessible when included in the input descriptor set.
    pub fn decode_descriptor_set(bytes: &[u8]) -> Result<Self, CatalogError> {
        DescriptorPool::decode(bytes).map(Self::from_descriptor_pool)
    }

    /// Wraps a validated descriptor pool without compiling or reading files.
    ///
    /// No original source text is attached. Subsequent modifications of another
    /// pool clone do not change this catalog's descriptors.
    pub fn from_descriptor_pool(pool: DescriptorPool) -> Self {
        Self::with_sources(pool, BTreeMap::new())
    }

    /// Finds a non-synthetic message by fully qualified protobuf name.
    pub fn message(&self, name: &str) -> Option<Message> {
        self.inner
            .pool
            .get_message_by_name(name)
            .filter(|descriptor| !descriptor.is_map_entry())
            .map(|descriptor| Message::new(self, descriptor))
    }

    /// Finds an enum by fully qualified protobuf name.
    pub fn enum_type(&self, name: &str) -> Option<Enum> {
        self.inner
            .pool
            .get_enum_by_name(name)
            .map(|descriptor| Enum::new(self, descriptor))
    }

    /// Finds a service by fully qualified protobuf name.
    pub fn service(&self, name: &str) -> Option<Service> {
        self.inner
            .pool
            .get_service_by_name(name)
            .map(|descriptor| Service::new(self, descriptor))
    }

    /// Finds a file by its logical protobuf import name, never a local path.
    pub fn file(&self, name: &str) -> Option<File> {
        self.inner
            .pool
            .get_file_by_name(name)
            .map(|descriptor| File::new(self, descriptor))
    }

    /// Enumerates all ordinary messages, including nested and imported messages.
    ///
    /// Order follows the descriptor pool; use names when a durable order is needed.
    pub fn messages(&self) -> impl Iterator<Item = Message> + '_ {
        self.inner
            .pool
            .all_messages()
            .filter(|descriptor| !descriptor.is_map_entry())
            .map(|descriptor| Message::new(self, descriptor))
    }

    /// Enumerates all enums, including nested and imported declarations.
    pub fn enums(&self) -> impl Iterator<Item = Enum> + '_ {
        self.inner
            .pool
            .all_enums()
            .map(|descriptor| Enum::new(self, descriptor))
    }

    /// Enumerates all services, including imported declarations.
    pub fn services(&self) -> impl Iterator<Item = Service> + '_ {
        self.inner
            .pool
            .services()
            .map(|descriptor| Service::new(self, descriptor))
    }

    /// Enumerates source and dependency files in descriptor-pool order.
    pub fn files(&self) -> impl Iterator<Item = File> + '_ {
        self.inner
            .pool
            .files()
            .map(|descriptor| File::new(self, descriptor))
    }

    /// Exposes complete descriptors for options and less common protobuf features.
    ///
    /// Read-only access preserves the catalog's agreement with source and indexes.
    pub fn descriptor_pool(&self) -> &DescriptorPool {
        &self.inner.pool
    }

    /// Projects the graph to serializable named references for frontend consumers.
    pub fn to_snapshot(&self) -> snapshot::CatalogSnapshot {
        snapshot::CatalogSnapshot::from_catalog(self)
    }

    pub(crate) fn with_sources(pool: DescriptorPool, sources: BTreeMap<String, Arc<str>>) -> Self {
        let references = index_references(&pool);
        Self {
            inner: Arc::new(CatalogInner {
                pool,
                sources,
                references,
            }),
        }
    }

    pub(crate) fn source(&self, name: &str) -> Option<&str> {
        self.inner.sources.get(name).map(AsRef::as_ref)
    }

    pub(crate) fn references(&self, name: &str) -> impl Iterator<Item = Reference> + '_ {
        self.inner
            .references
            .get(name)
            .into_iter()
            .flatten()
            .map(|reference| match reference {
                ReferenceDescriptor::Field(descriptor) => {
                    Reference::Field(Field::new(self, descriptor.clone()))
                }
                ReferenceDescriptor::Extension(descriptor) => {
                    Reference::Extension(descriptor.clone())
                }
                ReferenceDescriptor::MethodInput(descriptor) => {
                    Reference::MethodInput(Method::new(self, descriptor.clone()))
                }
                ReferenceDescriptor::MethodOutput(descriptor) => {
                    Reference::MethodOutput(Method::new(self, descriptor.clone()))
                }
            })
    }
}

impl fmt::Debug for Catalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Catalog")
            .field("files", &self.inner.pool.files().len())
            .field("captured_sources", &self.inner.sources.len())
            .finish_non_exhaustive()
    }
}

/// A malformed or inconsistent input descriptor set.
///
/// This is the descriptor library's structured error, including its underlying
/// diagnostics. Source compilation errors are separately returned by `compile`
/// when that feature is enabled.
pub type CatalogError = DescriptorError;

struct CatalogInner {
    pool: DescriptorPool,
    sources: BTreeMap<String, Arc<str>>,
    // Store descriptors, not catalog handles: a handle here would own this same
    // CatalogInner through Arc and create a reference cycle.
    references: BTreeMap<String, Vec<ReferenceDescriptor>>,
}

enum ReferenceDescriptor {
    Field(FieldDescriptor),
    Extension(ExtensionDescriptor),
    MethodInput(MethodDescriptor),
    MethodOutput(MethodDescriptor),
}

fn index_references(pool: &DescriptorPool) -> BTreeMap<String, Vec<ReferenceDescriptor>> {
    let mut references = BTreeMap::<String, Vec<ReferenceDescriptor>>::new();
    for message in pool
        .all_messages()
        .filter(|message| !message.is_map_entry())
    {
        for field in message.fields() {
            let kind = match field.kind() {
                Kind::Message(entry) if field.is_map() => entry.map_entry_value_field().kind(),
                kind => kind,
            };
            if let Some(name) = referenced_name(kind) {
                references
                    .entry(name)
                    .or_default()
                    .push(ReferenceDescriptor::Field(field));
            }
        }
    }
    for extension in pool.all_extensions() {
        if let Some(name) = referenced_name(extension.kind()) {
            references
                .entry(name)
                .or_default()
                .push(ReferenceDescriptor::Extension(extension));
        }
    }
    for service in pool.services() {
        for method in service.methods() {
            references
                .entry(method.input().full_name().to_owned())
                .or_default()
                .push(ReferenceDescriptor::MethodInput(method.clone()));
            references
                .entry(method.output().full_name().to_owned())
                .or_default()
                .push(ReferenceDescriptor::MethodOutput(method));
        }
    }
    references
}

fn referenced_name(kind: Kind) -> Option<String> {
    match kind {
        Kind::Message(message) => Some(message.full_name().to_owned()),
        Kind::Enum(enumeration) => Some(enumeration.full_name().to_owned()),
        _ => None,
    }
}
