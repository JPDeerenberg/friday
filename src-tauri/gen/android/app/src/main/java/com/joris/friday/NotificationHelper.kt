package com.joris.friday

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

object NotificationHelper {
    
    // Notification types
    const val TYPE_TEST = 0
    const val TYPE_MESSAGE = 1
    const val TYPE_CALENDAR = 2
    const val TYPE_GRADE = 3
    const val TYPE_DEADLINE = 4
    
    // Channel IDs
    private const val CHANNEL_TEST = "friday_test"
    private const val CHANNEL_MESSAGES = "friday_messages"
    private const val CHANNEL_CALENDAR = "friday_calendar"
    private const val CHANNEL_GRADES = "friday_grades"
    private const val CHANNEL_DEADLINES = "friday_deadlines"
    
    // Notification IDs
    private const val ID_TEST = 1001
    private const val ID_MESSAGE = 2001
    private const val ID_CALENDAR = 3001
    private const val ID_GRADE = 4001
    private const val ID_DEADLINE = 5001
    
    fun showNotification(context: Context, type: Int, title: String, message: String, extra: String?) {
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        
        // Create channels based on type
        createChannels(notificationManager)
        
        // Determine channel, icon, and ID based on type
        val (channelId, icon, notificationId, action) = when (type) {
            TYPE_MESSAGE -> ChannelInfo(CHANNEL_MESSAGES, android.R.drawable.ic_dialog_email, ID_MESSAGE, "messages")
            TYPE_CALENDAR -> ChannelInfo(CHANNEL_CALENDAR, android.R.drawable.ic_menu_my_calendar, ID_CALENDAR, "calendar")
            TYPE_GRADE -> ChannelInfo(CHANNEL_GRADES, android.R.drawable.ic_menu_agenda, ID_GRADE, "grades")
            TYPE_DEADLINE -> ChannelInfo(CHANNEL_DEADLINES, android.R.drawable.ic_popup_reminder, ID_DEADLINE, "assignments")
            else -> ChannelInfo(CHANNEL_TEST, android.R.drawable.ic_popup_sync, ID_TEST, null)
        }
        
        // Create intent with proper flags to open app
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            // Pass the target page as extra data
            action?.let { putExtra("target_page", it) }
            extra?.let { putExtra("extra_data", it) }
        }
        
        val pendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        try {
            val builder = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(icon)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
            
            notificationManager.notify(notificationId, builder.build())
        } catch (e: SecurityException) {
            e.printStackTrace()
        }
    }
    
    private fun createChannels(notificationManager: NotificationManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Test channel
            val testChannel = NotificationChannel(
                CHANNEL_TEST,
                "Test Notificaties",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Test notificaties voor debugging"
            }
            
            // Messages channel
            val messagesChannel = NotificationChannel(
                CHANNEL_MESSAGES,
                "Berichten",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Meldingen voor nieuwe berichten"
            }
            
            // Calendar channel
            val calendarChannel = NotificationChannel(
                CHANNEL_CALENDAR,
                "Agenda",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Meldingen voor agenda wijzigingen"
            }
            
            // Grades channel
            val gradesChannel = NotificationChannel(
                CHANNEL_GRADES,
                "Cijfers",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Meldingen voor nieuwe cijfers"
            }
            
            // Deadlines channel
            val deadlinesChannel = NotificationChannel(
                CHANNEL_DEADLINES,
                "Deadlines",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Meldingen voor opdrachten en deadlines"
            }
            
            notificationManager.createNotificationChannels(
                listOf(testChannel, messagesChannel, calendarChannel, gradesChannel, deadlinesChannel)
            )
        }
    }
    
    // Convenience methods for each type
    fun showTestNotification(context: Context, title: String, message: String) {
        showNotification(context, TYPE_TEST, title, message, null)
    }
    
    fun showMessageNotification(context: Context, title: String, message: String, sender: String?) {
        val extra = sender?.let { """{"sender":"$it"}""" }
        showNotification(context, TYPE_MESSAGE, title, message, extra)
    }
    
    fun showCalendarNotification(context: Context, title: String, message: String, eventId: String?) {
        val extra = eventId?.let { """{"eventId":"$it"}""" }
        showNotification(context, TYPE_CALENDAR, title, message, extra)
    }
    
    fun showGradeNotification(context: Context, title: String, message: String, gradeId: String?) {
        val extra = gradeId?.let { """{"gradeId":"$it"}""" }
        showNotification(context, TYPE_GRADE, title, message, extra)
    }
    
    fun showDeadlineNotification(context: Context, title: String, message: String, assignmentId: String?) {
        val extra = assignmentId?.let { """{"assignmentId":"$it"}""" }
        showNotification(context, TYPE_DEADLINE, title, message, extra)
    }
    
    private data class ChannelInfo(
        val channelId: String,
        val icon: Int,
        val notificationId: Int,
        val action: String?
    )
}