// Launches the desktop binary through the library's run function.
// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    reqlet_lib::run()
}
