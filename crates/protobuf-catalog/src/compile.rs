//! Compiles local protobuf projects into immutable catalogs. [`Project`] defines the import roots.

use crate::Catalog;
use protox::file::{File, FileResolver, GoogleFileResolver};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    error::Error,
    fmt, fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    rc::Rc,
    sync::Arc,
};

const MAX_SOURCE_FILES: usize = 10_000;
const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;

/// A local project whose discovered `.proto` files are compiled together.
///
/// Dependencies are opened only when imported. Imports must resolve unambiguously
/// inside one configured root; bundled standard and Google HTTP annotation files
/// are available as a fallback.
#[derive(Debug, Clone)]
pub struct Project {
    /// Directory recursively searched for `.proto` entry points; symlink entries are skipped.
    pub root: PathBuf,
    /// Additional import directories, in resolution order after `root`.
    ///
    /// Equivalent canonical paths are deduplicated. Files in these directories are
    /// compiled only when imported by an entry point or another dependency.
    pub include_paths: Vec<PathBuf>,
}

/// Compiles a project and captures the exact source text used for each local descriptor.
///
/// Descriptors and sources belong to the same immutable snapshot. Built-in Google
/// descriptors have no captured source. Compilation accepts at most 10,000 local
/// files and 32 MiB of UTF-8 source, including imported files of any extension.
///
/// # Errors
///
/// Returns a structured [`LoadError`] for filesystem, import, resource-limit, or
/// compiler failures. The compiler's original diagnostics are retained.
pub fn load(project: &Project) -> Result<Catalog, LoadError> {
    Ok(load_project(project, false)?.catalog)
}

/// A catalog of successfully compiled files and failures for skipped entry points.
#[derive(Debug)]
pub struct PartialLoad {
    /// The current snapshot, containing successful files and their dependencies.
    pub catalog: Catalog,
    /// Entry points that could not be compiled, in deterministic path order.
    pub failures: Vec<FileFailure>,
}

/// The error that prevented one discovered entry point from being compiled.
#[derive(Debug)]
pub struct FileFailure {
    /// Entry point's path relative to the project root.
    pub file: PathBuf,
    /// Compiler or resolver failure, including the original diagnostic.
    pub error: LoadError,
}

/// Compiles independent entry points even when other files fail.
///
/// A failed entry point and files depending on it are excluded; successfully
/// compiled dependencies remain available. Global setup and resource limits are
/// fatal, and if every entry point fails, the first failure is returned.
///
/// # Errors
///
/// Returns a [`LoadError`] for setup, resource-limit, or all-entry-point failure.
pub fn load_partial(project: &Project) -> Result<PartialLoad, LoadError> {
    load_project(project, true)
}

fn load_project(project: &Project, allow_partial: bool) -> Result<PartialLoad, LoadError> {
    let root = canonicalize(&project.root)?;
    let mut roots = vec![root.clone()];
    for include in &project.include_paths {
        let path = canonicalize(include)?;
        if !roots.contains(&path) {
            roots.push(path);
        }
    }

    let mut files = Vec::new();
    scan(&root, &mut files)?;
    files.sort();
    if files.is_empty() {
        return Err(LoadError::NoSources { root });
    }

    // The resolver owns one clone while compilation runs. No mutable construction
    // state escapes into Catalog: only its completed source map is moved there.
    let state = Rc::new(RefCell::new(CompilationState::default()));
    let mut compiler = protox::Compiler::with_file_resolver(ProjectResolver {
        roots,
        state: Rc::clone(&state),
    });
    compiler.include_imports(true).include_source_info(true);
    let mut failures = Vec::new();
    let mut successes = 0;
    for file in &files {
        if let Err(source) = compiler.open_file(file) {
            let error = state
                .borrow_mut()
                .error
                .take()
                .unwrap_or(LoadError::Compilation { source });
            if !allow_partial
                || matches!(
                    error,
                    LoadError::TooManySources { .. } | LoadError::SourcesTooLarge { .. }
                )
            {
                return Err(error);
            }
            failures.push(FileFailure {
                file: file
                    .strip_prefix(&root)
                    .expect("discovered under root")
                    .to_owned(),
                error,
            });
        } else {
            successes += 1;
        }
    }
    if successes == 0 {
        return Err(failures.remove(0).error);
    }

    let pool = compiler.descriptor_pool();
    let sources = std::mem::take(&mut state.borrow_mut().sources);
    Ok(PartialLoad {
        catalog: Catalog::with_sources(pool, sources),
        failures,
    })
}

