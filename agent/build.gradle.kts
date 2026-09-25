plugins {
    // Also provides kotlin("android") to :app.
    kotlin("jvm") version "2.0.21" apply false
    kotlin("plugin.serialization") version "2.0.21" apply false
    // The Android Gradle Plugin is declared in :app so :core builds without Google's Maven repository.
}
