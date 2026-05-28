package com.joris.friday

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver that handles DND alarm intents from AlarmManager.
 *
 * Three actions:
 *  - ACTION_DND_ON:         Enable DND (Priority mode) and record that Friday set it
 *  - ACTION_DND_OFF:        Disable DND only if Friday was the one that turned it on
 *  - ACTION_DND_SAFETY_OFF: Force-disable DND regardless (failsafe after 2 hours)
 */
class DndReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_DND_ON = "com.joris.friday.DND_ON"
        const val ACTION_DND_OFF = "com.joris.friday.DND_OFF"
        const val ACTION_DND_SAFETY_OFF = "com.joris.friday.DND_SAFETY_OFF"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Double-check that auto-DND is still enabled in preferences
        if (!SyncStateManager.isNotificationEnabled(context, "autoDnd")) {
            Log.d("FridayDndReceiver", "Auto DND is disabled — ignoring alarm (${intent.action})")
            return
        }

        if (!NotificationHelper.hasDndAccess(context)) {
            Log.w("FridayDndReceiver", "DND access not granted — cannot modify DND")
            return
        }

        when (intent.action) {
            ACTION_DND_ON -> {
                Log.d("FridayDndReceiver", "⏰ DND ON alarm fired — enabling Do Not Disturb")
                NotificationHelper.updateDndStatus(context, true)
                DndScheduler.setFridayDndFlag(context, true)
            }

            ACTION_DND_OFF -> {
                if (DndScheduler.didFridaySetDnd(context)) {
                    Log.d("FridayDndReceiver", "⏰ DND OFF alarm fired — disabling Do Not Disturb (Friday set it)")
                    NotificationHelper.updateDndStatus(context, false)
                    DndScheduler.setFridayDndFlag(context, false)
                } else {
                    Log.d("FridayDndReceiver", "⏰ DND OFF alarm fired — skipping: DND was not set by Friday (user set it manually)")
                }
            }

            ACTION_DND_SAFETY_OFF -> {
                // Safety timeout: always turn off regardless of who set it
                // This prevents DND from being stuck on indefinitely due to a bug
                if (DndScheduler.didFridaySetDnd(context)) {
                    Log.w("FridayDndReceiver", "⚠️ SAFETY TIMEOUT — forcing DND off (was set by Friday)")
                    NotificationHelper.updateDndStatus(context, false)
                    DndScheduler.setFridayDndFlag(context, false)
                } else {
                    Log.d("FridayDndReceiver", "Safety timeout fired but DND not set by Friday — ignoring")
                }
            }

            else -> {
                Log.w("FridayDndReceiver", "Unknown action: ${intent.action}")
            }
        }
    }
}
