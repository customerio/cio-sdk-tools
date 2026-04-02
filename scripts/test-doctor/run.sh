#!/bin/bash

# Script to test the doctor command on multiple apps
# Usage:
#   ./scripts/test-doctor.sh                # Run local version
#   ./scripts/test-doctor.sh --global       # Run global version (npx cio-sdk-tools@latest)
#   ./scripts/test-doctor.sh --compare      # Run both and generate diffs
#   ./scripts/test-doctor.sh --clean        # Remove all results before running

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default settings
USE_GLOBAL=false
COMPARE_MODE=false
CLEAN_MODE=false
CONFIG_FILE=".testapps.doctor.json"
RESULTS_DIR="results/doctor"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --global)
      USE_GLOBAL=true
      shift
      ;;
    --compare)
      COMPARE_MODE=true
      shift
      ;;
    --clean)
      CLEAN_MODE=true
      shift
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Usage: $0 [--global] [--compare] [--clean] [--config <path>]"
      exit 1
      ;;
  esac
done

# Handle clean mode
if [ "$CLEAN_MODE" = true ]; then
  if [ -d "$RESULTS_DIR" ]; then
    echo -e "${YELLOW}Cleaning results directory: ${RESULTS_DIR}${NC}"
    rm -rf "$RESULTS_DIR"
    echo -e "${GREEN}✓ Cleaned${NC}"
    echo ""
  fi
  # Continue with test run (don't exit)
fi

# Check if config file exists, create from example in README if not
if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "${YELLOW}Config file '$CONFIG_FILE' not found${NC}"
  echo -e "${BLUE}Creating '$CONFIG_FILE' with example configuration...${NC}"

  cat > "$CONFIG_FILE" << 'EOF'
{
  "apps": [
    {
      "name": "ios_spm",
      "path": "../customerio-ios/Apps/APN-UIKit",
      "framework": "iOS"
    },
    {
      "name": "ios_cocoapods",
      "path": "../customerio-ios/Apps/CocoaPods-FCM",
      "framework": "iOS"
    },
    {
      "name": "ios_visionos",
      "path": "../customerio-ios/Apps/VisionOS",
      "framework": "iOS"
    },
    {
      "name": "flutter",
      "path": "../customerio-flutter/apps/amiapp_flutter",
      "framework": "Flutter"
    },
    {
      "name": "react_native",
      "path": "../customerio-reactnative/example",
      "framework": "React Native"
    },
    {
      "name": "expo",
      "path": "../customerio-expo-plugin/test-app",
      "framework": "React Native"
    },
    {
      "name": "android_kotlin",
      "path": "../customerio-android/samples/kotlin_compose",
      "framework": "Android"
    },
    {
      "name": "android_java",
      "path": "../customerio-android/samples/java_layout",
      "framework": "Android"
    }
  ]
}
EOF

  echo -e "${GREEN}✓ Created $CONFIG_FILE${NC}"
  echo -e "${YELLOW}Note: Update the paths in $CONFIG_FILE to match your local environment${NC}"
  echo ""
fi

# Create results directory
mkdir -p "$RESULTS_DIR"

# Generate timestamp for section headings
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

# Function to run doctor on a single app and append to its file
run_doctor() {
  local app_name=$1
  local app_path=$2
  local framework=$3
  local use_global=$4

  local output_file="${RESULTS_DIR}/${app_name}.md"

  echo -e "${BLUE}Running: ${app_name} (${framework})${NC}"
  echo "  Path: ${app_path}"

  # Add timestamp section heading
  echo "## ${TIMESTAMP}" >> "$output_file"
  echo "" >> "$output_file"

  if [ "$use_global" = true ]; then
    echo "  Command: npx cio-sdk-tools@latest doctor"
    echo '```' >> "$output_file"
    npx cio-sdk-tools@latest doctor "$app_path" >> "$output_file" 2>&1 || true
    echo '```' >> "$output_file"
  else
    echo "  Command: npm start --silent -- doctor (local)"
    echo '```' >> "$output_file"
    npm start --silent -- doctor "$app_path" >> "$output_file" 2>&1 || true
    echo '```' >> "$output_file"
  fi

  echo "" >> "$output_file"
  echo -e "  ${GREEN}✓${NC} Output saved to: ${output_file}"
  echo ""
}

# Read apps from config
APPS=$(jq -r '.apps[] | @json' "$CONFIG_FILE")

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}  CIO SDK Doctor - Local Testing${NC}"
echo -e "${BLUE}==================================================${NC}"
echo ""

