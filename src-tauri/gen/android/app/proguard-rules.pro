# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Keep JNI classes and their members so Rust can find them.
# NOTE: every Kotlin helper reached only via JNI reflection from Rust
# (find_class + call_static_method) MUST be listed here — R8 cannot see
# the reflective reference and strips the class from release builds
# (minifyEnabled=true), which crashes the app with ClassNotFoundException.
# This is what removed ShareHelper and crashed 'Alles exporteren'.
-keep class com.joris.friday.NotificationHelper { *; }
-keep class com.joris.friday.ShareHelper { *; }
-keep class com.joris.friday.SyncStateManager { *; }
-keep class com.joris.friday.MainActivity { *; }
-keep class com.joris.friday.SyncWorker { *; }
-keep class com.joris.friday.DndScheduler { *; }
-keep class com.joris.friday.DndReceiver { *; }
-keep class com.joris.friday.BootReceiver { *; }
-keep class com.joris.friday.BatteryReceiver { *; }
-keep class com.joris.friday.SyncAlarmReceiver { *; }