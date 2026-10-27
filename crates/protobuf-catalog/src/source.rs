//! Source context shared by declaration handles. [`Declaration`] associates
//! descriptor paths with comments and optional locations, independently of
//! whether the original source file was captured.
use crate::{Catalog, File};
use prost_reflect::FileDescriptor;
use serde::Serialize;

/// Source context for one declaration in a catalog snapshot.
#[derive(Clone, Debug)]
pub struct Declaration {
    /// The containing file, which may have descriptors without captured source.
    pub file: File,
    /// Path within FileDescriptorProto, retained even without source information.
    pub descriptor_path: Vec<i32>,
    /// Source comments separated by their relationship to this declaration.
    pub documentation: Documentation,
    /// Declaration span when source information was included; None means that
    /// no usable location was recorded, not that the declaration has no source.
    pub location: Option<SourceLocation>,
}

impl Declaration {
    pub(crate) fn new(catalog: &Catalog, file: FileDescriptor, path: &[i32]) -> Self {
        let location = file
            .file_descriptor_proto()
            .source_code_info
            .as_ref()
            .and_then(|info| info.location.iter().find(|location| location.path == path));
        let documentation = location
            .map(|location| Documentation {
                leading: location.leading_comments.clone().unwrap_or_default(),
                trailing: location.trailing_comments.clone().unwrap_or_default(),
                detached: location.leading_detached_comments.clone(),
            })
            .unwrap_or_default();
        let span = location.and_then(|location| SourceLocation::from_span(&location.span));

        Self {
            file: File::new(catalog, file),
            descriptor_path: path.to_vec(),
            documentation,
            location: span,
        }
    }
}

/// Original descriptor comments, without merging detached and attached prose.
///
/// Comment marker characters are removed by the protobuf compiler. Remaining
/// whitespace is preserved; consumers can format it for their own presentation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Documentation {
    /// Comments immediately preceding the declaration; empty when absent.
    pub leading: String,
    /// Comments following the declaration on its line; empty when absent.
    pub trailing: String,
    /// Earlier comment blocks separated from the declaration by blank lines.
    pub detached: Vec<String>,
}

/// A half-open declaration span using protobuf descriptor source coordinates.
///
/// Lines are one-based for display; columns are zero-based UTF-8 byte offsets
/// within their line, not JavaScript UTF-16 positions. Source text and location
/// metadata are independently optional.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    /// First line occupied by the declaration, starting at one.
    pub start_line: u32,
    /// Byte offset of the declaration's first character in its first line.
    pub start_column: u32,
    /// Line containing the exclusive end, starting at one.
    pub end_line: u32,
    /// Exclusive byte offset within the end line.
    pub end_column: u32,
}

impl SourceLocation {
    fn from_span(span: &[i32]) -> Option<Self> {
        let (start_line, start_column, end_line, end_column) = match *span {
            [line, start, end] => (line, start, line, end),
            [line, start, end_line, end] => (line, start, end_line, end),
            _ => return None,
        };
        let start_line = u32::try_from(start_line).ok()?.checked_add(1)?;
        let end_line = u32::try_from(end_line).ok()?.checked_add(1)?;
        let start_column = u32::try_from(start_column).ok()?;
        let end_column = u32::try_from(end_column).ok()?;
        if (end_line, end_column) < (start_line, start_column) {
            return None;
        }
        Some(Self {
            start_line,
            start_column,
            end_line,
            end_column,
        })
    }
}
