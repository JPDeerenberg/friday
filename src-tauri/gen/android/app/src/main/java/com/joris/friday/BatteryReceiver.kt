package com.joris.friday

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.Log

class BatteryReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "FridayBattery"
        const val PREF_NORMAL_INTERVAL = "sync_interval_minutes"
        const val PREF_LOW_BATTERY_INTERVAL = "sync_interval_low_battery_minutes"
        const val PREF_IN_DOZE = "in_doze_mode"
        const val PREF_LOW_BATTERY = "in_low_battery_mode"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        Log.d(TAG, "Received: $action")

        when (action) {
            Intent.ACTION_BATTERY_CHANGED -> handleBatteryChanged(context, intent)
            Intent.ACTION_DEVICE_STORAGE_LOW -> handleStorageLow(context)
            Intent.ACTION_DEVICE_STORAGE_OK -> handleStorageOk(context)
        }
    }

    private fun handleBatteryChanged(context: Context, intent: Intent) {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        val batteryPct = (level / scale.toFloat()) * 100
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING || 
                        status == BatteryManager.BATTERY_STATUS_FULL
        
        // Check for low battery (treat < 20% as low)
        val isLowBattery = batteryPct < 20

        Log.d(TAG, "Battery: ${batteryPct.toInt()}% (charging: $isCharging, low: $isLowBattery)")

        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val isInDozeMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            powerManager.isDeviceIdleMode
        } else {
            false
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            Log.d(TAG, "Doze mode: $isInDozeMode")
        }

        val prefs = context.getSharedPreferences("friday_prefs", Context.MODE_PRIVATE)
        val wasInDoze = prefs.getBoolean(PREF_IN_DOZE, false)
        val wasLowBattery = prefs.getBoolean(PREF_LOW_BATTERY, false)

        // Only adjust sync interval if power state changed
        if (isInDozeMode != wasInDoze || isLowBattery != wasLowBattery) {
            Log.d(TAG, "Power state changed: doze=$wasInDoze->$isInDozeMode, lowBat=$wasLowBattery->$isLowBattery")
            
            // Save new state
            prefs.edit().apply {
                putBoolean(PREF_IN_DOZE, isInDozeMode)
                putBoolean(PREF_LOW_BATTERY, isLowBattery)
                apply()
            }

            // Adjust sync interval based on power state
            val newIntervalSeconds = when {
                isInDozeMode -> 600L  // 10 minutes in Doze mode
                isLowBattery -> 300L  // 5 minutes in low battery
                else -> 300L          // 5 minutes normal (default)
            }

            // Update SyncService to use new interval
            val syncIntent = Intent(context, SyncService::class.java).apply {
                action = SyncService.ACTION_SET_INTERVAL
                putExtra(SyncService.EXTRA_INTERVAL_SECONDS, newIntervalSeconds)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(syncIntent)
            } else {
                context.startService(syncIntent)
            }
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
        
        // Resume sync service
        val syncIntent = Intent(context, SyncService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(syncIntent)
        } else {
            context.startService(syncIntent)
        }
    }
}
