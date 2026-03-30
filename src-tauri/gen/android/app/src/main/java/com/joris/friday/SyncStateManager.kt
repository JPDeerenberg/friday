package com.joris.friday

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Manages sync state to detect changes between sync runs.
 * Stores the last known state of messages, grades, and assignments.
 */
object SyncStateManager {
    
    private const val STATE_FILE = "sync_state.json"
    
    private var cachedState: JSONObject? = null
    
    data class SyncChanges(
        val newMessages: List<MessageInfo>,
        val newGrades: List<GradeInfo>,
        val upcomingDeadlines: List<DeadlineInfo>,
        val calendarChanges: List<CalendarChangeInfo>
    )
    
    data class MessageInfo(
        val id: Long,
        val subject: String,
        val senderName: String,
        val timestamp: String
    )
    
    data class GradeInfo(
        val id: Long,
        val description: String,
        val grade: String,
        val courseName: String
    )
    
    data class DeadlineInfo(
        val id: Long,
        val title: String,
        val deadline: String
    )
    
    data class CalendarChangeInfo(
        val id: Long,
        val title: String,
        val startTime: String
    )
    
    /**
     * Load the previous sync state from file
     */
    fun loadState(context: Context): JSONObject? {
        cachedState?.let { return it }
        
        val file = File(context.filesDir, STATE_FILE)
        if (!file.exists()) return null
        
        return try {
            val content = file.readText()
            val state = JSONObject(content)
            cachedState = state
            state
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
    
    /**
     * Save the current sync state to file
     */
    fun saveState(context: Context, state: JSONObject) {
        try {
            val file = File(context.filesDir, STATE_FILE)
            file.writeText(state.toString())
            cachedState = state
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
    
    /**
     * Detect changes between current data and previous state.
     * Returns a SyncChanges object with all detected changes.
     */
    fun detectChanges(
        context: Context,
        currentMessages: JSONArray,
        currentGrades: JSONArray,
        currentAssignments: JSONArray,
        currentCalendar: JSONArray
    ): SyncChanges {
        val previousState = loadState(context) ?: JSONObject()
        
        val newMessages = detectNewMessages(previousState.optJSONArray("messages"), currentMessages)
        val newGrades = detectNewGrades(previousState.optJSONArray("grades"), currentGrades)
        val upcomingDeadlines = detectUpcomingDeadlines(currentAssignments)
        val calendarChanges = detectCalendarChanges(previousState.optJSONArray("calendar"), currentCalendar)
        
        // Save new state
        val newState = JSONObject().apply {
            put("messages", currentMessages)
            put("grades", currentGrades)
            put("calendar", currentCalendar)
            put("lastSync", System.currentTimeMillis())
        }
        saveState(context, newState)
        
        return SyncChanges(
            newMessages = newMessages,
            newGrades = newGrades,
            upcomingDeadlines = upcomingDeadlines,
            calendarChanges = calendarChanges
        )
    }
    
    private fun detectNewMessages(previous: JSONArray?, current: JSONArray): List<MessageInfo> {
        if (current.length() == 0) return emptyList()
        
        val previousIds = mutableSetOf<Long>()
        previous?.let {
            for (i in 0 until it.length()) {
                it.getJSONObject(i).optLong("id").takeIf { id -> id > 0 }?.let { id -> previousIds.add(id) }
            }
        }
        
        val newMessages = mutableListOf<MessageInfo>()
        for (i in 0 until minOf(10, current.length())) { // Check last 10 messages
            val msg = current.getJSONObject(i)
            val id = msg.optLong("id")
            if (id > 0 && id !in previousIds) {
                newMessages.add(MessageInfo(
                    id = id,
                    subject = msg.optString("onderwerp", ""),
                    senderName = extractSenderName(msg),
                    timestamp = msg.optString("datum", "")
                ))
            }
        }
        return newMessages
    }
    
    private fun extractSenderName(message: JSONObject): String {
        // Try to extract sender from "van" field or nested "afzender"
        val van = message.optJSONObject("van")
        if (van != null) {
            return van.optString("achternaam", "").let { lastName ->
                val firstName = van.optString("voornaam", "")
                if (lastName.isNotEmpty()) {
                    if (firstName.isNotEmpty()) "$firstName $lastName" else lastName
                } else {
                    van.optString("naam", "Onbekend")
                }
            }
        }
        
        val afzender = message.optJSONObject("afzender")
        if (afzender != null) {
            return afzender.optString("naam", "Onbekend")
        }
        
        return message.optString("afzenderNaam", "Onbekend")
    }
    
    private fun detectNewGrades(previous: JSONArray?, current: JSONArray): List<GradeInfo> {
        if (current.length() == 0) return emptyList()
        
        val previousIds = mutableSetOf<Long>()
        previous?.let {
            for (i in 0 until it.length()) {
                it.getJSONObject(i).optLong("id").takeIf { id -> id > 0 }?.let { id -> previousIds.add(id) }
            }
        }
        
        val newGrades = mutableListOf<GradeInfo>()
        for (i in 0 until current.length()) {
            val grade = current.getJSONObject(i)
            val id = grade.optLong("id")
            if (id > 0 && id !in previousIds) {
                newGrades.add(GradeInfo(
                    id = id,
                    description = grade.optString("omschrijving", ""),
                    grade = grade.optString("waarde", ""),
                    courseName = extractCourseName(grade)
                ))
            }
        }
        return newGrades
    }
    
    private fun extractCourseName(grade: JSONObject): String {
        val vak = grade.optJSONObject("vak")
        if (vak != null) {
            return vak.optString("naam", "")
        }
        return grade.optString("vakNaam", "")
    }
    
    private fun detectUpcomingDeadlines(assignments: JSONArray): List<DeadlineInfo> {
        val deadlines = mutableListOf<DeadlineInfo>()
        val now = System.currentTimeMillis()
        val oneDayMs = 24 * 60 * 60 * 1000L
        
        for (i in 0 until assignments.length()) {
            val assignment = assignments.getJSONObject(i)
            val deadline = assignment.optString("deadline", "")
            if (deadline.isNotEmpty()) {
                try {
                    val deadlineMs = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
                        .parse(deadline)?.time ?: continue
                    
                    // Only include deadlines within next 24 hours
                    if (deadlineMs > now && deadlineMs <= now + oneDayMs) {
                        deadlines.add(DeadlineInfo(
                            id = assignment.optLong("id"),
                            title = assignment.optString("titel", "Opdracht"),
                            deadline = deadline
                        ))
                    }
                } catch (e: Exception) {
                    // Skip malformed dates
                }
            }
        }
        return deadlines
    }
    
    private fun detectCalendarChanges(previous: JSONArray?, current: JSONArray): List<CalendarChangeInfo> {
        if (current.length() == 0) return emptyList()
        
        val previousIds = mutableSetOf<Long>()
        previous?.let {
            for (i in 0 until it.length()) {
                it.getJSONObject(i).optLong("id").takeIf { id -> id > 0 }?.let { id -> previousIds.add(id) }
            }
        }
        
        val changes = mutableListOf<CalendarChangeInfo>()
        for (i in 0 until minOf(20, current.length())) {
            val event = current.getJSONObject(i)
            val id = event.optLong("id")
            if (id > 0 && id !in previousIds) {
                changes.add(CalendarChangeInfo(
                    id = id,
                    title = event.optString("omschrijving", ""),
                    startTime = event.optString("start", "")
                ))
            }
        }
        return changes
    }
    
    /**
     * Clear the cached state (force full re-check on next sync)
     */
    fun clearState(context: Context) {
        cachedState = null
        val file = File(context.filesDir, STATE_FILE)
        if (file.exists()) {
            file.delete()
        }
    }
    
    /**
     * Check if notification type is enabled in preferences
     * Reads from file created by frontend
     */
    fun isNotificationEnabled(context: Context, type: String): Boolean {
        // First try SharedPreferences (fallback)
        val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        if (!prefs.contains("initialized")) {
            // Try reading from frontend's localStorage file
            try {
                val prefsFile = File(context.filesDir, "notification_prefs.json")
                if (prefsFile.exists()) {
                    val content = prefsFile.readText()
                    val json = JSONObject(content)
                    return when (type) {
                        "messages" -> json.optBoolean("notifyMessages", true)
                        "grades" -> json.optBoolean("notifyGrades", true)
                        "deadlines" -> json.optBoolean("notifyDeadlines", true)
                        "calendar" -> json.optBoolean("notifyCalendar", true)
                        else -> true
                    }
                }
            } catch (e: Exception) {
                // Ignore, use defaults
            }
        }
        
        return when (type) {
            "messages" -> prefs.getBoolean("notifyMessages", true)
            "grades" -> prefs.getBoolean("notifyGrades", true)
            "deadlines" -> prefs.getBoolean("notifyDeadlines", true)
            "calendar" -> prefs.getBoolean("notifyCalendar", true)
            else -> true
        }
    }
    
    /**
     * Set notification preference (also called from frontend)
     */
    fun setNotificationEnabled(context: Context, type: String, enabled: Boolean) {
        val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("notify${type.replaceFirstChar { it.uppercase() }}", enabled).apply()
    }
    
    /**
     * Write preferences from frontend to a file for Android to read
     */
    fun writePreferencesFromFrontend(context: Context, prefs: JSONObject) {
        try {
            val file = File(context.filesDir, "notification_prefs.json")
            file.writeText(prefs.toString())
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}