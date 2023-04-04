#!/usr/bin/env bash
set -euo pipefail

# This script will package the CLI for mac and upload a release asset
# to the latest release at https://github.com/iron-fish/homebrew-brew
# then prints out some extra steps to make the release public
if [ -z "$1" ]; then
    echo "No source path provided"
    exit 1
fi
if [ -z "$1" ]; then
    echo "No destination path provided"
    exit 1
fi
if [ -z "${AWS_ACCESS_KEY_ID-}" ]; then
    echo "Set AWS_ACCESS_KEY_ID before running"
    exit 1
fi
if [ -z "${AWS_SECRET_ACCESS_KEY-}" ]; then
    echo "Set AWS_SECRET_ACCESS_KEY before running"
    exit 1
fi

UPLOAD_URL=s3://release/$2


echo "source path:  $1"
echo "dest path:  $2"
echo "UPLOAD URL:   $UPLOAD_URL"
echo ""

if aws s3api head-object --bucket release --endpoint-url https://a93bebf26da4c2fe205f71c896afcf89.r2.cloudflarestorage.com --key $2 > /dev/null 2>&1 ; then
    echo "Release already uploaded"
    exit 1
fi

echo "Uploading $1 to $UPLOAD_URL"
aws s3 cp $1 $UPLOAD_URL --endpoint-url https://a93bebf26da4c2fe205f71c896afcf89.r2.cloudflarestorage.com
