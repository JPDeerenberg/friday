package com.joris.friday

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * Small bridge the web app uses to learn that it was opened by tapping a
 * notification, and what that notification was about. Exposed to the webview as
 * `window.FridayNative` (see MainActivity.onWebViewCreate).
 */
class FridayBridge(private val appContext: Context, private val activity: MainActivity) {

    /**
     * Opens Android's folder picker (Storage Access Framework). The answer is
     * delivered asynchronously: the web app polls [takePickedFolder] afterwards.
     */
    @JavascriptInterface
    fun pickFolder() {
        activity.launchFolderPicker()
    }

    /**
     * "" while the picker is still open, "CANCELLED" when the user backed out,
     * `{"uri":"content://…","name":"Download/Friday"}` after a successful pick
     * or `ERROR:<reason>`. Returns each answer only once.
     */
    @JavascriptInterface
    fun takePickedFolder(): String {
        return MainActivity.takePickedFolder() ?: ""
    }

    /**
     * Returns "" when the app was not opened through a notification. Otherwise
     * `{"page":"calendar","changes":[...]}` — and forgets it, so the popup shows
     * once. `changes` holds everything that changed since the user last looked.
     */
    @JavascriptInterface
    fun consumeNotificationTap(): String {
        val page = MainActivity.takePendingTap() ?: return ""
        val changes = if (page == "calendar") {
            try {
                JSONArray(PendingCalendarChanges.take(appContext))
            } catch (e: Exception) {
                JSONArray()
            }
        } else {
            JSONArray()
        }
        return JSONObject().put("page", page).put("changes", changes).toString()
    }
}
