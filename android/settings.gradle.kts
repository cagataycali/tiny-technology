pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven {
            // 🕶️ Meta Wearables DAT (glasses SDK). GitHub Packages needs ANY
            // authenticated token with read:packages — no username. Dev/CI:
            // export GITHUB_TOKEN (`gh auth token` works). Never hardcode one
            // here: this tree gets ported to a public repo.
            url = uri("https://maven.pkg.github.com/facebook/meta-wearables-dat-android")
            credentials {
                username = ""
                password = System.getenv("GITHUB_TOKEN")
                    ?: providers.gradleProperty("githubToken").orNull.orEmpty()
            }
            content { includeGroup("com.meta.wearable") }
        }
    }
}

rootProject.name = "tiny"
include(":app")
include(":wear")
