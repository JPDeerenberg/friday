package com.joris.friday

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class SyncWorker(appContext: Context, workerParams: WorkerParameters) :
    CoroutineWorker(appContext, workerParams) {

    private val TAG = "FridaySyncWorker"

    // Declare the native method
    private external fun runSync(dataDir: String): String

    init {
        try {
            System.loadLibrary("friday_lib")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load friday_lib", e)
        }
    }
    override suspend fun doWork(): Result {
        // Tauri saves tokens.json to the PARENT of filesDir (app_data_dir)
        val dataDir = applicationContext.filesDir.parentFile?.absolutePath 
            ?: applicationContext.filesDir.absolutePath
        Log.d(TAG, "Starting background sync... dataDir=$dataDir")
        
        val resultString = try {
            runSync(dataDir)
        } catch (e: Exception) {
            Log.e(TAG, "Native runSync crashed", e)
            "ERROR"
        }

        Log.d(TAG, "Sync result: ${if (resultString.length > 50 && !resultString.startsWith("ERROR") && !resultString.startsWith("AUTH_ERROR")) resultString.substring(0, 50) + "..." else resultString}")

        // Process the sync result and detect changes
        if (resultString == "ERROR" || resultString.startsWith("AUTH_ERROR")) {
            Log.w(TAG, "Sync failed with error: $resultString. Retrying later...")
            return Result.retry()
        }

        processSyncResult(resultString)

        return Result.success()
    }
    
    private fun processSyncResult(resultString: String) {
        // Skip if no tokens or critical error
        if (resultString == "NO_TOKENS" || resultString == "ERROR" || 
            resultString.startsWith("AUTH_ERROR") || resultString.startsWith("INVALID") ||
            resultString == "NO_PERSON_ID") {
            return
        }
        
        try {
            val syncData = JSONObject(resultString)
            
            // Extract data arrays
            val messages = syncData.optJSONArray("messages") ?: JSONArray()
            val grades = syncData.optJSONArray("grades") ?: JSONArray()
            val assignments = syncData.optJSONArray("assignments") ?: JSONArray()
            val calendar = syncData.optJSONArray("calendar") ?: JSONArray()
            
            // Detect changes using SyncStateManager
            val changes = SyncStateManager.detectChanges(
                applicationContext,
                messages,
                grades,
                assignments,
                calendar
            )
            
            // Send notifications for detected changes
            sendChangeNotifications(changes)
            
            // Handle Automatic Do Not Disturb
            if (SyncStateManager.isNotificationEnabled(applicationContext, "autoDnd")) {
                val isAnyActive = SyncStateManager.isAnyLessonActive(calendar)
                NotificationHelper.updateDndStatus(applicationContext, isAnyActive)
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Failed to process sync result: $resultString", e)
            e.printStackTrace()
        }
    }
    
    private fun sendChangeNotifications(changes: SyncStateManager.SyncChanges) {
        val context = applicationContext
        
        val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        if (prefs.getBoolean("disableAllNotifications", false)) {
            Log.d("FridaySyncWorker", "All notifications are disabled")
            return
        }

        // New Messages Notification
        if (changes.newMessages.isNotEmpty() && 
            SyncStateManager.isNotificationEnabled(context, "messages")) {
            val count = changes.newMessages.size
            val firstMsg = changes.newMessages.first()
            val title = if (count == 1) "Nieuw bericht" else "$count nieuwe berichten"
            val message = if (count == 1) {
                "${firstMsg.senderName}: ${firstMsg.subject}"
            } else {
                "Van: ${firstMsg.senderName} en ${count - 1} andere(n)"
            }
            NotificationHelper.showMessageNotification(
                context, title, message, firstMsg.senderName
            )
        }
        
        // New Grades Notification
        if (changes.newGrades.isNotEmpty() && 
            SyncStateManager.isNotificationEnabled(context, "grades")) {
            val count = changes.newGrades.size
            val firstGrade = changes.newGrades.first()
            val title = if (count == 1) "Nieuw cijfer" else "$count nieuwe cijfers"
            val message = if (count == 1) {
                "${firstGrade.courseName}: ${firstGrade.grade}"
            } else {
                "Laatste: ${firstGrade.courseName} (${firstGrade.grade})"
            }
            NotificationHelper.showGradeNotification(
                context, title, message, firstGrade.id.toString()
            )
        }
        
        // Deadline Reminders
        if (changes.upcomingDeadlines.isNotEmpty() && 
            SyncStateManager.isNotificationEnabled(context, "deadlines")) {
            val deadline = changes.upcomingDeadlines.first()
            val timeLeft = formatTimeUntil(deadline.deadline)
            NotificationHelper.showDeadlineNotification(
                context, 
                "Deadline over ${timeLeft}", 
                deadline.title,
                deadline.id.toString()
            )
        }
        
        // Calendar Changes
        if (changes.calendarChanges.isNotEmpty() && 
            SyncStateManager.isNotificationEnabled(context, "calendar")) {
            val count = changes.calendarChanges.size
            val firstEvent = changes.calendarChanges.first()
            val title = if (count == 1) "Nieuwe afspraak" else "$count nieuwe afspraken"
            val message = if (count == 1) {
                firstEvent.title
            } else {
                "${firstEvent.title} en ${count - 1} andere(n)"
            }
            NotificationHelper.showCalendarNotification(
                context, title, message, firstEvent.id.toString()
            )
        }
    }
    
    private fun formatTimeUntil(deadline: String): String {
        try {
            val deadlineFormat = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
            val deadlineTime = deadlineFormat.parse(deadline)?.time ?: return "binnenkort"
            val now = System.currentTimeMillis()
            val diffMs = deadlineTime - now
            val diffHours = diffMs / (1000 * 60 * 60)
            
            return when {
                diffHours < 1 -> "minder dan 1 uur"
                diffHours < 24 -> "${diffHours.toInt()} uur"
                else -> "${(diffHours / 24).toInt()} dag(en)"
            }
        } catch (e: Exception) {
            return "binnenkort"
        }
    }

    companion object {
        @JvmStatic
        fun showNotification(context: Context, title: String, message: String) {
            NotificationHelper.showTestNotification(context, title, message)
        }
        
        @JvmStatic
        fun showNotificationWithType(context: Context, type: Int, title: String, message: String, extra: String?) {
            NotificationHelper.showNotification(context, type, title, message, extra)
        }
    }
}
