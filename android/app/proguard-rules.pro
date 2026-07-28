# tiny — R8 keep rules for the sideload release build.
#
# The release build minifies + shrinks (debug does not), so anything reached
# only reflectively, or compile-only annotations R8 can't see, must be listed.

# --- Tink / EncryptedSharedPreferences (androidx.security.crypto) ---
# Tink references errorprone annotations that are compile-only (not on the
# runtime classpath). They're erased at runtime; silence the missing-class
# warnings rather than dragging errorprone in.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-keep class com.google.crypto.tink.** { *; }
# Tink's KeysDownloader pulls remote keysets over the Google HTTP client + Joda
# — a feature we never touch (keys live in EncryptedSharedPreferences). Those
# deps aren't on the classpath; silence the references rather than adding them.
-dontwarn com.google.api.client.http.**
-dontwarn org.joda.time.**

# --- OkHttp / Okio (used by TinyApi + okhttp-sse) ---
# OkHttp ships its own consumer rules, but keep the platform-conditional bits
# quiet on the shrinker.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- Kotlin coroutines internals reached reflectively ---
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }
