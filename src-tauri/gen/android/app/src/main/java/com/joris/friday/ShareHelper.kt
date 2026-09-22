package com.joris.friday

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream

/**
 * Hands a downloaded/exported file to the user.
 *
 * The Rust side stages files in app-private cache (invisible without root/adb),
 * so this helper first publishes a copy into the public Downloads collection
 * (`Download/Friday`) via MediaStore — no storage permission needed on API 29+.
 * Only if that fails does it fall back to serving the private copy through the
 * app's FileProvider. Afterwards the user is shown an "Open bestand" chooser.
 *
 * Called from Rust through JNI ([ShareHelper.shareFile]).
 */
object ShareHelper {
    private const val TAG = "FridayShare"
    private const val DOWNLOADS_SUBDIR = "Friday"

    @JvmStatic
    fun shareFile(context: Context, filePath: String, mimeType: String) {
        try {
            val file = File(filePath)
            if (!file.exists()) return
            val appContext = context.applicationContext

            // Prefer the public copy so the file stays reachable through the
            // Files app even when no viewer app is installed.
            val publicUri: Uri? = copyToDownloads(appContext, file, mimeType)
            val uri: Uri = publicUri
                ?: FileProvider.getUriForFile(
                    appContext,
                    "${appContext.packageName}.fileprovider",
                    file
                )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            // Guard against devices with no app that can open this type:
            // without this the startActivity below throws ActivityNotFoundException.
            // The file itself is safe: the public copy (when made) stays in Downloads.
            if (appContext.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) == null) {
                Log.w(TAG, "No viewer found for $mimeType, file kept at ${publicUri ?: filePath}")
                if (publicUri != null) file.delete()
                return
            }
            val chooser = Intent.createChooser(intent, "Open bestand")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            appContext.startActivity(chooser)
            // The user-facing copy lives in Downloads now; drop the staging copy.
            if (publicUri != null) file.delete()
        } catch (e: android.content.ActivityNotFoundException) {
            Log.e(TAG, "No app can open the downloaded file", e)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to open downloaded file", e)
        }
    }

    /**
     * Copies [file] into the public Downloads collection and returns its
     * content URI, or null when that isn't possible (pre-Q devices, where it
     * would need a storage permission we don't request — or any I/O failure).
     * Callers fall back to the FileProvider URI in that case.
     */
    private fun copyToDownloads(context: Context, file: File, mimeType: String): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return copyToDownloadsQ(context, file, mimeType)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun copyToDownloadsQ(context: Context, file: File, mimeType: String): Uri? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOADS_SUBDIR"
            )
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        try {
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return null
            try {
                resolver.openOutputStream(uri)?.use { out ->
                    FileInputStream(file).use { input -> input.copyTo(out) }
                } ?: run {
                    resolver.delete(uri, null, null)
                    return null
                }
            } catch (e: Exception) {
                Log.e(TAG, "Writing to Downloads failed, falling back to FileProvider", e)
                resolver.delete(uri, null, null)
                return null
            }
            val done = ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }
            resolver.update(uri, done, null, null)
            Log.i(TAG, "Saved ${file.name} to Downloads/$DOWNLOADS_SUBDIR")
            return uri
        } catch (e: Exception) {
            Log.e(TAG, "Copy to Downloads failed, falling back to FileProvider", e)
            return null
        }
    }
}
