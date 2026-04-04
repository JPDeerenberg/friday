package com.joris.friday

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
    // State variable to track if we've asked for permissions this session
    private var hasPromptedPermissions = false

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

        // Ensure notification preferences are initialized for background sync
        SyncStateManager.syncPreferencesFromFrontend(
            this,
            true, true, true, true, false
        )
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
