package com.joris.friday

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    
    // Schedule periodic sync every 30 minutes (minimum for WorkManager)
    val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .setRequiresBatteryNotLow(true)
        .build()
    
    val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
        .setConstraints(constraints)
        .build()
    
    WorkManager.getInstance(this).enqueueUniquePeriodicWork(
        "FridaySync",
        ExistingPeriodicWorkPolicy.KEEP,
        syncRequest
    )
  }
  
  /**
   * Manually trigger a sync
   */
  fun triggerManualSync() {
    val workRequest = androidx.work.OneTimeWorkRequestBuilder<SyncWorker>()
        .build()
    WorkManager.getInstance(this).enqueue(workRequest)
  }
}
