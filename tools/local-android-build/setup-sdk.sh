#!/usr/bin/env bash
# Install a LINUX Android SDK into the volume mounted at /opt/android-sdk.
#
# The host's SDK cannot be reused: it is a Windows install, so build-tools contains
# only aapt.exe/d8.bat and the NDK ships only toolchains/llvm/prebuilt/windows-x86_64.
# Mounted into a Linux container, AGP finds no `aapt` and reports build-tools as
# "corrupted", which is what the first attempt died on.
#
# Run once. The volume keeps it for later builds.
set -euo pipefail

SDK=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"

mkdir -p "$SDK/cmdline-tools"
cd /tmp

if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "=== downloading cmdline-tools ==="
  curl -sSL -o cmdtools.zip \
    https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q cmdtools.zip -d "$SDK/cmdline-tools"
  mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -f cmdtools.zip
fi

export PATH="$SDK/cmdline-tools/latest/bin:$PATH"

echo "=== accepting licences ==="
yes | sdkmanager --licenses > /dev/null 2>&1 || true

echo "=== installing packages (this is the slow part) ==="
sdkmanager --install \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;36.0.0" \
  "ndk;27.1.12297006" \
  "cmake;3.22.1"

echo
echo "=== installed ==="
ls "$SDK"
echo "ndk:      $(ls "$SDK/ndk" 2>/dev/null | tr '\n' ' ')"
echo "platform: $(ls "$SDK/platforms" 2>/dev/null | tr '\n' ' ')"
echo "ndk host toolchains: $(ls "$SDK/ndk/27.1.12297006/toolchains/llvm/prebuilt/" 2>/dev/null | tr '\n' ' ')"
echo "aapt present: $([ -x "$SDK/build-tools/36.0.0/aapt" ] && echo yes || echo NO)"
