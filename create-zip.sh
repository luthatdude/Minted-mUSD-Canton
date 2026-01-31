#!/bin/bash

# Script to create a zip file of the repository
# This uses git archive to create a clean archive respecting .gitignore

REPO_NAME="Minted-mUSD-Canton"
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
