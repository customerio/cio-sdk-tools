#!/bin/bash

# Script to test the doctor command on multiple apps
# Usage:
#   ./scripts/test-doctor.sh                # Run local version (overwrites results)
#   ./scripts/test-doctor.sh --global       # Run global version (npx cio-sdk-tools@latest)
#   ./scripts/test-doctor.sh --compare      # Run both and save to separate files
#   ./scripts/test-doctor.sh --timestamped  # Append timestamp to filenames
#   ./scripts/test-doctor.sh --clean        # Remove all results

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
USE_TIMESTAMP=false
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
      USE_TIMESTAMP=true  # Compare mode always uses timestamps
      shift
      ;;
    --timestamped)
      USE_TIMESTAMP=true
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
      echo "Usage: $0 [--global] [--compare] [--timestamped] [--clean] [--config <path>]"
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
      "name": "iOS-SPM",
      "path": "../customerio-ios/Apps/APN-UIKit",
      "framework": "iOS"
    },
    {
      "name": "iOS-CocoaPods",
      "path": "../customerio-ios/Apps/CocoaPods-FCM",
      "framework": "iOS"
    },
    {
      "name": "iOS-VisionOS",
      "path": "../customerio-ios/Apps/VisionOS",
      "framework": "iOS"
    },
    {
      "name": "Flutter",
      "path": "../customerio-flutter/apps/amiapp_flutter",
      "framework": "Flutter"
    },
    {
      "name": "React-Native",
      "path": "../customerio-reactnative/example",
      "framework": "React Native"
    },
    {
      "name": "Expo",
      "path": "../customerio-expo-plugin/test-app",
      "framework": "React Native"
    },
    {
      "name": "Android-Kotlin",
      "path": "../customerio-android/samples/kotlin_compose",
      "framework": "Android"
    },
    {
      "name": "Android-Java",
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

# Generate timestamp if needed
TIMESTAMP=""
if [ "$USE_TIMESTAMP" = true ]; then
  TIMESTAMP="-$(date +"%Y%m%d-%H%M%S")"
fi

# Function to run doctor on a single app
run_doctor() {
  local app_name=$1
  local app_path=$2
  local framework=$3
  local use_global=$4
  local output_suffix=$5

  local output_file="${RESULTS_DIR}/${app_name}${output_suffix}.txt"

  echo -e "${BLUE}Running: ${app_name} (${framework})${NC}"
  echo "  Path: ${app_path}"

  if [ "$use_global" = true ]; then
    echo "  Command: npx cio-sdk-tools@latest doctor"
    npx cio-sdk-tools@latest doctor "$app_path" > "$output_file" 2>&1 || true
  else
    echo "  Command: npm start doctor (local)"
    npm start doctor "$app_path" > "$output_file" 2>&1 || true
  fi

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

  # Create summary diff file
  DIFF_SUMMARY="${RESULTS_DIR}/comparison-summary${TIMESTAMP}.txt"

  # Run both local and global for each app
  while IFS= read -r app; do
    name=$(echo "$app" | jq -r '.name')
    path=$(echo "$app" | jq -r '.path')
    framework=$(echo "$app" | jq -r '.framework')

    echo -e "${BLUE}▶ ${name}${NC}"
    echo "-----------------------------------"

    # Run local version
    echo -e "${YELLOW}LOCAL version:${NC}"
    run_doctor "$name" "$path" "$framework" false "-local${TIMESTAMP}"

    # Run global version
    echo -e "${YELLOW}GLOBAL version:${NC}"
    run_doctor "$name" "$path" "$framework" true "-global${TIMESTAMP}"

    # Generate diff for this app
    LOCAL_FILE="${RESULTS_DIR}/${name}-local${TIMESTAMP}.txt"
    GLOBAL_FILE="${RESULTS_DIR}/${name}-global${TIMESTAMP}.txt"
    DIFF_FILE="${RESULTS_DIR}/${name}-diff${TIMESTAMP}.txt"

    echo "━━━ ${name} ━━━" >> "$DIFF_SUMMARY"
    if diff "$LOCAL_FILE" "$GLOBAL_FILE" > "$DIFF_FILE" 2>&1; then
      echo "✓ No differences" >> "$DIFF_SUMMARY"
      echo "✓ No differences" > "$DIFF_FILE"
    else
      cat "$DIFF_FILE" >> "$DIFF_SUMMARY"
    fi
    echo "" >> "$DIFF_SUMMARY"
    echo ""

  done <<< "$APPS"

  echo -e "${GREEN}==================================================${NC}"
  echo -e "${GREEN}  Comparison complete!${NC}"
  echo -e "${GREEN}==================================================${NC}"
  echo ""
  echo "View differences:"
  echo -e "  ${BLUE}cat ${DIFF_SUMMARY}${NC}"

elif [ "$USE_GLOBAL" = true ]; then
  echo -e "${YELLOW}Mode: Global version (npx cio-sdk-tools@latest)${NC}"
  echo ""

  while IFS= read -r app; do
    name=$(echo "$app" | jq -r '.name')
    path=$(echo "$app" | jq -r '.path')
    framework=$(echo "$app" | jq -r '.framework')

    run_doctor "$name" "$path" "$framework" true "${TIMESTAMP}"
  done <<< "$APPS"

else
  echo -e "${YELLOW}Mode: Local version (overwrites previous results)${NC}"
  echo ""

  while IFS= read -r app; do
    name=$(echo "$app" | jq -r '.name')
    path=$(echo "$app" | jq -r '.path')
    framework=$(echo "$app" | jq -r '.framework')

    run_doctor "$name" "$path" "$framework" false "${TIMESTAMP}"
  done <<< "$APPS"
fi

echo -e "${GREEN}==================================================${NC}"
echo -e "${GREEN}  All done!${NC}"
echo -e "${GREEN}==================================================${NC}"
echo ""
echo "Results saved in: ${RESULTS_DIR}/"
echo ""
echo "View results:"
echo -e "  ${BLUE}cat ${RESULTS_DIR}/<app-name>.txt${NC}"
echo -e "  ${BLUE}ls -la ${RESULTS_DIR}/${NC}"