if [ "$COMPARE_MODE" = true ]; then
  echo -e "${YELLOW}Mode: Compare local vs global${NC}"
  echo ""

  # Summary file (prefixed with _ to sort first)
  COMPARISON_SUMMARY="${RESULTS_DIR}/_summary.md"

  # Add timestamp section heading to summary
  echo "## ${TIMESTAMP}" >> "$COMPARISON_SUMMARY"
  echo "" >> "$COMPARISON_SUMMARY"

  # Run both local and global for each app, saving all output in a single file per app
  while IFS= read -r app; do
    name=$(echo "$app" | jq -r '.name')
    path=$(echo "$app" | jq -r '.path')
    framework=$(echo "$app" | jq -r '.framework')

    echo -e "${BLUE}▶ ${name}${NC}"
    echo "-----------------------------------"

    APP_FILE="${RESULTS_DIR}/${name}.md"

    # Run local version (capture to temp file for diff)
    echo -e "${YELLOW}LOCAL version:${NC}"
    LOCAL_TMP=$(mktemp)
    echo "  Path: ${path}"
    echo "  Command: npm start --silent -- doctor (local)"
    npm start --silent -- doctor "$path" > "$LOCAL_TMP" 2>&1 || true
    echo -e "  ${GREEN}✓${NC} Done"
    echo ""

    # Run global version (capture to temp file for diff)
    echo -e "${YELLOW}GLOBAL version:${NC}"
    GLOBAL_TMP=$(mktemp)
    echo "  Path: ${path}"
    echo "  Command: npx cio-sdk-tools@latest doctor"
    npx cio-sdk-tools@latest doctor "$path" > "$GLOBAL_TMP" 2>&1 || true
    echo -e "  ${GREEN}✓${NC} Done"
    echo ""

    # Append timestamped section to app file
    echo "## ${TIMESTAMP}" >> "$APP_FILE"
    echo "Path: ${path}" >> "$APP_FILE"
    echo "" >> "$APP_FILE"

    echo "### LOCAL" >> "$APP_FILE"
    echo '```' >> "$APP_FILE"
    cat "$LOCAL_TMP" >> "$APP_FILE"
    echo '```' >> "$APP_FILE"
    echo "" >> "$APP_FILE"

    echo "### GLOBAL" >> "$APP_FILE"
    echo '```' >> "$APP_FILE"
    cat "$GLOBAL_TMP" >> "$APP_FILE"
    echo '```' >> "$APP_FILE"
    echo "" >> "$APP_FILE"

    echo "### DIFF" >> "$APP_FILE"
    echo '```diff' >> "$APP_FILE"
    if diff -u --label local --label global "$LOCAL_TMP" "$GLOBAL_TMP" >> "$APP_FILE" 2>&1; then
      echo "✓ No differences" >> "$APP_FILE"
    fi
    echo '```' >> "$APP_FILE"
    echo "" >> "$APP_FILE"

    # Append to comparison summary
    echo "### ${name}" >> "$COMPARISON_SUMMARY"
    echo '```diff' >> "$COMPARISON_SUMMARY"
    if diff "$LOCAL_TMP" "$GLOBAL_TMP" > /dev/null 2>&1; then
      echo "✓ No differences" >> "$COMPARISON_SUMMARY"
    else
      diff -u --label local --label global "$LOCAL_TMP" "$GLOBAL_TMP" >> "$COMPARISON_SUMMARY" 2>&1 || true
    fi
    echo '```' >> "$COMPARISON_SUMMARY"
    echo "" >> "$COMPARISON_SUMMARY"

    # Cleanup temp files
    rm -f "$LOCAL_TMP" "$GLOBAL_TMP"

    echo -e "  ${GREEN}✓${NC} Output saved to: ${APP_FILE}"
    echo ""

  done <<< "$APPS"

  echo -e "${GREEN}==================================================${NC}"
  echo -e "${GREEN}  Comparison complete!${NC}"
  echo -e "${GREEN}==================================================${NC}"
  echo ""
  echo "View differences:"
  echo -e "  ${BLUE}cat ${COMPARISON_SUMMARY}${NC}"

elif [ "$USE_GLOBAL" = true ]; then
  echo -e "${YELLOW}Mode: Global version (npx cio-sdk-tools@latest)${NC}"
  echo ""

  while IFS= read -r app; do
    name=$(echo "$app" | jq -r '.name')
    path=$(echo "$app" | jq -r '.path')
    framework=$(echo "$app" | jq -r '.framework')

    run_doctor "$name" "$path" "$framework" true
  done <<< "$APPS"

else
  echo -e "${YELLOW}Mode: Local version${NC}"
  echo ""

  while IFS= read -r app; do
    name=$(echo "$app" | jq -r '.name')
    path=$(echo "$app" | jq -r '.path')
    framework=$(echo "$app" | jq -r '.framework')

    run_doctor "$name" "$path" "$framework" false
  done <<< "$APPS"
fi

echo -e "${GREEN}==================================================${NC}"
echo -e "${GREEN}  All done!${NC}"
echo -e "${GREEN}==================================================${NC}"
echo ""
echo "Results saved in: ${RESULTS_DIR}/"
echo ""
echo "View results:"
echo -e "  ${BLUE}cat ${RESULTS_DIR}/<app_name>.md${NC}"
echo -e "  ${BLUE}ls -la ${RESULTS_DIR}/${NC}"
