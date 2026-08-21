package com.joris.friday

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * BroadcastReceiver that drives the precise background-sync alarm chain.
 *
 * WorkManager's PeriodicWorkRequest interval is only a *minimum* — under Doze,
 * App Standby Buckets and OEM battery managers the OS may defer periodic work by
 * hours. To get syncs at (close to) the user-configured interval we instead arm a
 * self-rescheduling AlarmManager chain:
 *
 *   1. When an alarm fires, this receiver enqueues a OneTimeWorkRequest<SyncWorker>
 *      via WorkManager, keeping WorkManager's retry/constraint guarantees for the
 *      actual sync execution.
 *   2. It immediately re-arms the next alarm at `now + intervalMinutes` using
 *      AlarmManager.setExactAndAllowWhileIdle() (same pattern as DndScheduler),
 *      which fires reliably even in Doze mode.
 *
 * The chain is armed from MainActivity (on create and on interval change) and
 * re-armed on reboot via BootReceiver. A slow hourly WorkManager periodic job is
 * kept only as a battery-friendly backstop in case this exact-alarm chain is ever
 * cancelled.
 */
class SyncAlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_SYNC_ALARM) {
            Log.w(TAG, "Unknown action: ${intent.action}")
            return
        }

        Log.d(TAG, "Sync alarm fired — enqueuing sync worker")

        // 1. Enqueue a one-shot sync via WorkManager so the actual execution still
        // gets retry/constraint guarantees and runs off the main thread.
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val workRequest = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints)
            .setInputData(SyncWorker.remoteInput(context))
            .build()
        WorkManager.getInstance(context).enqueue(workRequest)

        // 2. Re-arm the chain for the next run.
        scheduleNext(context)
    }

    companion object {
        const val TAG = "FridaySyncAlarm"
        const val ACTION_SYNC_ALARM = "com.joris.friday.SYNC_ALARM"
        const val REQUEST_CODE = 50001

        /**
         * Arm (or re-arm) the next sync alarm at `now + intervalMinutes`, reading
         * the configured interval from SharedPreferences.
         *
         * On Android 12+ we first check canScheduleExactAlarms() and fall back to
         * setAndAllowWhileIdle() (inexact) if exact-alarm access is not granted —
         * we do not prompt for SCHEDULE_EXACT_ALARM beyond what's declared.
         */
        @JvmStatic
        fun scheduleNext(context: Context) {
            val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
            val intervalMinutes = prefs.getLong(MainActivity.PREF_SYNC_INTERVAL, MainActivity.MIN_SYNC_INTERVAL_MINUTES)
                .coerceAtLeast(MainActivity.MIN_SYNC_INTERVAL_MINUTES)
            val triggerAtMs = System.currentTimeMillis() + intervalMinutes * 60_000L

            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pendingIntent = createPendingIntent(context)

            val canScheduleExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                alarmManager.canScheduleExactAlarms()

            if (canScheduleExact) {
                try {
                    alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
                } catch (e: SecurityException) {
                    // Permission revoked between the check and this call — fall back to inexact.
                    Log.w(TAG, "SecurityException scheduling exact sync alarm, falling back to inexact", e)
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
                }
            } else {
                Log.w(TAG, "Cannot schedule exact alarms — using inexact setAndAllowWhileIdle")
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            }

            Log.d(TAG, "Sync alarm armed for ${formatTime(triggerAtMs)} (interval $intervalMinutes min)")
        }

        /**
         * Cancel the pending sync alarm (used when the chain is being reset).
         */
        @JvmStatic
        fun cancel(context: Context) {
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pendingIntent = createPendingIntent(context)
            alarmManager.cancel(pendingIntent)
            pendingIntent.cancel()
        }

        private fun createPendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, SyncAlarmReceiver::class.java).apply {
                action = ACTION_SYNC_ALARM
            }
            return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun formatTime(ms: Long): String {
            return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(ms))
        }
    }
}
