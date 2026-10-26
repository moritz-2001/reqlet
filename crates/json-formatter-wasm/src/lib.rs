//! Bridges UTF-16 buffers into the pure formatter; each FormatJob owns one call's memory.
use json_formatter::{FormatError, format_json};

/// One JavaScript call's owned input, replaced by formatted output on success.
pub struct FormatJob {
    /// Initially zeroed input filled by the host; replaced only after successful formatting.
    /// Host views must be recreated after operations that can grow Wasm memory.
    text: Vec<u16>,
}

/// Allocates a job and its UTF-16 input. The host releases it with `job_free`.
#[unsafe(no_mangle)]
pub extern "C" fn job_new(length: usize) -> *mut FormatJob {
    Box::into_raw(Box::new(FormatJob {
        text: vec![0; length],
    }))
}

/// Returns the current text buffer for filling input or reading successful output.
///
/// # Safety
/// `job` must be a live pointer from `job_new`. The returned pointer is invalidated
/// by `job_format` and `job_free`; the host must never write beyond the input length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn job_text(job: *mut FormatJob) -> *mut u16 {
    unsafe { (*job).text.as_mut_ptr() }
}

/// Returns the current buffer's UTF-16 length, including after successful formatting.
///
/// # Safety
/// `job` must be a live pointer from `job_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn job_length(job: *const FormatJob) -> usize {
    unsafe { (*job).text.len() }
}

/// Formats the input, returning 0 for success, 1 for invalid JSONC, or 2 for the output limit.
/// On failure the original input remains owned by the job until it is freed.
///
/// # Safety
/// `job` must be a live, exclusively used pointer from `job_new`. The host must
/// finish filling its input before this call and stop using its previous text view.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn job_format(job: *mut FormatJob, max_length: usize) -> u32 {
    let job = unsafe { &mut *job };
    match format_json(&job.text, max_length) {
        Ok(text) => {
            job.text = text;
            0
        }
        Err(FormatError::Invalid) => 1,
        Err(FormatError::TooLarge) => 2,
    }
}

/// Releases both the job and its text after the host has copied any successful output.
///
/// # Safety
/// `job` must be a live pointer from `job_new`, freed exactly once. No host view
/// or formatter operation may access the job's memory after this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn job_free(job: *mut FormatJob) {
    drop(unsafe { Box::from_raw(job) });
}
