plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "technology.tiny.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "technology.tiny.app"
        minSdk = 29
        targetSdk = 35
        versionCode = 27
        versionName = "0.7.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Sideload-distributed build; signed with the local tiny keystore so
            // OTA updates keep the same signature.
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
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.browser)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    // Animated GIF landing logos: Coil's base BitmapFactory decoder shows only a
    // GIF's first frame; ImageDecoderDecoder (API 28+, no fallback needed at
    // minSdk 29) lives in this artifact. Version literal (not the toml `coil`
    // ref) kept deliberately: a concurrent session owns libs.versions.toml edits.
    implementation("io.coil-kt:coil-gif:2.7.0")
    // SVG landing logos (worker upsert allows svg; web <img> renders natively —
    // Coil needs SvgDecoder or the logo errors out and hides). Version literal
    // for the same toml-ownership reason as coil-gif above.
    implementation("io.coil-kt:coil-svg:2.7.0")
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)
    implementation(libs.androidx.exifinterface)
    // Phone → watch session handoff over the Wearable Data Layer (WatchBridge).
    implementation(libs.play.services.wearable)
    // 🗺️ Maps + location context (agi-diy port): FusedLocation feeds the agent's
    // `### Location` block; maps-compose renders the dark map screen
    implementation(libs.play.services.location)
    implementation(libs.play.services.maps)
    implementation(libs.maps.compose)
    debugImplementation(libs.androidx.ui.tooling)
    testImplementation(libs.junit)
    // org.json is an android.jar stub that throws on the JVM test classpath;
    // this real impl lets unit tests exercise pure fns that build/parse JSON.
    testImplementation(libs.json)
}
