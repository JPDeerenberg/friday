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

    // Declare the native method
    private external fun runSync(dataDir: String): String

    companion object {
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "SyncService starting...")
        
        // Start as foreground service
        val notification = createNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        
        // Setup scheduler if not already running
        if (scheduler == null) {
            scheduler = Executors.newSingleThreadScheduledExecutor()
            // Run every 15 minutes
            scheduler?.scheduleAtFixedRate({
                performSync()
            }, 0, 15, TimeUnit.MINUTES)
        }
        
        // Keep service alive if killed
        return START_STICKY
    }

    private fun performSync() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Friday::SyncWakeLock")
        
        try {
            wakeLock?.acquire(10 * 60 * 1000L /*10 minutes max*/)
            Log.d(TAG, "Performing background sync...")
            
            val dataDir = filesDir.absolutePath
            val resultString = try {
                runSync(dataDir)
            } catch (e: Exception) {
                Log.e(TAG, "Native runSync crashed", e)
                "ERROR"
            }

            Log.d(TAG, "Sync result: ${if (resultString.length > 50) resultString.substring(0, 50) + "..." else resultString}")
            
            if (resultString != "ERROR" && !resultString.startsWith("AUTH_ERROR")) {
                processSyncResult(resultString)
            } else {
                Log.w(TAG, "Sync failed or requires auth: $resultString")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error during sync task", e)
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
            return
        }
        
        try {
            val syncData = JSONObject(resultString)
            
            val messages = syncData.optJSONArray("messages") ?: JSONArray()
            val grades = syncData.optJSONArray("grades") ?: JSONArray()
            val assignments = syncData.optJSONArray("assignments") ?: JSONArray()
            val calendar = syncData.optJSONArray("calendar") ?: JSONArray()
            
            val changes = SyncStateManager.detectChanges(
                this,
                messages,
                grades,
                assignments,
                calendar
            )
            
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
        // Reuse logic from SyncWorker or just implement here
        // For simplicity and consistency, I'll copy the logic from SyncWorker.kt
        
        // New Messages
        if (changes.newMessages.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "messages")) {
            val count = changes.newMessages.size
            val firstMsg = changes.newMessages.first()
            val title = if (count == 1) "Nieuw bericht" else "$count nieuwe berichten"
            val message = if (count == 1) "${firstMsg.senderName}: ${firstMsg.subject}" else "Van: ${firstMsg.senderName} en ${count - 1} andere(n)"
            NotificationHelper.showMessageNotification(this, title, message, firstMsg.senderName)
        }
        
        // New Grades
        if (changes.newGrades.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "grades")) {
            val count = changes.newGrades.size
            val firstGrade = changes.newGrades.first()
            val title = if (count == 1) "Nieuw cijfer" else "$count nieuwe cijfers"
            val message = if (count == 1) "${firstGrade.courseName}: ${firstGrade.grade}" else "Laatste: ${firstGrade.courseName} (${firstGrade.grade})"
            NotificationHelper.showGradeNotification(this, title, message, firstGrade.id.toString())
        }
        
        // Deadlines
        if (changes.upcomingDeadlines.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "deadlines")) {
            val deadline = changes.upcomingDeadlines.first()
            NotificationHelper.showDeadlineNotification(this, "Deadline nabij", deadline.title, deadline.id.toString())
        }
        
        // Calendar
        if (changes.calendarChanges.isNotEmpty() && SyncStateManager.isNotificationEnabled(this, "calendar")) {
            val count = changes.calendarChanges.size
            val firstEvent = changes.calendarChanges.first()
            val title = if (count == 1) "Nieuwe afspraak" else "$count nieuwe afspraken"
            val message = if (count == 1) firstEvent.title else "${firstEvent.title} en ${count - 1} andere(n)"
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

    private fun createNotification(): Notification {
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Friday Agenda Monitoring")
            .setContentText("Checking for updates in background...")
            .setSmallIcon(com.joris.friday.R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "SyncService destroyed")
        scheduler?.shutdown()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
