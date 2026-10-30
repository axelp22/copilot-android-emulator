plugins {
    id("com.android.application")
}

android {
    namespace = "dev.copilot.androidemulator.fixture"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.copilot.androidemulator.fixture"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