/// A project-loading failure with its original filesystem or compiler cause.
#[derive(Debug)]
pub enum LoadError {
    /// A filesystem operation failed before or during compilation.
    Io {
        /// Operation attempted, such as canonicalizing a root or reading a source.
        operation: &'static str,
        /// Filesystem path on which the operation failed.
        path: PathBuf,
        /// Original operating-system error, including invalid UTF-8 source errors.
        source: io::Error,
    },
    /// The project directory contained no discoverable `.proto` entry points.
    NoSources {
        /// Canonical project directory that was searched.
        root: PathBuf,
    },
    /// Discovery or import resolution exceeded the local source-file count.
    TooManySources {
        /// Path whose discovery or opening exceeded the limit.
        path: PathBuf,
        /// Maximum number of local source files accepted for one snapshot.
        limit: usize,
    },
    /// The combined UTF-8 contents exceeded the source-byte budget.
    SourcesTooLarge {
        /// Source path whose contents exceeded the remaining budget.
        path: PathBuf,
        /// Maximum combined source size in bytes for one snapshot.
        limit: usize,
    },
    /// An import name contains a parent, root, or other non-normal path component.
    InvalidImport {
        /// Rejected logical import name as written in the protobuf source.
        name: String,
    },
    /// An import followed a symlink outside the root through which it was found.
    EscapingImport {
        /// Logical import name being resolved.
        name: String,
        /// Canonical destination that escaped its configured root.
        path: PathBuf,
        /// Canonical root that must contain the destination.
        root: PathBuf,
    },
    /// Different physical files have the same logical import name.
    AmbiguousImport {
        /// Logical name shared by the conflicting files.
        name: String,
        /// First canonical file found in configured-root order.
        first: PathBuf,
        /// Another canonical file exposed under the same logical name.
        second: PathBuf,
    },
    /// Parsing, type checking, or resolving a missing import failed.
    Compilation {
        /// Original compiler error, retaining source locations and rich diagnostics.
        source: protox::Error,
    },
}

impl fmt::Display for LoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "Could not {operation} {}: {source}",
                path.display()
            ),
            Self::NoSources { root } => {
                write!(formatter, "No .proto files found in {}", root.display())
            }
            Self::TooManySources { path, limit } => write!(
                formatter,
                "Protobuf project exceeds {limit} source files while opening {}",
                path.display()
            ),
            Self::SourcesTooLarge { path, limit } => write!(
                formatter,
                "Protobuf project exceeds {} MiB of source while reading {}",
                limit / (1024 * 1024),
                path.display()
            ),
            Self::InvalidImport { name } => {
                write!(formatter, "Unsafe protobuf import name: {name}")
            }
            Self::EscapingImport { name, path, root } => write!(
                formatter,
                "Import {name} resolves to {} outside {}",
                path.display(),
                root.display()
            ),
            Self::AmbiguousImport {
                name,
                first,
                second,
            } => write!(
                formatter,
                "Import {name} is ambiguous between {} and {}",
                first.display(),
                second.display()
            ),
            Self::Compilation { source } => write!(formatter, "{source}"),
        }
    }
}

impl Error for LoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Compilation { source } => Some(source),
            _ => None,
        }
    }
}

fn canonicalize(path: &Path) -> Result<PathBuf, LoadError> {
    path.canonicalize().map_err(|source| LoadError::Io {
        operation: "canonicalize",
        path: path.to_owned(),
        source,
    })
}

fn scan(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), LoadError> {
    let entries = fs::read_dir(directory).map_err(|source| LoadError::Io {
        operation: "read directory",
        path: directory.to_owned(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| LoadError::Io {
            operation: "read directory entry in",
            path: directory.to_owned(),
            source,
        })?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|source| LoadError::Io {
            operation: "inspect",
            path: path.clone(),
            source,
        })?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            scan(&path, files)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "proto")
        {
            if files.len() == MAX_SOURCE_FILES {
                return Err(LoadError::TooManySources {
                    path,
                    limit: MAX_SOURCE_FILES,
                });
            }
            files.push(path);
        }
    }
    Ok(())
}

#[derive(Default)]
struct CompilationState {
    // Captured after parsing; these are the exact source bytes that produced each
    // descriptor, keyed by the same logical file name used by the descriptor pool.
    sources: BTreeMap<String, Arc<str>>,
    // Updated with each captured local file; the next read stops after the
    // remaining budget plus one byte used to detect overflow.
    bytes: usize,
    // The compiler resolver protocol returns protox::Error. Preserve structured
    // filesystem/security failures separately until load can return its own error.
    error: Option<LoadError>,
}

