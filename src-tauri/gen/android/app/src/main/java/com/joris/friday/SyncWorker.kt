package com.joris.friday

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.File

class SyncWorker(appContext: Context, workerParams: WorkerParameters) :
    CoroutineWorker(appContext, workerParams) {

    // Declare the native method
    private external fun runSync(dataDir: String): String

    init {
        // We load the Tauri library. For Friday it's libfriday_lib.so
        try {
            System.loadLibrary("friday_lib")
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override suspend fun doWork(): Result {
        val dataDir = applicationContext.filesDir.absolutePath
        val resultString = try {
            runSync(dataDir)
        } catch (e: Exception) {
            e.printStackTrace()
            "ERROR"
        }

        // Based on the string we get back from Rust, we can trigger notifications.
        if (resultString == "SYNC_SUCCESS") {
            showNotification(applicationContext, "Friday Sync", "Background sync completed successfully")
        } else if (resultString != "NO_TOKENS" && resultString != "ERROR") {
            showNotification(applicationContext, "Friday Sync Info", resultString)
        }

        return Result.success()
    }

    companion object {
        @JvmStatic
        fun showNotification(context: Context, title: String, message: String) {
            val channelId = "friday_sync_channel"
            val notificationManager =
                context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    channelId,
                    "Background Sync",
                    NotificationManager.IMPORTANCE_DEFAULT
                )
                notificationManager.createNotificationChannel(channel)
            }

            // Intent to open the app
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            val pendingIntent: PendingIntent = PendingIntent.getActivity(
                context, 0, intent, PendingIntent.FLAG_IMMUTABLE
            )

            try {
                val builder = NotificationCompat.Builder(context, channelId)
                    .setSmallIcon(android.R.drawable.ic_popup_sync) 
                    .setContentTitle(title)
                    .setContentText(message)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true)

                notificationManager.notify(1001, builder.build())
            } catch (e: SecurityException) {
                e.printStackTrace()
            }
        }
    }
}
