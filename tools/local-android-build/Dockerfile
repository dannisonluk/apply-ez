# A minimal Linux toolchain for building the Android app locally.
#
# Why this exists: `eas build --local` refuses to run on Windows at all
# ("Unsupported platform, macOS or Linux is required"), and the native Windows
# Gradle build dies on MAX_PATH — the safeareacontext CMake object path is 385
# characters against a 260 limit, and even a zero-length staging directory leaves it
# at 280. Inside a Linux container the project is at /app, so the whole class of
# problem disappears.
#
# The Android SDK is NOT installed here — it is bind-mounted from the host, which
# already has platform 36, build-tools 36, cmake 3.22.1 and NDK 27.1.12297006, exactly
# what React Native 0.81 wants. That saves a multi-gigabyte download.
FROM node:20-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless \
      unzip \
      curl \
      git \
      libncurses5 \
      libtinfo5 \
 || apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless unzip curl git libncurses6 \
 && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="$JAVA_HOME/bin:$PATH"

# Gradle downloads itself and the dependency graph on first use; keep that out of the
# project directory so a rebuild does not redo it.
ENV GRADLE_USER_HOME=/root/.gradle

WORKDIR /app