struct ProjectResolver {
    // Canonical, distinct roots in configuration order; the project root comes
    // first so entry points keep their project-relative logical file names.
    roots: Vec<PathBuf>,
    // Shared only with load during construction; the finished catalog owns the
    // source map without this mutable resolver state.
    state: Rc<RefCell<CompilationState>>,
}

impl FileResolver for ProjectResolver {
    fn resolve_path(&self, path: &Path) -> Option<String> {
        self.roots.iter().find_map(|root| {
            path.strip_prefix(root)
                .ok()?
                .to_str()
                .map(|name| name.replace('\\', "/"))
        })
    }

    fn open_file(&self, name: &str) -> Result<File, protox::Error> {
        if name.is_empty()
            || Path::new(name)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(self.reject(LoadError::InvalidImport {
                name: name.to_owned(),
            }));
        }

        let mut found: Option<PathBuf> = None;
        for root in &self.roots {
            let candidate = root.join(name);
            let path = match candidate.canonicalize() {
                Ok(path) => path,
                Err(source)
                    if matches!(
                        source.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                    ) =>
                {
                    continue;
                }
                Err(source) => {
                    return Err(self.reject(LoadError::Io {
                        operation: "canonicalize import",
                        path: candidate,
                        source,
                    }));
                }
            };
            if !path.starts_with(root) {
                return Err(self.reject(LoadError::EscapingImport {
                    name: name.to_owned(),
                    path,
                    root: root.clone(),
                }));
            }
            if let Some(previous) = &found {
                if previous != &path {
                    return Err(self.reject(LoadError::AmbiguousImport {
                        name: name.to_owned(),
                        first: previous.clone(),
                        second: path,
                    }));
                }
            } else {
                found = Some(path);
            }
        }

        let Some(path) = found else {
            if let Some(source) = bundled_google_api_source(name) {
                return File::from_source(name, source);
            }
            return GoogleFileResolver::new().open_file(name);
        };
        if let Some(source) = self.state.borrow().sources.get(name) {
            return File::from_source(name, source);
        }
        let (source_count, remaining_bytes) = {
            let state = self.state.borrow();
            (state.sources.len(), MAX_SOURCE_BYTES - state.bytes)
        };
        if source_count == MAX_SOURCE_FILES {
            return Err(self.reject(LoadError::TooManySources {
                path,
                limit: MAX_SOURCE_FILES,
            }));
        }
        let source = read_source(&path, remaining_bytes).map_err(|error| self.reject(error))?;
        let file = File::from_source(name, &source)?;
        let source: Arc<str> = Arc::from(file.source().expect("local sources retain their text"));

        let mut state = self.state.borrow_mut();
        state.bytes += source.len();
        state.sources.insert(name.to_owned(), source);
        Ok(file)
    }
}

// Local files take precedence so projects can supply their own Google APIs version.
fn bundled_google_api_source(name: &str) -> Option<&'static str> {
    match name {
        "google/api/annotations.proto" => {
            Some(include_str!("../vendor/google/api/annotations.proto"))
        }
        "google/api/http.proto" => Some(include_str!("../vendor/google/api/http.proto")),
        _ => None,
    }
}

impl ProjectResolver {
    fn reject(&self, error: LoadError) -> protox::Error {
        let message = error.to_string();
        self.state.borrow_mut().error = Some(error);
        protox::Error::new(io::Error::other(message))
    }
}

fn read_source(path: &Path, remaining_bytes: usize) -> Result<String, LoadError> {
    let file = fs::File::open(path).map_err(|source| LoadError::Io {
        operation: "open source",
        path: path.to_owned(),
        source,
    })?;
    let mut bytes = Vec::new();
    file.take(remaining_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| LoadError::Io {
            operation: "read source",
            path: path.to_owned(),
            source,
        })?;
    if bytes.len() > remaining_bytes {
        return Err(LoadError::SourcesTooLarge {
            path: path.to_owned(),
            limit: MAX_SOURCE_BYTES,
        });
    }
    String::from_utf8(bytes).map_err(|source| LoadError::Io {
        operation: "decode UTF-8 source",
        path: path.to_owned(),
        source: io::Error::new(io::ErrorKind::InvalidData, source),
    })
}
