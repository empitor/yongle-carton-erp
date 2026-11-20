plugins {
    id("com.android.application")
    checkstyle
}

/** 正式版（release）打开的网址 */
val releaseUrl = "https://erp.nbyongle.cn/"

/** 测试版（debug）打开的网址：gradle.properties 的 erpTestUrl，或命令行 -PerpTestUrl= */
val testUrl = providers.gradleProperty("erpTestUrl").get()

/** 应用内更新的版本清单地址：正式版 releaseUpdateUrl（空 = 不检查），测试版 testUpdateUrl */
val releaseUpdateUrl = providers.gradleProperty("releaseUpdateUrl").get()
val testUpdateUrl = providers.gradleProperty("testUpdateUrl").get()

android {
    namespace = "cn.nbyongle.erp"
    compileSdk = 36

    defaultConfig {
        applicationId = "cn.nbyongle.erp"
        minSdk = 29
        targetSdk = 36
        versionCode = providers.gradleProperty("appVersionCode").get().toInt()
        versionName = providers.gradleProperty("appVersionName").get()
    }

    buildFeatures {
        buildConfig = true
        resValues = true
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".test"
            buildConfigField("String", "ERP_URL", "\"$testUrl\"")
            buildConfigField("String", "UPDATE_URL", "\"$testUpdateUrl\"")
            resValue("string", "app_name", "甬勒ERP测试")
        }
        release {
            isMinifyEnabled = false
            buildConfigField("String", "ERP_URL", "\"$releaseUrl\"")
            buildConfigField("String", "UPDATE_URL", "\"$releaseUpdateUrl\"")
            resValue("string", "app_name", "甬勒ERP")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
        // 这三条只说“有更新的 SDK、Android Gradle 插件了”：结果只取决于检查那天外面出没出新版本，和代码无关，
        // 硬拦会让同一份代码今天过、明天不过。降成提示，照样列在报告里；升级要装新的 SDK 或插件、在真机上重新验
        informational += setOf("OldTargetApi", "GradleDependency", "AndroidGradlePluginVersion")
    }
}

/** javac 的全部告警都当错误（和 ERP 项目“一处告警都不许”对齐） */
tasks.withType<JavaCompile>().configureEach {
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

checkstyle {
    toolVersion = "14.4.0"
    configFile = rootProject.file("config/checkstyle.xml")
}

/** 函数行数、参数个数、嵌套、复杂度和文件长度（规则见 config/checkstyle.xml），产品代码和测试都查 */
val checkstyleJava = tasks.register<Checkstyle>("checkstyleJava") {
    source("src")
    include("**/*.java")
    classpath = files()
}

/** 运行时不许有任何第三方库：两种构建的运行时依赖解析出来必须是空的（不管 build.gradle.kts 里怎么写的依赖） */
val checkNoRuntimeLibraries = tasks.register("checkNoRuntimeLibraries") {
    val graphs = listOf("debugRuntimeClasspath", "releaseRuntimeClasspath").map { name ->
        configurations.named(name).flatMap { it.incoming.resolutionResult.rootComponent }
    }
    doLast {
        val libraries = graphs.flatMap { root -> root.get().dependencies.filter { !it.isConstraint }.map { it.requested.displayName } }
        if (libraries.isNotEmpty()) throw GradleException("外壳运行时不许有第三方库：$libraries")
    }
}

tasks.named("check") {
    dependsOn(checkstyleJava, checkNoRuntimeLibraries)
}
