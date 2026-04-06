package com.joris.friday

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class SyncService : Service() {

    private val TAG = "FridaySyncService"
    private val NOTIFICATION_ID = 9999
    private val CHANNEL_ID = "friday_sync_service"
    
    private var scheduler: ScheduledExecutorService? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var syncIntervalMinutes: Long = 5L

    // Declare the native method
    private external fun runSync(dataDir: String): String

    companion object {
        const val ACTION_FORCE_SYNC = "com.joris.friday.FORCE_SYNC"
        const val ACTION_SET_INTERVAL = "com.joris.friday.SET_INTERVAL"
        const val EXTRA_INTERVAL_SECONDS = "interval_seconds"
        const val PREF_SYNC_INTERVAL = "sync_interval_minutes"

        init {
            try {
                System.loadLibrary("friday_lib")
            } catch (e: Exception) {
                Log.e("FridaySyncService", "Failed to load friday_lib", e)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "SyncService created")
        createNotificationChannel()
        // Restore saved interval
        val prefs = getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        syncIntervalMinutes = prefs.getLong(PREF_SYNC_INTERVAL, 5L)
        Log.d(TAG, "Sync interval restored: ${syncIntervalMinutes}m")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "SyncService onStartCommand: action=${intent?.action}")

        // Start as foreground service
        val notification = createNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        when (intent?.action) {
            ACTION_FORCE_SYNC -> {
                // Immediately run a sync on a background thread
                Log.d(TAG, "Force sync requested")
                Executors.newSingleThreadExecutor().execute { performSync() }
            }
            ACTION_SET_INTERVAL -> {
                val seconds = intent.getLongExtra(EXTRA_INTERVAL_SECONDS, 300L)
                val minutes = (seconds / 60L).coerceAtLeast(1L)
                Log.d(TAG, "Interval update requested: ${seconds}s -> ${minutes}m")
                syncIntervalMinutes = minutes
                // Persist
                getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
                    .edit().putLong(PREF_SYNC_INTERVAL, minutes).apply()
                // Restart scheduler with new interval
                restartScheduler()
            }
            else -> {
                // Normal start — setup scheduler if not already running
                if (scheduler == null) {
                    startScheduler()
                }
            }
        }

        // Keep service alive if killed
        return START_STICKY
    }

    private fun startScheduler() {
        scheduler = Executors.newSingleThreadScheduledExecutor()
        Log.d(TAG, "Scheduler starting: every ${syncIntervalMinutes} minute(s)")
        scheduler?.scheduleAtFixedRate({
            performSync()
        }, 0, syncIntervalMinutes, TimeUnit.MINUTES)
    }

    private fun restartScheduler() {
        Log.d(TAG, "Restarting scheduler with new interval: ${syncIntervalMinutes}m")
        scheduler?.shutdownNow()
        scheduler = null
        startScheduler()
    }

    private fun performSync() {
        try {
            updateNotification("Syncing now...")
            
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Friday::SyncWakeLock")
            wakeLock?.acquire(10 * 60 * 1000L /*10 minutes max*/)
            
            Log.d(TAG, "=== Starting background sync task ===")
            
            // Tauri saves tokens.json to app_data_dir which is the PARENT of filesDir.
            // filesDir = /data/user/0/com.joris.friday/files
            // app_data_dir = /data/user/0/com.joris.friday  <-- tokens.json is here
            val dataDir = filesDir.parentFile?.absolutePath ?: filesDir.absolutePath
            Log.d(TAG, "Data dir: $dataDir")
            
            val resultString = try {
                runSync(dataDir)
            } catch (e: Exception) {
                Log.e(TAG, "Native runSync crashed", e)
                "ERROR"
            }

            val resultPreview = when {
                resultString.startsWith("ERROR") || resultString.startsWith("AUTH_ERROR") ||
                resultString.contains("NO_TOKENS") || resultString.contains("INVALID_TOKENS") ||
                resultString.contains("NO_PERSON_ID") -> resultString
                resultString.length > 200 -> resultString.substring(0, 200) + "..."
                else -> resultString
            }
            Log.d(TAG, "Sync result preview: $resultPreview")
            
            if (resultString != "ERROR" && !resultString.startsWith("ERROR:") && !resultString.startsWith("AUTH_ERROR:")) {
                processSyncResult(resultString)
                val time = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date())
                updateNotification("Monitoring actief (Laatste sync: $time)")
            } else {
                Log.w(TAG, "Sync failed: $resultString")
                val errorMsg = when {
                    resultString.startsWith("AUTH_ERROR:") -> "Inloggen vereist"
                    resultString.contains("NO_TOKENS") -> "Geen sessie"
                    resultString.contains("FETCH_") -> "Magister fout"
                    resultString.contains("timeout") || resultString.contains("timed out") -> "Time-out"
                    else -> "Contact verloren"
                }
                val time = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date())
                updateNotification("Monitoring actief ($errorMsg @ $time)")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error during sync task", e)
            updateNotification("Monitoring active (Error occurred)")
        } finally {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        }
    }

    private fun processSyncResult(resultString: String) {
        if (resultString == "NO_TOKENS" || resultString == "ERROR" || 
            resultString.startsWith("AUTH_ERROR") || resultString.startsWith("INVALID") ||
            resultString == "NO_PERSON_ID") {
            Log.w(TAG, "processSyncResult: skipping due to error status: $resultString")
            return
        }
        
        try {
            val syncData = JSONObject(resultString)
            
            val messages = syncData.optJSONArray("messages") ?: JSONArray()
            val grades = syncData.optJSONArray("grades") ?: JSONArray()
            val assignments = syncData.optJSONArray("assignments") ?: JSONArray()
            val calendar = syncData.optJSONArray("calendar") ?: JSONArray()
            
            Log.d(TAG, "processSyncResult: messages=${messages.length()}, grades=${grades.length()}, assignments=${assignments.length()}, calendar=${calendar.length()}")
            
            // Log first message id for debugging
            if (messages.length() > 0) {
                val firstMsg = messages.getJSONObject(0)
                Log.d(TAG, "processSyncResult: first message id=${firstMsg.optLong("id")}, subject=${firstMsg.optString("onderwerp")}")
            }
            
            val changes = SyncStateManager.detectChanges(
                this,
                messages,
                grades,
                assignments,
                calendar
            )
            
            Log.d(TAG, "processSyncResult: detected changes - newMessages=${changes.newMessages.size}, newGrades=${changes.newGrades.size}, deadlines=${changes.upcomingDeadlines.size}, calendar=${changes.calendarChanges.size}")
            
            sendChangeNotifications(changes)
            
            if (SyncStateManager.isNotificationEnabled(this, "autoDnd")) {
                val isAnyActive = SyncStateManager.isAnyLessonActive(calendar)
                NotificationHelper.updateDndStatus(this, isAnyActive)
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Failed to process sync result", e)
        }
    }

    private fun sendChangeNotifications(changes: SyncStateManager.SyncChanges) {
        Log.d(TAG, "sendChangeNotifications called")
        
        // New Messages
        if (changes.newMessages.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "messages")) {
            val count = changes.newMessages.size
            val firstMsg = changes.newMessages.first()
            val title = if (count == 1) "Nieuw bericht" else "$count nieuwe berichten"
            val message = if (count == 1) "${firstMsg.senderName}: ${firstMsg.subject}" else "Van: ${firstMsg.senderName} en ${count - 1} andere(n)"
            Log.d(TAG, "Showing message notification: $title - $message")
            NotificationHelper.showMessageNotification(this, title, message, firstMsg.senderName)
        } else {
            if (changes.newMessages.isEmpty()) Log.d(TAG, "No new messages detected")
            else Log.d(TAG, "Message notifications disabled in prefs")
        }
        
        // New Grades
        if (changes.newGrades.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "grades")) {
            val count = changes.newGrades.size
            val firstGrade = changes.newGrades.first()
            val title = if (count == 1) "Nieuw cijfer" else "$count nieuwe cijfers"
            val message = if (count == 1) "${firstGrade.courseName}: ${firstGrade.grade}" else "Laatste: ${firstGrade.courseName} (${firstGrade.grade})"
            Log.d(TAG, "Showing grade notification: $title")
            NotificationHelper.showGradeNotification(this, title, message, firstGrade.id.toString())
        }
        
        // Deadlines
        if (changes.upcomingDeadlines.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "deadlines")) {
            val deadline = changes.upcomingDeadlines.first()
            Log.d(TAG, "Showing deadline notification: ${deadline.title}")
            NotificationHelper.showDeadlineNotification(this, "Deadline nabij", deadline.title, deadline.id.toString())
        }
        
        // Calendar
        if (changes.calendarChanges.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "calendar")) {
            val count = changes.calendarChanges.size
            val firstEvent = changes.calendarChanges.first()
            val title = if (count == 1) "Nieuwe afspraak" else "$count nieuwe afspraken"
            val message = if (count == 1) firstEvent.title else "${firstEvent.title} en ${count - 1} andere(n)"
            Log.d(TAG, "Showing calendar notification: $title")
            NotificationHelper.showCalendarNotification(this, title, message, firstEvent.id.toString())
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val serviceChannel = NotificationChannel(
                CHANNEL_ID,
                "Friday Background Sync",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(serviceChannel)
        }
    }

    private fun createNotification(contentText: String = "Checking for updates in background..."): Notification {
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Friday Agenda Monitoring")
            .setContentText(contentText)
            .setSmallIcon(com.joris.friday.R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(text: String) {
        val notification = createNotification(text)
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "SyncService destroyed")
        scheduler?.shutdown()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
