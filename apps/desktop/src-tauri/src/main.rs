// SCG Shop ERP client: a thin shell that finds the main machine on the LAN, then
// navigates its webview to the main machine's web UI. All business logic lives on
// the main machine; this app only adds LAN discovery and local receipt printing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;
mod printing;

use std::time::Duration;

use discovery::DiscoveredMain;

/// Browse mDNS for `_scgerp._tcp` for ~2 s. Returns an empty list when nothing
/// answers (including while the server does not advertise yet).
#[tauri::command]
async fn discover_main() -> Result<Vec<DiscoveredMain>, String> {
    tauri::async_runtime::spawn_blocking(|| discovery::browse(Duration::from_secs(2)))
        .await
        .map_err(|e| e.to_string())?
}

/// Send raw ESC/POS bytes to a Windows printer queue by name.
#[tauri::command]
async fn print_receipt(printer_name: String, escpos_bytes: Vec<u8>) -> Result<(), String> {
    if escpos_bytes.is_empty() {
        return Err("receipt is empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || printing::print_raw(&printer_name, &escpos_bytes))
        .await
        .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![discover_main, print_receipt])
        .run(tauri::generate_context!())
        .expect("error while running SCG Shop ERP client");
}
