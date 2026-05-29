package com.joris.friday

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Schedules precise DND on/off alarms based on Magister calendar data.
 *
 * Key design decisions for reliability:
 *  - Uses AlarmManager.setExactAndAllowWhileIdle() for precise timing even in Doze mode
 *  - Merges adjacent lessons (gap ≤ 5 min) into single DND blocks to avoid rapid toggling
 *  - Tracks whether Friday set DND via SharedPreferences ("dnd_set_by_friday") so we never
 *    override a user's manually-enabled DND
 *  - Schedules a 2-hour safety-off alarm as a failsafe — DND can never be stuck on indefinitely
 *  - Caches the calendar JSON so alarms can be re-scheduled after a reboot
 */
object DndScheduler {

    private const val TAG = "FridayDndScheduler"
    private const val PREFS_NAME = "friday_dnd_prefs"
    private const val KEY_DND_SET_BY_FRIDAY = "dnd_set_by_friday"
    private const val KEY_CACHED_CALENDAR = "cached_calendar_json"
    private const val KEY_CACHED_DATE = "cached_calendar_date"

    /** Lessons with a gap of ≤ this many ms are merged into one DND block. */
    private const val MERGE_GAP_MS = 5 * 60 * 1000L  // 5 minutes

    /** Maximum time DND can stay on before the safety timeout forces it off. */
    private const val SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000L  // 2 hours

    /** Unique request-code base for PendingIntents so they don't collide. */
    private const val REQUEST_CODE_BASE = 70000

    /**
     * Data class representing a merged DND block (one or more consecutive lessons).
     */
    data class DndBlock(val startMs: Long, val endMs: Long)

    // ─── Public API ──────────────────────────────────────────────────────

    /**
     * Main entry point: called after each sync with fresh calendar data.
     * Parses lessons, merges them into DND blocks, cancels old alarms, and schedules new ones.
     */
    @JvmStatic
    fun scheduleFromCalendar(context: Context, calendarData: JSONArray) {
        if (!SyncStateManager.isNotificationEnabled(context, "autoDnd")) {
            Log.d(TAG, "Auto DND is disabled in preferences — skipping")
            return
        }

        if (!NotificationHelper.hasDndAccess(context)) {
            Log.w(TAG, "DND access not granted — cannot schedule alarms")
            return
        }

        // Cache the calendar data so we can re-schedule after reboot
        cacheCalendarData(context, calendarData)

        val blocks = buildDndBlocks(calendarData)
        Log.d(TAG, "Built ${blocks.size} DND block(s) from ${calendarData.length()} calendar events")

        cancelAllAlarms(context)
        scheduleAlarms(context, blocks)

        // Also immediately check if we should be in DND right now
        // (handles the case where the app starts mid-lesson)
        applyImmediateState(context, blocks)
    }

    /**
     * Re-schedule alarms from cached calendar data (e.g. after reboot).
     */
    @JvmStatic
    fun rescheduleFromCache(context: Context) {
        if (!SyncStateManager.isNotificationEnabled(context, "autoDnd")) {
            return
        }

        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cachedDate = prefs.getString(KEY_CACHED_DATE, null)
        val todayStr = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(java.util.Date())

        // Only use cache if it's from today
        if (cachedDate != todayStr) {
            Log.d(TAG, "Cached calendar is from $cachedDate, today is $todayStr — skipping reschedule")
            return
        }

        val cachedJson = prefs.getString(KEY_CACHED_CALENDAR, null) ?: return
        try {
            val calendarData = JSONArray(cachedJson)
            Log.d(TAG, "Rescheduling from cached calendar (${calendarData.length()} events)")
            val blocks = buildDndBlocks(calendarData)
            cancelAllAlarms(context)
            scheduleAlarms(context, blocks)
            applyImmediateState(context, blocks)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to reschedule from cache", e)
        }
    }

    /**
     * Cancel all scheduled DND alarms and turn off DND if we set it.
     * Called when the user disables auto-DND.
     */
    @JvmStatic
    fun cancelAll(context: Context) {
        cancelAllAlarms(context)
        // Turn off DND only if we turned it on
        if (didFridaySetDnd(context)) {
            NotificationHelper.updateDndStatus(context, false)
            setFridayDndFlag(context, false)
            Log.d(TAG, "Auto DND disabled — turned off DND and cleared flag")
        }
    }

