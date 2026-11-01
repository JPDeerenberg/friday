package com.joris.friday

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Detects *what* changed in the agenda between two syncs, and keeps the list of
 * unseen changes that the in-app popup shows after tapping the notification.
 *
 * Deliberately free of Android classes so it can be compiled and tested on a
 * plain JVM. Persistence lives in [PendingCalendarChanges].
 *
 * Change entry (JSON), all strings are Magister values:
 *   { id, title, start, end, kinds: [...], detectedAt?,
 *     oldStart?, oldEnd?, oldRoom?, newRoom?, oldTeacher?, newTeacher? }
 */
object CalendarChanges {
    const val KIND_NEW = "new"
    const val KIND_REMOVED = "removed"
    const val KIND_CANCELLED = "cancelled"
    const val KIND_MOVED = "moved"
    const val KIND_ROOM = "room"
    const val KIND_TEACHER = "teacher"

    private const val MAX_PENDING = 40

    /** Inclusive range of dates (yyyy-MM-dd). */
    data class DayWindow(val from: String, val to: String) {
        fun isEmpty(): Boolean = from > to
        fun contains(date: String): Boolean = date >= from && date <= to
        fun overlap(other: DayWindow): DayWindow =
            DayWindow(maxOf(from, other.from), minOf(to, other.to))
    }

    // ── Time helpers (Magister Start/Einde are UTC ISO strings) ─────────────

    fun utcIso(ms: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(java.util.Date(ms))
    }

    /** Date (Europe/Amsterdam) of `ms`, shifted by `plusDays`. */
    fun amsterdamDay(ms: Long, plusDays: Int): String {
        val tz = TimeZone.getTimeZone("Europe/Amsterdam")
        val cal = Calendar.getInstance(tz, Locale.US)
        cal.timeInMillis = ms
        cal.add(Calendar.DAY_OF_MONTH, plusDays)
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = tz
        return f.format(cal.time)
    }

    // ── Reading Magister events ─────────────────────────────────────────────

    private fun str(e: JSONObject, key: String): String =
        if (e.isNull(key)) "" else e.optString(key, "").trim()

    private fun isCancelled(e: JSONObject): Boolean {
        val s = e.optInt("Status", 0)
        return s == 4 || s == 5
    }

