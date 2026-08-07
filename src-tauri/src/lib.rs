mod ai;
mod ai_client;
mod auth;
mod client;
mod commands;
mod models;

#[cfg(target_os = "android")]
pub mod jni;

use client::{MagisterClient, SharedClient};
use commands::ai::AiState;
use std::sync::Arc;
use tokio::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client: SharedClient = Arc::new(Mutex::new(MagisterClient::new()));
    let client_for_setup = client.clone();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    builder
        .setup(move |app| {
            // Initialize AI state with app data directory
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let ai_state = AiState::new(app_data_dir);
            app.manage(ai_state);

            // Give the client a handle so ensure_valid_token() can persist mid-session
            // token refreshes to disk (see client.rs / bug #11). Using spawn (not
            // block_on) — block_on nested inside Tauri's own setup runtime has caused
            // "cannot start a runtime from within a runtime" panics in similar cases;
            // this just needs to finish before the first real command runs, which it
            // will trivially.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                client_for_setup.lock().await.set_app_handle(handle);
            });
            #[cfg(mobile)]
            {
                use tauri::Emitter;
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if url.scheme() == "m6loapp" {
                            app_handle.emit("auth-callback", url.as_str()).ok();
                        }
                    }
                });
            }
            Ok(())
        })
        .manage(client)
        .invoke_handler(tauri::generate_handler![
            // Auth
            commands::auth::start_login_flow,
            commands::auth::handle_auth_callback,
            commands::auth::is_authenticated,
            commands::auth::get_account,
            commands::auth::get_person_id,
            commands::auth::get_profile_picture,
            commands::auth::logout,
            commands::auth::restore_session,
            commands::auth::get_profile_info,
            commands::auth::get_profile_addresses,
            commands::auth::get_career_info,
            // Calendar
            commands::calendar::get_calendar_events,
            commands::calendar::get_absences,
            commands::calendar::get_calendar_event,
            commands::calendar::create_calendar_event,
            commands::calendar::update_calendar_event,
            commands::calendar::delete_calendar_event,
            commands::calendar::download_file,
            // Grades
            commands::grades::get_schoolyears,
            commands::grades::get_grades,
            commands::grades::get_grade_extra_info,
            commands::grades::get_bulk_grade_extra_info,
            commands::grades::get_recent_grades,
            // Messages
            commands::messages::get_message_folders,
            commands::messages::get_messages,
            commands::messages::get_message_detail,
            commands::messages::send_message,
            commands::messages::mark_messages_as_read,
            commands::messages::move_messages_to_folder,
            commands::messages::delete_messages,
            commands::messages::search_contacts,
            // Assignments
            commands::assignments::get_assignments,
            commands::assignments::get_assignment_detail,
            commands::assignments::hand_in_assignment,
            commands::assignments::upload_assignment_attachment,
            // Leermiddelen
            commands::leermiddelen::get_leermiddelen,
            commands::leermiddelen::get_leermiddel_launch_url,
            // Activities
            commands::activities::get_activities,
            commands::activities::get_activity_elements,
            // Bronnen
            commands::bronnen::get_bronnen,
            commands::bronnen::get_external_bron_sources,
            // Studiewijzers
            commands::studiewijzers::get_studiewijzers,
            commands::studiewijzers::get_studiewijzer_detail,
            commands::studiewijzers::get_studiewijzer_onderdeel_detail,
            commands::notifications::trigger_test_notification,
            commands::notifications::show_notification,
            commands::notifications::trigger_sync,
            commands::notifications::sync_notification_preferences,
            commands::notifications::open_notification_policy_settings,
            commands::notifications::clear_sync_state,
            commands::notifications::get_sync_state_debug,
            commands::notifications::get_debug_info,
            commands::notifications::get_sync_interval,
            commands::notifications::set_sync_interval,
            commands::notifications::get_night_sleep_config,
            commands::notifications::set_night_sleep_config,
            commands::notifications::get_disable_all_notifications,
            commands::notifications::set_disable_all_notifications,
            // AI relevance scoring
            commands::notifications::get_relevance_threshold,
            commands::notifications::set_relevance_threshold,
            commands::notifications::get_notification_history,
            // AI commands
            commands::ai::get_ai_config,
            commands::ai::set_ai_config,
            commands::ai::validate_ai_key,
            commands::ai::ai_chat,
            commands::ai::ai_chat_with_tools,
            commands::ai::ai_page_insight,
            commands::ai::list_ai_models,
            // Export
            commands::export::export_all_data,
        ])
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
