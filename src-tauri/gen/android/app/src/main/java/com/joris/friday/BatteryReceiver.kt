package com.joris.friday

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BatteryReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "FridayBattery"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.d(TAG, "Received: $action")

        when (action) {
            Intent.ACTION_DEVICE_STORAGE_LOW -> handleStorageLow(context)
            Intent.ACTION_DEVICE_STORAGE_OK -> handleStorageOk(context)
        }
    }

    private fun handleStorageLow(context: Context) {
        Log.w(TAG, "Storage low - pausing sync")
        val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("sync_paused_storage", true).apply()
    }

    private fun handleStorageOk(context: Context) {
        Log.d(TAG, "Storage ok - resuming sync")
        val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("sync_paused_storage", false).apply()
    }
}
