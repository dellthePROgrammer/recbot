#!/bin/sh
set -e

# Required env vars: B2_ACCOUNT, B2_KEY, B2_BUCKET, WAV_DIR (local mount)
if [ "$STORAGE_TYPE" = "b2" ]; then
  if [ -z "$B2_ACCOUNT" ] || [ -z "$B2_KEY" ] || [ -z "$B2_BUCKET" ] || [ -z "$SFTP_USER" ] || [ -z "$SFTP_PASS" ] ; then
    echo "Missing Backblaze B2 credentials or bucket. Set B2_ACCOUNT, B2_KEY, B2_BUCKET, SFTP_USER, and SFTP_PASS environment variables."
    exit 1
  fi
elif [ "$STORAGE_TYPE" = "aws" ]; then
  if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$AWS_BUCKET" ] || [ -z "$AWS_REGION" ]; then
    echo "Missing AWS S3 credentials or bucket. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and AWS_BUCKET environment variables."
    exit 1
  fi
else
  echo "Unsupported storage type: $STORAGE_TYPE"
  exit 1
fi

# Create rclone config directory and file
if [ "$STORAGE_TYPE" = "b2" ]; then
  mkdir -p /root/.config/rclone
  cat <<EOF > /root/.config/rclone/rclone.conf
[b2remote]
type = b2
account = $B2_ACCOUNT
key = $B2_KEY
EOF
fi
echo "WAV_DIR is set to: $WAV_DIR"

# Create mount point if it doesn't exist
mkdir -p "$WAV_DIR"

if [ "$STORAGE_TYPE" = "b2" ]; then
  # Mount B2 bucket using rclone
  rclone mount b2remote:$B2_BUCKET "$WAV_DIR" --allow-other --vfs-cache-mode writes &
  sleep 5
fi

if [ "$STORAGE_TYPE" = "aws" ]; then
  # Mount AWS S3 bucket using s3fs
  mkdir -p /etc/s3fs
  echo "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" > /etc/s3fs/credentials
  chmod 600 /etc/s3fs/credentials
  s3fs $AWS_BUCKET "$WAV_DIR" -o passwd_file=/etc/s3fs/credentials -o allow_other 2>&1 | tee /tmp/s3fs.log &
  sleep 5
fi
if ! mountpoint -q "$WAV_DIR"; then
  echo "Mount failed: $WAV_DIR is not a valid mount point"
  cat /tmp/s3fs.log
  exit 1
fi
mkdir -p "$WAV_DIR/cache"

if [ "$ENABLE_SFTP" = "true" ] && [ "$STORAGE_TYPE" = "b2" ] && [ -n "$SFTP_USER" ] && [ -n "$SFTP_PASS" ]; then
  rclone serve sftp b2remote:$B2_BUCKET --addr :2222 --config /root/.config/rclone/rclone.conf --user $SFTP_USER --pass $SFTP_PASS &
fi

# Start backend server
cd /app/backend
exec npm start
