fn test_tauri(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("test") {
        let _ = w.close();
        let _ = w.destroy();
        let _ = w.hide();
        let _ = w.webview().close();
    }
}
