package com.joris.friday

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
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
 * so this helper first publishes a copy somewhere the user can reach:
 *
 *  1. the folder the user picked under Settings > Downloadmap ("Map kiezen",
 *     a Storage Access Framework tree URI), when one is set and still usable;
 *  2. otherwise the public Downloads collection (`Download/Friday`) via
 *     MediaStore — no storage permission needed on API 29+;
 *  3. only if both fail, the private copy served through the FileProvider.
 *
 * Afterwards it always tries to open the file ("Open bestand" chooser). It never
 * fails silently: the returned status string tells Rust (and through it the
 * user) what actually happened.
 *
 * Called from Rust through JNI ([ShareHelper.shareFile]).
 */
object ShareHelper {
    private const val TAG = "FridayShare"
    private const val DOWNLOADS_SUBDIR = "Friday"

    /** Status prefixes of the string returned to Rust: `STATUS|detail`. */
    private const val STATUS_OPENED = "OPENED"
    private const val STATUS_SAVED = "SAVED"
    private const val STATUS_ERROR = "ERROR"

    private class SavedCopy(val uri: Uri, val location: String)

    /**
     * @param treeUri tree URI chosen in Settings, or "" for the default location.
     * @return `OPENED|<where it was saved>` when a viewer chooser was shown,
     *         `SAVED|<where it was saved>` when the file is saved but no app
     *         could be launched for it, or `ERROR|<reason>`.
     */
    @JvmStatic
    fun shareFile(context: Context, filePath: String, mimeType: String, treeUri: String): String {
        return try {
            val file = File(filePath)
            if (!file.exists()) return "$STATUS_ERROR|Bestand niet gevonden: $filePath"
            val appContext = context.applicationContext

            var saved: SavedCopy? = null
            var folderNote = ""
            if (treeUri.isNotBlank()) {
                saved = copyToChosenFolder(appContext, file, mimeType, treeUri)
                if (saved == null) {
                    // Folder deleted, permission revoked, storage unmounted...
                    folderNote = " (gekozen map niet beschikbaar)"
                }
            }
            if (saved == null) {
                saved = copyToDownloads(appContext, file, mimeType)
            }

            // Prefer the public copy so the file stays reachable through the
            // Files app even when no viewer app is installed.
            val uri: Uri = saved?.uri
                ?: FileProvider.getUriForFile(
                    appContext,
                    "${appContext.packageName}.fileprovider",
                    file
                )
            val location = (saved?.location ?: "app-opslag") + folderNote

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(intent, "Open bestand")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

            // Deliberately no resolveActivity() pre-check: on Android 11+ it returns
            // null for every intent unless the manifest declares <queries>, which
            // used to make this method give up silently after saving the file.
            // startActivity is the ground truth.
            val status = try {
                appContext.startActivity(chooser)
                STATUS_OPENED
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "No app can open $mimeType; file kept at $location", e)
                STATUS_SAVED
            }

            // The user-facing copy exists now; drop the staging copy. Keep it when
            // we are serving it through the FileProvider.
            if (saved != null) file.delete()
            "$status|$location"
        } catch (e: Exception) {
            Log.e(TAG, "Failed to hand file to the user", e)
            "$STATUS_ERROR|${e.message ?: e.javaClass.simpleName}"
        }
    }

    /**
     * Human-readable name of a tree URI chosen with the folder picker, e.g.
     * `content://com.android.externalstorage.documents/tree/primary%3ADownload%2FFriday`
     * becomes `Download/Friday`.
     */
    @JvmStatic
    fun folderLabel(tree: Uri): String {
        return try {
            val id = DocumentsContract.getTreeDocumentId(tree)
            val colon = id.indexOf(':')
            val volume = if (colon >= 0) id.substring(0, colon) else ""
            val path = if (colon >= 0) id.substring(colon + 1) else id
            val base = if (path.isEmpty()) "Interne opslag" else path
            if (volume.isEmpty() || volume == "primary") base else "$volume: $base"
        } catch (e: Exception) {
            tree.toString()
        }
    }

    /**
     * Writes [file] into the folder the user picked. Returns null when that is
     * not possible so the caller can fall back to the default location.
     */
    private fun copyToChosenFolder(context: Context, file: File, mimeType: String, treeUriString: String): SavedCopy? {
        return try {
            val tree = Uri.parse(treeUriString)
            val resolver = context.contentResolver
            val parent = DocumentsContract.buildDocumentUriUsingTree(
                tree,
                DocumentsContract.getTreeDocumentId(tree)
            )
            // The provider picks a unique name itself when this one already exists.
            val doc = DocumentsContract.createDocument(resolver, parent, mimeType, file.name)
                ?: return null
            try {
                val out = resolver.openOutputStream(doc)
                    ?: throw java.io.IOException("openOutputStream returned null")
                out.use { stream ->
                    FileInputStream(file).use { input -> input.copyTo(stream) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Writing to the chosen folder failed", e)
                try {
                    DocumentsContract.deleteDocument(resolver, doc)
                } catch (ignored: Exception) {
                }
                return null
            }
            Log.i(TAG, "Saved ${file.name} to the chosen folder")
            SavedCopy(doc, folderLabel(tree))
        } catch (e: Exception) {
            Log.e(TAG, "Chosen folder unusable, falling back to Downloads", e)
            null
        }
    }

    /**
     * Copies [file] into the public Downloads collection and returns its
     * content URI, or null when that isn't possible (pre-Q devices, where it
     * would need a storage permission we don't request — or any I/O failure).
     * Callers fall back to the FileProvider URI in that case.
     */
    private fun copyToDownloads(context: Context, file: File, mimeType: String): SavedCopy? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val uri = copyToDownloadsQ(context, file, mimeType) ?: return null
        return SavedCopy(uri, "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOADS_SUBDIR")
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