    private fun joinedNames(arr: JSONArray?): String {
        if (arr == null) return ""
        val names = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val n = str(o, "Naam")
            if (n.isNotEmpty()) names.add(n)
        }
        return names.sorted().joinToString(", ")
    }

    private fun room(e: JSONObject): String {
        val loc = str(e, "Lokatie")
        if (loc.isNotEmpty()) return loc
        return joinedNames(e.optJSONArray("Lokalen"))
    }

    private fun teachers(e: JSONObject): String = joinedNames(e.optJSONArray("Docenten"))

    private fun indexById(events: JSONArray, window: DayWindow): LinkedHashMap<Long, JSONObject> {
        val map = LinkedHashMap<Long, JSONObject>()
        for (i in 0 until events.length()) {
            val e = events.optJSONObject(i) ?: continue
            val id = e.optLong("Id", 0L)
            if (id <= 0L) continue
            if (!window.contains(str(e, "Start").take(10))) continue
            map[id] = e
        }
        return map
    }

    private fun entry(e: JSONObject, kinds: List<String>, prev: JSONObject?): JSONObject {
        val o = JSONObject()
        o.put("id", e.optLong("Id", 0L))
        o.put("title", str(e, "Omschrijving"))
        o.put("start", str(e, "Start"))
        o.put("end", str(e, "Einde"))
        o.put("kinds", JSONArray(kinds))
        if (prev != null) {
            if (KIND_MOVED in kinds) {
                o.put("oldStart", str(prev, "Start"))
                o.put("oldEnd", str(prev, "Einde"))
            }
            if (KIND_ROOM in kinds) {
                o.put("oldRoom", room(prev))
                o.put("newRoom", room(e))
            }
            if (KIND_TEACHER in kinds) {
                o.put("oldTeacher", teachers(prev))
                o.put("newTeacher", teachers(e))
            }
        }
        return o
    }

    // ── Diff ────────────────────────────────────────────────────────────────

    /**
     * Compare two syncs, looking only at events inside `window`. The window must
     * be the part of the calendar that BOTH syncs fetched: the background sync
     * only fetches today and tomorrow, so when the window slides at midnight the
     * newly included day is not a "change".
     */
    fun diff(previous: JSONArray, current: JSONArray, window: DayWindow, nowUtcIso: String): JSONArray {
        val out = JSONArray()
        if (window.isEmpty()) return out
        val prevById = indexById(previous, window)
        val curById = indexById(current, window)

        for ((id, cur) in curById) {
            val prev = prevById[id]
            if (prev == null) {
                out.put(entry(cur, listOf(KIND_NEW), null))
                continue
            }
            val kinds = mutableListOf<String>()
            val curCancelled = isCancelled(cur)
            if (curCancelled && !isCancelled(prev)) {
                kinds.add(KIND_CANCELLED)
            } else if (!curCancelled) {
                if (str(cur, "Start") != str(prev, "Start") || str(cur, "Einde") != str(prev, "Einde")) {
                    kinds.add(KIND_MOVED)
                }
                if (room(cur) != room(prev)) kinds.add(KIND_ROOM)
                if (teachers(cur) != teachers(prev)) kinds.add(KIND_TEACHER)
            }
            if (kinds.isNotEmpty()) out.put(entry(cur, kinds, prev))
        }

        // Disappeared from Magister. Only upcoming, not-already-cancelled ones
        // count: past lessons dropping out of view is not a change.
        for ((id, prev) in prevById) {
            if (curById.containsKey(id) || isCancelled(prev)) continue
            if (str(prev, "Start").take(19) <= nowUtcIso) continue
            out.put(entry(prev, listOf(KIND_REMOVED), null))
        }
        return out
    }

    // ── Pending list (everything changed since the user last looked) ───────

    private fun kindsOf(o: JSONObject): List<String> {
        val arr = o.optJSONArray("kinds") ?: return emptyList()
        val list = mutableListOf<String>()
        for (i in 0 until arr.length()) list.add(arr.optString(i))
        return list
    }

    /** Same event changed again before the user looked: keep the ORIGINAL old values. */
    private fun combine(old: JSONObject, added: JSONObject): JSONObject {
        val out = JSONObject()
        for (key in listOf("id", "title", "start", "end", "detectedAt")) {
            if (added.has(key)) out.put(key, added.get(key))
        }
        val kinds = (kindsOf(old) + kindsOf(added)).distinct()
            .filter { !(it == KIND_REMOVED && (kindsOf(added).any { k -> k != KIND_REMOVED })) }
        out.put("kinds", JSONArray(kinds))
        for (key in listOf("oldStart", "oldEnd", "oldRoom", "oldTeacher")) {
            if (old.has(key)) out.put(key, old.get(key)) else if (added.has(key)) out.put(key, added.get(key))
        }
        for (key in listOf("newRoom", "newTeacher")) {
            if (added.has(key)) out.put(key, added.get(key)) else if (old.has(key)) out.put(key, old.get(key))
        }
        return out
    }

    /**
     * Merge freshly detected changes into the pending list. Lessons that already
     * started are dropped (no longer useful), the list is capped, sorted by time.
     */
    fun mergePending(existing: JSONArray, added: JSONArray, nowMs: Long): JSONArray {
        val nowIso = utcIso(nowMs)
        val byId = LinkedHashMap<Long, JSONObject>()
        for (i in 0 until existing.length()) {
            val e = existing.optJSONObject(i) ?: continue
            byId[e.optLong("id", 0L)] = e
        }
        for (i in 0 until added.length()) {
            val n = added.optJSONObject(i) ?: continue
            val id = n.optLong("id", 0L)
            n.put("detectedAt", nowMs)
            val old = byId[id]
            byId[id] = if (old == null) n else combine(old, n)
        }
        val kept = byId.values
            .filter { it.optString("start", "").take(19) > nowIso }
            .sortedBy { it.optString("start", "") }
            .takeLast(MAX_PENDING)
        val out = JSONArray()
        for (o in kept) out.put(o)
        return out
    }

    // ── Notification text ───────────────────────────────────────────────────

    private fun describe(c: JSONObject): String {
        val title = c.optString("title", "").ifBlank { "Afspraak" }
        val kinds = kindsOf(c)
        return when {
            KIND_CANCELLED in kinds -> "$title vervalt"
            KIND_REMOVED in kinds -> "$title is verwijderd"
            KIND_NEW in kinds -> "Nieuw: $title"
            KIND_MOVED in kinds -> "$title is verplaatst"
            KIND_ROOM in kinds -> "$title: ander lokaal"
            KIND_TEACHER in kinds -> "$title: andere docent"
            else -> title
        }
    }

    /** (title, message) for the notification about a batch of fresh changes. */
    fun notificationText(changes: JSONArray): Pair<String, String> {
        val count = changes.length()
        if (count == 0) return Pair("Agenda gewijzigd", "")
        val first = describe(changes.optJSONObject(0) ?: JSONObject())
        return if (count == 1) {
            Pair("Agenda gewijzigd", first)
        } else {
            Pair("$count agendawijzigingen", "$first en ${count - 1} andere(n)")
        }
    }
}
