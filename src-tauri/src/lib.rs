// Configures the desktop application; run installs native HTTP execution and cancellation.

mod http;
mod http_redirects;
mod protobuf;

/// Starts Tauri with the native HTTP commands used by the request workspace.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(http::HttpOperations::default())
        .invoke_handler(tauri::generate_handler![
            protobuf::protobuf_load_source,
            http::http_create_operation,
            http::http_execute,
            http::http_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
