pluginManagement {
    // Overridden by scripts/verify/agp-fixture.mjs through VERIFY_AGP_VERSION.
    val fixtureAgpVersion: String by settings
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.application") version fixtureAgpVersion
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "agp-fixture"
include(":app")
