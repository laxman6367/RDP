pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
    }
}

rootProject.name = "redcore-agent"

// Pure-Kotlin agent logic (signature checks, lock resolution, restriction diffs). Builds anywhere.
include(":core")

// The Android app needs the Android SDK. Include it when an SDK is available
// (ANDROID_HOME / ANDROID_SDK_ROOT or sdk.dir in local.properties), e.g. in CI.
val localProps = file("local.properties").takeIf { it.exists() }?.readText().orEmpty()
val hasSdk = System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null || "sdk.dir" in localProps
if (hasSdk && file("app").isDirectory) include(":app") else logger.lifecycle("Building :core only (no Android SDK or no :app module)")
