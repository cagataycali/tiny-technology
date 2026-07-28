plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "technology.tiny.wear"
    compileSdk = 35

    defaultConfig {
        applicationId = "technology.tiny.wear"
        // Wear OS 3+ (the standalone watch app track); the phone app is minSdk 29.
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Same debug keystore as :app so the phone↔watch pair share a signer
            // and OTA updates keep a stable signature (sideload-distributed).
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // The wrist brain is the SAME file the phone unit-tests on the JVM
    // (technology.tiny.app.wear.WatchCore). Compile it straight into the watch
    // app instead of duplicating it, so both surfaces speak one API dialect.
    sourceSets {
        getByName("main") {
            java.srcDir("../app/src/main/java/technology/tiny/app/wear")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.wear.compose.material)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.tooling.preview)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.play.services.wearable)
    // Tiles: the glanceable fleet-presence surface, rendered without the app open.
    implementation(libs.androidx.wear.tiles)
    implementation(libs.androidx.wear.tiles.material)
    implementation(libs.androidx.wear.protolayout)
    implementation(libs.androidx.wear.protolayout.material)
    implementation(libs.androidx.wear.protolayout.expression)
    implementation(libs.guava) // ListenableFuture for the TileService contract
    // Complications: the smallest watch-face glance (online/total).
    implementation(libs.androidx.wear.watchface.complications.datasource)
    implementation(libs.androidx.wear.watchface.complications.datasource.ktx)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.kotlinx.coroutines.android)
    debugImplementation(libs.androidx.ui.tooling)
    testImplementation(libs.junit)
    testImplementation(libs.json)
}
