package com.joris.friday

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.Manifest
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
    // State variable to track if we've asked for permissions this session
    private var hasPromptedPermissions = false
    private var hasPromptedBatteryOpt = false

    // tao/Tauri initializes ndk-context asynchronously, so this intentionally races
    // that setup. Rust must make this call idempotent and non-panicking.
    private external fun initNdkContext(context: Context)

    companion object {
        const val PREF_SYNC_INTERVAL = "sync_interval_minutes"
        const val PERIODIC_SYNC_WORK = "FridayPeriodicSync"
        const val MIN_SYNC_INTERVAL_MINUTES = 15L

        // WorkManager's periodic interval is only a minimum the OS may defer for hours,
        // so the primary cadence is driven by the exact-alarm chain (SyncAlarmReceiver).
        // This slow job is kept only as a battery-friendly backstop in case that chain
        // is ever cancelled; SyncWorker guards against concurrent runs.
        const val BACKSTOP_INTERVAL_MINUTES = 60L
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        initNdkContext(this.applicationContext)

        // Primary sync driver: a self-rescheduling AlarmManager exact-alarm chain.
        // Each alarm firing enqueues a one-shot SyncWorker via WorkManager (keeping
        // its retry/constraint guarantees) and re-arms the next alarm at now + interval.
        // This fires reliably at the configured interval even under Doze/App Standby,
        // unlike WorkManager's periodic job which the OS may defer by hours.
        SyncAlarmReceiver.scheduleNext(this)

        // Battery-friendly backstop: a slow periodic job in case the exact-alarm chain
        // is ever cancelled. SyncWorker serializes execution, so overlap is safe.
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val backstop = PeriodicWorkRequestBuilder<SyncWorker>(BACKSTOP_INTERVAL_MINUTES, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            PERIODIC_SYNC_WORK,
            ExistingPeriodicWorkPolicy.UPDATE,
            backstop
        )
    }
  
    override fun onResume() {
        super.onResume()
        // Request notification permissions for Android 13+ in onResume to ensure Activity is visible
        if (!hasPromptedPermissions && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            hasPromptedPermissions = true
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        // Request battery optimisation exemption once per session.
        // Without this, Android Doze mode may delay WorkManager runs and block network
        // access in the background, making notifications unreliable on most devices.
        if (!hasPromptedBatteryOpt && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            hasPromptedBatteryOpt = true
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    // Some OEMs don't support this intent; ignore gracefully.
                }
            }
        }

        // NOTE: Do NOT overwrite stored notification preferences here.
        // They are set by the frontend via Tauri's sync_notification_preferences command.

        // NOTE: Do NOT trigger an extra sync on resume — WorkManager already guarantees
        // the periodic job runs; resuming the app should not enqueue additional sync work.
    }

  /**
   * Manually trigger a sync via WorkManager (one-shot)
   */
  fun triggerManualSync() {
    val workRequest = androidx.work.OneTimeWorkRequestBuilder<SyncWorker>()
        .build()
    WorkManager.getInstance(this).enqueue(workRequest)
  }

  /**
   * Update the background sync interval.
   * intervalSeconds: minimum 900 (15 min), maximum 86400.
   * Persists the value and re-arms the exact-alarm sync chain with the new cadence.
   */
  fun setSyncInterval(intervalSeconds: Long) {
    val clamped = intervalSeconds.coerceIn(900L, 86400L)
    val minutes = clamped / 60L
    getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        .edit().putLong(PREF_SYNC_INTERVAL, minutes).apply()

    // Re-arm the precise sync alarm chain with the new interval (scheduleNext with
    // FLAG_UPDATE_CURRENT replaces any previously-armed alarm).
    SyncAlarmReceiver.scheduleNext(this)
  }

  /**
   * Get the current sync interval in seconds.
   */
  fun getSyncInterval(): Long {
    val prefs = getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
    val minutes = prefs.getLong(PREF_SYNC_INTERVAL, MIN_SYNC_INTERVAL_MINUTES)
    return (minutes * 60L).coerceIn(900L, 86400L)
  }

  fun getNightSleepConfig(): String {
      val prefs = getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
      val enabled = prefs.getBoolean("disableSyncAtNight", false)
      val startHour = prefs.getInt("disableSyncAtNightStart", 22)
      val endHour = prefs.getInt("disableSyncAtNightEnd", 7)
      return "{\"enabled\":$enabled,\"startHour\":$startHour,\"endHour\":$endHour}"
  }

  fun setNightSleepConfig(enabled: Boolean, startHour: Int, endHour: Int) {
      val prefs = getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
      prefs.edit().apply {
          putBoolean("disableSyncAtNight", enabled)
          putInt("disableSyncAtNightStart", startHour)
          putInt("disableSyncAtNightEnd", endHour)
          apply()
      }
  }

  fun getDisableAllNotifications(): Boolean {
      val prefs = getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
      return prefs.getBoolean("disableAllNotifications", false)
  }

  fun setDisableAllNotifications(enabled: Boolean) {
      val prefs = getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
      prefs.edit().apply {
          putBoolean("disableAllNotifications", enabled)
          apply()
      }
  }
}
