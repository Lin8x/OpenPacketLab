mod backup;

use std::sync::Mutex;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::{Emitter, Manager};

/// A project file passed on the command line or by the OS (double-clicking a .opl file).
struct StartupFile(Mutex<Option<String>>);

fn project_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| {
        let lower = a.to_lowercase();
        !a.starts_with('-') && (lower.ends_with(".opl") || lower.ends_with(".json"))
    })
}

/// Returns (once) the project file the app was launched with, if any.
#[tauri::command]
fn startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut f| f.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StartupFile(Mutex::new(project_arg(std::env::args()))))
        .invoke_handler(tauri::generate_handler![
            startup_file,
            backup::secrets_load,
            backup::secrets_save,
            backup::backup_folder_write,
            backup::backup_folder_list,
            backup::backup_folder_remove,
            backup::backup_sftp_test,
            backup::backup_sftp_put,
            backup::backup_sftp_list,
            backup::backup_sftp_remove,
            backup::backup_ftp_test,
            backup::backup_ftp_put,
            backup::backup_ftp_list,
            backup::backup_ftp_remove,
            backup::backup_rclone_put,
            backup::backup_rclone_list,
            backup::backup_rclone_remove,
            backup::backup_rclone_test,
            backup::oauth_listen,
            backup::oauth_wait,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building OpenPacketLab");

    app.run(|_handle, _event| {
        // macOS delivers "open with" requests as events rather than arguments.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                let path = path.to_string_lossy().to_string();
                if let Some(state) = _handle.try_state::<StartupFile>() {
                    if let Ok(mut f) = state.0.lock() {
                        *f = Some(path.clone());
                    }
                }
                let _ = _handle.emit("open-file", path);
            }
        }
    });
}
