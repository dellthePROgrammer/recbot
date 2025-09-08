# Use official Node.js image for backend and build
FROM node:18-slim as build

WORKDIR /app

# Install backend dependencies
COPY backend/package.json ./backend/
RUN cd backend && npm install


# Install frontend dependencies and build
COPY frontend/package.json ./frontend/
COPY frontend ./frontend
RUN cd frontend && npm install --legacy-peer-deps && npx react-scripts build

# Copy backend source
COPY backend ./backend

# Final image for running app and sshfs
FROM node:18-slim


# Install rclone for Backblaze B2 mounting
RUN apt-get update && apt-get install -y curl fuse3 ffmpeg s3fs \
	&& curl -O https://downloads.rclone.org/rclone-current-linux-amd64.deb \
	&& dpkg -i rclone-current-linux-amd64.deb \
	&& rm rclone-current-linux-amd64.deb \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app


# Copy backend and frontend build from build stage
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend/build ./frontend/build


# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV WAV_DIR=/data/wav

EXPOSE 4000

ENTRYPOINT ["/entrypoint.sh"]
