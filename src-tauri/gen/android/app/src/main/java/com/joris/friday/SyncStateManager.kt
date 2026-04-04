package com.joris.friday

import android.content.Context
import android.util.Log
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
        val hasPreviousState = previousState.length() > 0
        
        Log.d("SyncStateManager", "detectChanges: hasPreviousState=$hasPreviousState, currentMessages=${currentMessages.length()}")
        
        val prevMessages = previousState.optJSONArray("messages")
        val prevGrades = previousState.optJSONArray("grades")
        val prevAssignments = previousState.optJSONArray("assignments")
        val prevCalendar = previousState.optJSONArray("calendar")
        
        Log.d("SyncStateManager", "detectChanges: prevMessages=${prevMessages?.length() ?: "null"}, prevGrades=${prevGrades?.length() ?: "null"}")
        
        val newMessages = detectNewMessages(prevMessages, currentMessages)
        val newGrades = detectNewGrades(prevGrades, currentGrades)
        val upcomingDeadlines = detectAssignmentChanges(prevAssignments, currentAssignments)
        val calendarChanges = detectCalendarChanges(prevCalendar, currentCalendar)
        
        // Save new state
        val newState = JSONObject().apply {
            put("messages", currentMessages)
            put("grades", currentGrades)
            put("assignments", currentAssignments)
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
        // When previous is null (first sync), save state but don't fire notifications
        // so we don't spam the user on first run. Return empty for first sync.
        if (previous == null) {
            Log.d("SyncStateManager", "detectNewMessages: first sync, no previous state - skipping notifications")
            return emptyList()
        }
        
        val previousIds = mutableSetOf<Long>()
        for (i in 0 until previous.length()) {
            previous.getJSONObject(i).optLong("id").takeIf { id -> id > 0 }?.let { id -> previousIds.add(id) }
        }
        
        Log.d("SyncStateManager", "detectNewMessages: previousIds count=${previousIds.size}, current count=${current.length()}")
        if (previousIds.isNotEmpty()) {
            Log.d("SyncStateManager", "detectNewMessages: previousIds sample=${previousIds.take(3)}")
        }
        
        val newMessages = mutableListOf<MessageInfo>()
        for (i in 0 until minOf(10, current.length())) { // Check last 10 messages
            val msg = current.getJSONObject(i)
            val id = msg.optLong("id")
            Log.d("SyncStateManager", "detectNewMessages: checking msg id=$id, inPrevious=${id in previousIds}")
            if (id > 0 && id !in previousIds) {
                newMessages.add(MessageInfo(
                    id = id,
                    subject = msg.optString("onderwerp", ""),
                    senderName = extractSenderName(msg),
                    timestamp = msg.optString("verzondenOp", msg.optString("datum", ""))
                ))
            }
        }
        Log.d("SyncStateManager", "detectNewMessages: found ${newMessages.size} new messages")
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
        // When previous is null (first sync), save state but don't fire notifications
        if (previous == null) return emptyList()
        
        val previousIds = mutableSetOf<Long>()
        for (i in 0 until previous.length()) {
            previous.getJSONObject(i).optLong("CijferId").takeIf { id -> id > 0 }?.let { id -> previousIds.add(id) }
        }
        
        val newGrades = mutableListOf<GradeInfo>()
        for (i in 0 until current.length()) {
            val grade = current.getJSONObject(i)
            val id = grade.optLong("CijferId")
            if (id > 0 && id !in previousIds) {
                newGrades.add(GradeInfo(
                    id = id,
                    description = grade.optJSONObject("CijferKolom")?.optString("KolomOmschrijving") ?: grade.optString("omschrijving", ""),
                    grade = grade.optString("CijferStr", ""),
                    courseName = extractCourseName(grade)
                ))
            }
        }
        return newGrades
    }
    
    private fun extractCourseName(grade: JSONObject): String {
        val vak = grade.optJSONObject("Vak")
        if (vak != null) {
            return vak.optString("Omschrijving", vak.optString("Afkorting", ""))
        }
        return grade.optString("vakNaam", "")
    }
    
    private fun detectAssignmentChanges(previous: JSONArray?, current: JSONArray): List<DeadlineInfo> {
        if (current.length() == 0) return emptyList()
        // When previous is null (first sync), save state but don't fire notifications
        if (previous == null) return emptyList()
        val changes = mutableListOf<DeadlineInfo>()
        val now = System.currentTimeMillis()
        val oneDayMs = 24 * 60 * 60 * 1000L
        
        val previousIds = mutableSetOf<Long>()
        for (i in 0 until previous.length()) {
            previous.getJSONObject(i).optLong("Id").takeIf { id -> id > 0 }?.let { id -> previousIds.add(id) }
        }
        
        for (i in 0 until current.length()) {
            val assignment = current.getJSONObject(i)
            val id = assignment.optLong("Id")
            val deadline = assignment.optString("InleverenVoor", "")
            
            // 1. Detect New Assignments
            if (id > 0 && id !in previousIds) {
                changes.add(DeadlineInfo(
                    id = id,
                    title = "Nieuwe opdracht: " + assignment.optString("Titel", "Opdracht"),
                    deadline = deadline
                ))
                continue // Don't add twice if it's also a near deadline
            }
            
            // 2. Detect Upcoming Deadlines (within 24h)
            if (deadline.isNotEmpty()) {
                try {
                    val deadlineMs = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
                        .parse(deadline)?.time ?: continue
                    
                    if (deadlineMs > now && deadlineMs <= now + oneDayMs) {
                        changes.add(DeadlineInfo(
                            id = id,
                            title = "Deadline nabij: " + assignment.optString("Titel", "Opdracht"),
                            deadline = deadline
                        ))
                    }
                } catch (e: Exception) {
                    // Skip malformed dates
                }
            }
        }
        return changes
    }
    
    private fun detectCalendarChanges(previous: JSONArray?, current: JSONArray): List<CalendarChangeInfo> {
        if (current.length() == 0) return emptyList()
        // When previous is null (first sync), save state but don't fire notifications
        if (previous == null) return emptyList()
        
        val previousIds = mutableSetOf<Long>()
        for (i in 0 until previous.length()) {
            previous.getJSONObject(i).optLong("Id").takeIf { id -> id > 0 }?.let { id -> previousIds.add(id) }
        }
        
        val changes = mutableListOf<CalendarChangeInfo>()
        for (i in 0 until minOf(20, current.length())) {
            val event = current.getJSONObject(i)
            val id = event.optLong("Id")
            if (id > 0 && id !in previousIds) {
                changes.add(CalendarChangeInfo(
                    id = id,
                    title = event.optString("Omschrijving", ""),
                    startTime = event.optString("Start", "")
                ))
            }
        }
        return changes
    }
    
    /**
     * Check if any lesson is currently active in the provided calendar data.
     * A lesson is active if now is between start and einde, and it's not cancelled.
     */
    fun isAnyLessonActive(currentCalendar: JSONArray): Boolean {
        val now = System.currentTimeMillis()
        val dateFormat = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
        
        for (i in 0 until currentCalendar.length()) {
            try {
                val event = currentCalendar.getJSONObject(i)
                val startTime = event.optString("Start", "")
                val endTime = event.optString("Einde", "")
                val status = event.optInt("Status", 0)
                
                // Check if it's a scheduled event (usually type 16, but we'll check status)
                // status 4 and 5 are cancelled.
                if (status == 4 || status == 5) continue
                
                if (startTime.isNotEmpty() && endTime.isNotEmpty()) {
                    val startMs = dateFormat.parse(startTime)?.time ?: continue
                    val endMs = dateFormat.parse(endTime)?.time ?: continue
                    
                    if (now in startMs..endMs) {
                        return true
                    }
                }
            } catch (e: Exception) {
                // Skip malformed dates or objects
            }
        }
        return false
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
                        "autoDnd" -> json.optBoolean("notifyAutoDnd", false)
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
            "autoDnd" -> prefs.getBoolean("notifyAutoDnd", false)
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
    @JvmStatic
    fun writePreferencesFromFrontend(context: Context, prefs: JSONObject) {
        try {
            val file = File(context.filesDir, "notification_prefs.json")
            file.writeText(prefs.toString())
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * Called from Rust JNI to sync notification preferences directly.
     * signature: (Landroid/content/Context;ZZZZ)V
     */
    @JvmStatic
    fun syncPreferencesFromFrontend(
        context: Context,
        notifyMessages: Boolean,
        notifyGrades: Boolean,
        notifyDeadlines: Boolean,
        notifyCalendar: Boolean,
        notifyAutoDnd: Boolean
    ) {
        val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        prefs.edit().apply {
            putBoolean("notifyMessages", notifyMessages)
            putBoolean("notifyGrades", notifyGrades)
            putBoolean("notifyDeadlines", notifyDeadlines)
            putBoolean("notifyCalendar", notifyCalendar)
            putBoolean("notifyAutoDnd", notifyAutoDnd)
            putBoolean("initialized", true)
            apply()
        }
        
        // Also update the JSON file for consistency if needed by other components
        try {
            val json = JSONObject().apply {
                put("notifyMessages", notifyMessages)
                put("notifyGrades", notifyGrades)
                put("notifyDeadlines", notifyDeadlines)
                put("notifyCalendar", notifyCalendar)
                put("notifyAutoDnd", notifyAutoDnd)
            }
            writePreferencesFromFrontend(context, json)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}