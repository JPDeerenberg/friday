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

    // Initialize ndk-context so the Rust keyring store can access the app context.
    // tao's glue usually does this on Activity creation, but behavior varies across
    // Tauri versions — ensure it explicitly (guarded inside Rust, safe to repeat).
    private external fun initNdkContext(context: Context)

    companion object {
        const val PREF_SYNC_INTERVAL = "sync_interval_minutes"
        const val PERIODIC_SYNC_WORK = "FridayPeriodicSync"
        const val MIN_SYNC_INTERVAL_MINUTES = 15L
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        initNdkContext(this.applicationContext)

        // Schedule the periodic sync via WorkManager. WorkManager is the sole sync
        // driver — it is OS-managed and survives process kills, Doze mode, and reboots.
        // 15 minutes is the minimum interval WorkManager allows.
        val prefs = getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        val intervalMinutes = prefs.getLong(PREF_SYNC_INTERVAL, MIN_SYNC_INTERVAL_MINUTES)
            .coerceAtLeast(MIN_SYNC_INTERVAL_MINUTES)
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val periodicSync = PeriodicWorkRequestBuilder<SyncWorker>(intervalMinutes, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            PERIODIC_SYNC_WORK,
            ExistingPeriodicWorkPolicy.UPDATE,
            periodicSync
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
   * Update the periodic sync interval via WorkManager.
   * intervalSeconds: minimum 900 (15 min WorkManager floor), maximum 86400.
   */
  fun setSyncInterval(intervalSeconds: Long) {
    val clamped = intervalSeconds.coerceIn(900L, 86400L)
    val minutes = clamped / 60L
    getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        .edit().putLong(PREF_SYNC_INTERVAL, minutes).apply()
    val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
    val periodicSync = PeriodicWorkRequestBuilder<SyncWorker>(minutes, TimeUnit.MINUTES)
        .setConstraints(constraints)
        .build()
    WorkManager.getInstance(this).enqueueUniquePeriodicWork(
        PERIODIC_SYNC_WORK,
        ExistingPeriodicWorkPolicy.UPDATE,
        periodicSync
    )
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
