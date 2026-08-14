package com.joris.friday

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.d("FridayBootReceiver", "Device booted")
            // WorkManager re-registers its own boot receiver and resumes periodic
            // work after reboot — no manual restart needed.

            // Re-schedule DND alarms from cached calendar data
            // (AlarmManager alarms are lost on reboot)
            try {
                DndScheduler.rescheduleFromCache(context)
                Log.d("FridayBootReceiver", "DND alarms rescheduled from cache")
            } catch (e: Exception) {
                Log.e("FridayBootReceiver", "Failed to reschedule DND alarms", e)
            }
        }
    }
}
