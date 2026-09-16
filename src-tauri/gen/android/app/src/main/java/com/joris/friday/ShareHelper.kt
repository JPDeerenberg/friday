package com.joris.friday

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

/**
 * Opens a downloaded file via the app's FileProvider so the user is shown a
 * chooser instead of the file landing in an invisible app-private cache path.
 * Called from the Rust `download_file` command through JNI ([ShareHelper.shareFile]).
 */
object ShareHelper {
    @JvmStatic
    fun shareFile(context: Context, filePath: String, mimeType: String) {
        try {
            val file = File(filePath)
            if (!file.exists()) return

            val uri: Uri = FileProvider.getUriForFile(
                context.applicationContext,
                "${context.packageName}.fileprovider",
                file
            )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            // Guard against devices with no app that can open this type:
            // without this the startActivity below throws ActivityNotFoundException.
            if (context.packageManager.resolveActivity(intent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY) == null) {
                android.util.Log.w("FridayShare", "No viewer found for $mimeType, file kept at $filePath")
                return
            }
            val chooser = Intent.createChooser(intent, "Open bestand")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.applicationContext.startActivity(chooser)
        } catch (e: android.content.ActivityNotFoundException) {
            android.util.Log.e("FridayShare", "No app can open the downloaded file", e)
        } catch (e: Exception) {
            android.util.Log.e("FridayShare", "Failed to open downloaded file", e)
        }
    }
}
