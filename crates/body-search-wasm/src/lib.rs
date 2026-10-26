//! Bridges retained response buffers and short-lived SearchQuery handles into the pure search core.
use body_search::{Direction, SearchQuery};

/// A host-filled UTF-16 buffer retained until the host explicitly frees it.
pub struct SearchBuffer {
    /// Exact original source or query units. Initialized to zero, filled once by
    /// JavaScript, then borrowed by query compilation or bounded search calls.
    units: Vec<u16>,
}

/// Allocates a buffer; the host must fill it before searching and free it once.
#[unsafe(no_mangle)]
pub extern "C" fn buffer_new(length: usize) -> *mut SearchBuffer {
    Box::into_raw(Box::new(SearchBuffer {
        units: vec![0; length],
    }))
}

/// Returns writable input storage without transferring its ownership.
///
/// # Safety
/// `buffer` must be live and exclusively used, from `buffer_new`. Write only its
/// allocated number of units; recreate host views after any allocating Wasm call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn buffer_text(buffer: *mut SearchBuffer) -> *mut u16 {
    unsafe { (*buffer).units.as_mut_ptr() }
}

/// Compiles a query, returning null for empty or over-limit input.
///
/// # Safety
/// `buffer` must be live and completely filled. The compiled query owns its
/// matching tables, so the input buffer can be freed after this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn query_new(buffer: *const SearchBuffer) -> *mut SearchQuery {
    let source = unsafe { &(*buffer).units };
    SearchQuery::new(source).map_or(std::ptr::null_mut(), |query| Box::into_raw(Box::new(query)))
}

/// Searches candidate starts `[from, to)` forward or candidate ends `(from, to]` backward.
/// Returns packed UTF-16 offsets (start in the upper 32 bits), or all bits set for no match.
///
/// # Safety
/// Both handles must be live and fully initialized. Neither buffer nor query may
/// be mutated or freed during the call. No references are retained after return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_range(
    buffer: *const SearchBuffer,
    query: *const SearchQuery,
    from: usize,
    to: usize,
    backward: u32,
) -> u64 {
    let source = unsafe { &(*buffer).units };
    let query = unsafe { &*query };
    let direction = if backward == 0 {
        Direction::Forward
    } else {
        Direction::Backward
    };
    query
        .find_in_range(source, from, to, direction)
        .map_or(u64::MAX, |found| {
            ((found.from as u64) << 32) | found.to as u64
        })
}

/// Releases a compiled query after all of its pending scans have stopped.
///
/// # Safety
/// `query` must be a non-null live handle from `query_new`, freed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn query_free(query: *mut SearchQuery) {
    drop(unsafe { Box::from_raw(query) });
}

/// Releases response or query input storage after all borrowers have stopped.
///
/// # Safety
/// `buffer` must be a live handle from `buffer_new`, freed exactly once. No host
/// view or scan may access its storage afterward.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn buffer_free(buffer: *mut SearchBuffer) {
    drop(unsafe { Box::from_raw(buffer) });
}
