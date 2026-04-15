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

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        
        // Start background sync service
        val serviceIntent = Intent(this, SyncService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        // Schedule a guaranteed periodic sync via WorkManager as a backup to SyncService.
        // WorkManager is OS-managed and survives service kills, Doze mode, and reboots.
        // 15 minutes is the minimum interval WorkManager allows.
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val periodicSync = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "FridayPeriodicSync",
            ExistingPeriodicWorkPolicy.KEEP,
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
        // Without this, Android Doze mode will kill the SyncService and block network access
        // in the background, making notifications unreliable on most devices.
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
        // Initialise defaults only on the very first launch (handled in SyncService.onCreate).

        // Ensure the sync service is still running (it may have been killed by the OS).
        val serviceIntent = Intent(this, SyncService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
    }

  /**
   * Manually trigger a sync via WorkManager (one-shot)
   */
  fun triggerManualSync() {
    val workRequest = androidx.work.OneTimeWorkRequestBuilder<SyncWorker>()
        .build()
    WorkManager.getInstance(this).enqueue(workRequest)
    // Also immediately trigger via SyncService if running
    val intent = Intent(this, SyncService::class.java).apply {
        action = SyncService.ACTION_FORCE_SYNC
    }
    startService(intent)
  }

  /**
   * Update the sync interval for the running SyncService.
   * intervalSeconds: minimum 60, maximum 3600
   */
  fun setSyncInterval(intervalSeconds: Long) {
    val clamped = intervalSeconds.coerceIn(60L, 3600L)
    val intent = Intent(this, SyncService::class.java).apply {
        action = SyncService.ACTION_SET_INTERVAL
        putExtra(SyncService.EXTRA_INTERVAL_SECONDS, clamped)
    }
    startService(intent)
  }
}
