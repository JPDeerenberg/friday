package com.joris.friday

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    
    val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build()
    WorkManager.getInstance(this).enqueueUniquePeriodicWork(
        "FridaySync",
        ExistingPeriodicWorkPolicy.KEEP,
        syncRequest
    )
  }
}
