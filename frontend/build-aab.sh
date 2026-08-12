#!/bin/bash
set -e

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================================="
echo "🚀 1. Building FoodAnalyzer Angular Production App..."
echo "================================================="
cd "$FRONTEND_DIR"
npm run build

echo "================================================="
echo "⚡ 2. Syncing Assets to Capacitor Native Android..."
echo "================================================="
npx cap sync android

echo "================================================="
echo "🤖 3. Compiling Release Android App Bundle (.aab) via Gradle..."
echo "================================================="
export JAVA_HOME="/home/mht/jdk21"
export ANDROID_HOME="/home/mht/Android/Sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

cd "$FRONTEND_DIR/android"
./gradlew bundleRelease

AAB_PATH="$FRONTEND_DIR/android/app/build/outputs/bundle/release/app-release.aab"
if [ ! -f "$AAB_PATH" ]; then
    AAB_PATH="$FRONTEND_DIR/android/app/build/outputs/bundle/release/app-release-unsigned.aab"
fi

if [ -f "$AAB_PATH" ]; then
    echo ""
    echo "================================================="
    echo "🎉 AAB BUILD SUCCESSFUL!"
    echo "📦 AAB File Location: $AAB_PATH"
    echo "================================================="
else
    echo "❌ AAB build failed."
    exit 1
fi