    /**
     * Check if Friday is the one that turned DND on.
     */
    @JvmStatic
    fun didFridaySetDnd(context: Context): Boolean {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_DND_SET_BY_FRIDAY, false)
    }

    /**
     * Set/clear the flag that records whether Friday turned on DND.
     */
    @JvmStatic
    fun setFridayDndFlag(context: Context, value: Boolean) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_DND_SET_BY_FRIDAY, value)
            .apply()
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /**
     * Build merged DND blocks from calendar events.
     * Only considers non-cancelled lesson-type events happening today.
     */
    private fun buildDndBlocks(calendarData: JSONArray): List<DndBlock> {
        val now = System.currentTimeMillis()
        val todayCal = Calendar.getInstance()
        val todayStart = todayCal.apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        val todayEnd = todayStart + 24 * 60 * 60 * 1000L

        // Collect all lesson intervals for today
        val intervals = mutableListOf<Pair<Long, Long>>()  // (start, end)

        for (i in 0 until calendarData.length()) {
            try {
                val event = calendarData.getJSONObject(i)
                val startStr = event.optString("Start", "")
                val endStr = event.optString("Einde", "")
                val status = event.optInt("Status", 0)

                // Skip cancelled events (status 4 = cancelled, status 5 = auto-cancelled)
                if (status == 4 || status == 5) continue

                // Only process scheduled lessons (Type 16 = "Rooster").
                // Without this filter personal events, free periods, school-wide events and
                // study-house slots all create unwanted DND blocks.
                val type = event.optInt("Type", 0)
                if (type != 16) continue

                // Skip all-day events — they carry no precise start/end time and would
                // create a block covering the whole day, keeping DND stuck ON.
                if (event.optBoolean("DuurtHeleDag", false)) continue

                if (startStr.isEmpty() || endStr.isEmpty()) continue

                val startMs = parseMagisterDate(startStr) ?: continue
                val endMs = parseMagisterDate(endStr) ?: continue

                // Only consider events that are today and haven't ended yet.
                // The todayStart guard also prevents yesterday's lessons from leaking in
                // when the sync uses a UTC-based date that drifts near midnight CET.
                if (startMs < todayStart) continue  // Before today (UTC drift guard)
                if (endMs < now) continue            // Already over
                if (startMs >= todayEnd) continue    // Tomorrow or later

                intervals.add(Pair(startMs, endMs))
            } catch (e: Exception) {
                // Skip malformed events
            }
        }

        if (intervals.isEmpty()) return emptyList()

        // Sort by start time
        val sorted = intervals.sortedBy { it.first }

        // Merge overlapping/adjacent intervals (gap ≤ MERGE_GAP_MS)
        val merged = mutableListOf<DndBlock>()
        var currentStart = sorted[0].first
        var currentEnd = sorted[0].second

        for (i in 1 until sorted.size) {
            val (nextStart, nextEnd) = sorted[i]
            if (nextStart <= currentEnd + MERGE_GAP_MS) {
                // Overlapping or close enough — extend the current block
                currentEnd = maxOf(currentEnd, nextEnd)
            } else {
                // Gap too large — save current block and start a new one
                merged.add(DndBlock(currentStart, currentEnd))
                currentStart = nextStart
                currentEnd = nextEnd
            }
        }
        merged.add(DndBlock(currentStart, currentEnd))

        Log.d(TAG, "Merged ${intervals.size} lesson intervals into ${merged.size} DND block(s):")
        val fmt = SimpleDateFormat("HH:mm", Locale.getDefault())
        merged.forEachIndexed { idx, block ->
            Log.d(TAG, "  Block $idx: ${fmt.format(block.startMs)} - ${fmt.format(block.endMs)}")
        }

        return merged
    }

    /**
     * Schedule exact alarms for each DND block.
     * For each block:
     *   - DND ON alarm at block.startMs
     *   - DND OFF alarm at block.endMs
     *   - Safety OFF alarm at block.startMs + SAFETY_TIMEOUT_MS (failsafe)
     */
    private fun scheduleAlarms(context: Context, blocks: List<DndBlock>) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val now = System.currentTimeMillis()

        // On Android 12+ (API 31), check if we can schedule exact alarms
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!alarmManager.canScheduleExactAlarms()) {
                Log.w(TAG, "Cannot schedule exact alarms — permission not granted. Using inexact.")
                scheduleInexactAlarms(context, alarmManager, blocks, now)
                return
            }
        }

        for ((idx, block) in blocks.withIndex()) {
            // Schedule DND ON
            if (block.startMs > now) {
                val onIntent = createAlarmIntent(context, DndReceiver.ACTION_DND_ON, REQUEST_CODE_BASE + idx * 3)
                scheduleExact(alarmManager, block.startMs, onIntent)
                Log.d(TAG, "Scheduled DND ON at ${formatTime(block.startMs)}")
            }

            // Schedule DND OFF
            if (block.endMs > now) {
                val offIntent = createAlarmIntent(context, DndReceiver.ACTION_DND_OFF, REQUEST_CODE_BASE + idx * 3 + 1)
                scheduleExact(alarmManager, block.endMs, offIntent)
                Log.d(TAG, "Scheduled DND OFF at ${formatTime(block.endMs)}")
            }

            // Schedule safety OFF (failsafe)
            val safetyTime = block.startMs + SAFETY_TIMEOUT_MS
            if (safetyTime > now && safetyTime > block.endMs) {
                val safetyIntent = createAlarmIntent(context, DndReceiver.ACTION_DND_SAFETY_OFF, REQUEST_CODE_BASE + idx * 3 + 2)
                scheduleExact(alarmManager, safetyTime, safetyIntent)
                Log.d(TAG, "Scheduled safety OFF at ${formatTime(safetyTime)}")
            }
        }
    }

    /**
     * Fallback for devices where exact alarm permission is not granted.
     * Uses setAndAllowWhileIdle() which is less precise but doesn't require SCHEDULE_EXACT_ALARM.
     */
    private fun scheduleInexactAlarms(
        context: Context,
        alarmManager: AlarmManager,
        blocks: List<DndBlock>,
        now: Long
    ) {
        for ((idx, block) in blocks.withIndex()) {
            if (block.startMs > now) {
                val onIntent = createAlarmIntent(context, DndReceiver.ACTION_DND_ON, REQUEST_CODE_BASE + idx * 3)
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, block.startMs, onIntent)
                Log.d(TAG, "Scheduled inexact DND ON at ${formatTime(block.startMs)}")
            }
            if (block.endMs > now) {
                val offIntent = createAlarmIntent(context, DndReceiver.ACTION_DND_OFF, REQUEST_CODE_BASE + idx * 3 + 1)
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, block.endMs, offIntent)
                Log.d(TAG, "Scheduled inexact DND OFF at ${formatTime(block.endMs)}")
            }
            val safetyTime = block.startMs + SAFETY_TIMEOUT_MS
            if (safetyTime > now && safetyTime > block.endMs) {
                val safetyIntent = createAlarmIntent(context, DndReceiver.ACTION_DND_SAFETY_OFF, REQUEST_CODE_BASE + idx * 3 + 2)
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, safetyTime, safetyIntent)
                Log.d(TAG, "Scheduled inexact safety OFF at ${formatTime(safetyTime)}")
            }
        }
    }

    /**
     * Check if we're currently inside a DND block and apply the correct state immediately.
     * This handles the case where the app starts (or sync runs) mid-lesson.
     */
    private fun applyImmediateState(context: Context, blocks: List<DndBlock>) {
        val now = System.currentTimeMillis()
        val isInsideBlock = blocks.any { now in it.startMs..it.endMs }

        if (isInsideBlock) {
            // We're currently in a lesson — enable DND if not already
            Log.d(TAG, "Currently inside a DND block — enabling DND")
            NotificationHelper.updateDndStatus(context, true)
            setFridayDndFlag(context, true)
        } else {
            // We're not in a lesson — disable DND only if we set it
            if (didFridaySetDnd(context)) {
                Log.d(TAG, "Currently outside DND blocks and Friday had set DND — disabling DND")
                NotificationHelper.updateDndStatus(context, false)
                setFridayDndFlag(context, false)
            } else {
                Log.d(TAG, "Currently outside DND blocks (DND not set by Friday)")
            }
        }
    }

    private fun scheduleExact(alarmManager: AlarmManager, triggerAtMs: Long, pendingIntent: PendingIntent) {
        try {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
        } catch (e: SecurityException) {
            // Fallback if exact alarm permission is revoked between the check and this call
            Log.w(TAG, "SecurityException scheduling exact alarm, falling back to inexact", e)
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
        }
    }

    private fun createAlarmIntent(context: Context, action: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, DndReceiver::class.java).apply {
            this.action = action
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /**
     * Cancel all previously scheduled DND alarms.
     * We cancel a generous range of request codes to ensure no stale alarms remain.
     */
    private fun cancelAllAlarms(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Cancel up to 30 alarm slots (10 blocks × 3 alarms each)
        for (code in REQUEST_CODE_BASE until REQUEST_CODE_BASE + 30) {
            for (action in listOf(DndReceiver.ACTION_DND_ON, DndReceiver.ACTION_DND_OFF, DndReceiver.ACTION_DND_SAFETY_OFF)) {
                val intent = Intent(context, DndReceiver::class.java).apply { this.action = action }
                val pi = PendingIntent.getBroadcast(
                    context, code, intent,
                    PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                )
                pi?.let {
                    alarmManager.cancel(it)
                    it.cancel()
                }
            }
        }
        Log.d(TAG, "All DND alarms cancelled")
    }

    private fun cacheCalendarData(context: Context, calendarData: JSONArray) {
        val todayStr = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(java.util.Date())
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CACHED_CALENDAR, calendarData.toString())
            .putString(KEY_CACHED_DATE, todayStr)
            .apply()
    }

    private fun parseMagisterDate(dateStr: String): Long? {
        try {
            var s = dateStr.replace(Regex("\\.\\d+"), "")
            s = s.replace("Z", "+0000")
            val colonIdx = s.lastIndexOf(":")
            if (colonIdx > s.length - 4 && (s.contains("+") || s.contains("-")) && s.indexOf('T') > -1) {
                s = s.substring(0, colonIdx) + s.substring(colonIdx + 1)
            }
            val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", Locale.US)
            return format.parse(s)?.time
        } catch (e: Exception) {
            try {
                val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
                return format.parse(dateStr)?.time
            } catch (ex: Exception) {
                return null
            }
        }
    }

    private fun formatTime(ms: Long): String {
        return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(java.util.Date(ms))
    }
}
