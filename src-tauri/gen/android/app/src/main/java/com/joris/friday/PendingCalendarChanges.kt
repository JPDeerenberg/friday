package com.joris.friday

import android.content.Context
import android.util.Log
import org.json.JSONArray
import java.io.File

/**
 * Agenda changes the user has not looked at yet. Filled by the background sync,
 * emptied when the app consumes them after a notification tap (see FridayBridge).
 */
object PendingCalendarChanges {
    private const val FILE = "pending_calendar_changes.json"
    private const val TAG = "PendingCalendarChanges"

    @Synchronized
    fun add(context: Context, added: JSONArray) {
        if (added.length() == 0) return
        try {
            val merged = CalendarChanges.mergePending(read(context), added, System.currentTimeMillis())
            File(context.filesDir, FILE).writeText(merged.toString())
        } catch (e: Exception) {
            Log.w(TAG, "Could not store pending calendar changes", e)
        }
    }

    /** Returns the pending changes as a JSON array string and clears them. */
    @Synchronized
    fun take(context: Context): String {
        return try {
            val current = CalendarChanges.mergePending(read(context), JSONArray(), System.currentTimeMillis())
            File(context.filesDir, FILE).delete()
            current.toString()
        } catch (e: Exception) {
            Log.w(TAG, "Could not read pending calendar changes", e)
            "[]"
        }
    }

    private fun read(context: Context): JSONArray {
        val file = File(context.filesDir, FILE)
        if (!file.exists()) return JSONArray()
        return try {
            JSONArray(file.readText())
        } catch (e: Exception) {
            JSONArray()
        }
    }
}
