#!/bin/bash

# Script to create a zip file of the repository
# This uses git archive to create a clean archive respecting .gitignore

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "Error: git is not installed or not in PATH"
    exit 1
fi

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree &> /dev/null; then
    echo "Error: Not in a git repository"
    exit 1
fi

# Get repository name from git (or use command-line argument)
if [ -n "$1" ]; then
    REPO_NAME="$1"
else
    REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
fi

OUTPUT_FILE="${REPO_NAME}.zip"

echo "Creating zip file: ${OUTPUT_FILE}"
git archive --format=zip --output="${OUTPUT_FILE}" HEAD

if [ $? -eq 0 ]; then
    echo "Successfully created ${OUTPUT_FILE}"
    ls -lh "${OUTPUT_FILE}"
else
    echo "Failed to create zip file"
    exit 1
fi
