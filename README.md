# RecBot - Audio Recording Management System

**Version: v1.1.0**

RecBot is a comprehensive web-based audio recording management system designed to browse, filter, search, and play telephony recordings stored in cloud storage. It provides a modern, responsive interface for managing large datasets of audio files with advanced filtering and pagination capabilities.

## Features

### 🎵 Audio Management
- **Stream Audio Files**: Play recordings directly in the browser with seek support
- **Format Support**: Automatically transcodes telephony formats to browser-compatible PCM
- **Range Requests**: Supports audio scrubbing and seeking with HTTP Range headers
- **S3 Caching**: Transcoded files are cached in S3 for improved performance

### 🔍 Advanced Filtering & Search
- **Date Range Filtering**: Filter recordings by specific dates or date ranges
- **Phone Number Search**: Find recordings by caller phone number
- **Email Search**: Search by agent email address
- **Duration Filtering**: Filter by minimum or maximum call duration
- **Time-based Filtering**: Filter by time of day with multiple modes (range, older than, newer than)

### 📊 Data Management
- **Backend Pagination**: Efficient offset-based pagination for large datasets (10,000+ files)
- **Sorting**: Click any column header to sort by date, time, phone, email, or duration
- **Real-time Filtering**: All filters apply immediately without page refresh
- **Flexible Page Sizes**: Choose from 25, 50, 100, 250, 500, or 1000 files per page

### 🎨 User Interface
- **Dark/Light Mode**: Toggle between themes
- **Responsive Design**: Works on desktop and mobile devices
- **Material UI**: Modern, accessible interface components
- **Loading States**: Visual feedback during data loading

### 🔐 Authentication
- **Microsoft OAuth**: Secure login with Microsoft accounts
- **BetterAuth Integration**: Modern authentication framework
- **Session Management**: Secure session handling

### ☁️ Cloud Storage
- **AWS S3 Support**: Store and retrieve files from Amazon S3
- **Backblaze B2 Support**: Alternative cloud storage option
- **S3FS Mounting**: Files accessible as local filesystem
- **SFTP Access**: Optional SFTP server for file access

## Architecture

### Backend (Node.js/Express)
- **Port**: 4000
- **Database**: SQLite with BetterAuth
- **Audio Processing**: FFmpeg for format conversion
- **Cloud APIs**: AWS SDK v3, Rclone for B2

### Frontend (React)
- **Framework**: React 18 with Material UI
- **Date Handling**: Day.js with timezone support
- **HTTP Client**: Fetch API with error handling
- **State Management**: React hooks

### Infrastructure
- **Containerization**: Docker with multi-stage builds
- **Reverse Proxy**: Traefik with SSL termination
- **CDN**: Cloudflare integration
- **Orchestration**: Docker Compose

## Installation

### Prerequisites
- Docker and Docker Compose
- AWS S3 bucket OR Backblaze B2 bucket
- Domain name (for production)

### Environment Variables

Create a `.env` file in the root directory:

```env
# Storage Configuration (choose one)
STORAGE_TYPE=aws  # or "b2" for Backblaze B2

# AWS S3 Configuration
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_BUCKET=your-bucket-name
AWS_REGION=us-east-1

# Backblaze B2 Configuration (if using B2)
B2_ACCOUNT=your_b2_account_id
B2_KEY=your_b2_application_key
B2_BUCKET=your-b2-bucket-name

# SFTP Configuration (optional)
ENABLE_SFTP=true
SFTP_USER=your_sftp_username
SFTP_PASS=your_sftp_password

# Authentication
BETTER_AUTH_SECRET=your-secret-key-here
BETTER_AUTH_URL=https://your-domain.com

# Microsoft OAuth
MICROSOFT_CLIENT_ID=your_microsoft_client_id
MICROSOFT_CLIENT_SECRET=your_microsoft_client_secret

# File Storage
WAV_DIR=/data/wav
```

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone https://github.com/dellthePROgrammer/recbot.git
   cd recbot
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Build and start**:
   ```bash
   docker-compose up -d
   ```

4. **Access the application**:
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:4000

### Production Docker Hub Image

Use the pre-built image from Docker Hub:

```yaml
version: '3.8'
services:
  recbot:
    image: ghostreaper69/recbot:v1.1.0
    # or use: ghostreaper69/recbot:latest
    ports:
      - "4000:4000"
    environment:
      - STORAGE_TYPE=aws
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - AWS_BUCKET=${AWS_BUCKET}
      - AWS_REGION=${AWS_REGION}
    volumes:
      - wav_data:/data/wav
      - db_data:/root/db
```

## Usage

### File Organization

RecBot expects files to be organized in the following structure:
```
recordings/
├── 9_26_2025/
│   ├── 2012055255 by user@domain.com @ 9_47_43 AM_18600.wav
│   ├── 2012079443 by user@domain.com @ 9_33_50 AM_4200.wav
│   └── ...
├── 9_27_2025/
│   └── ...
```

**Filename Format**: `{phone_number} by {email} @ {time}_{duration_ms}.wav`
- Phone number: Caller's phone number
- Email: Agent's email address  
- Time: Call time in `H_MM_SS AM/PM` format
- Duration: Call duration in milliseconds

### API Endpoints

#### Get Files
```http
GET /api/wav-files?dateStart=9_26_2025&dateEnd=9_27_2025&offset=0&limit=25
```

**Parameters**:
- `dateStart`, `dateEnd`: Date range in M_D_YYYY format
- `offset`, `limit`: Pagination parameters
- `phone`: Filter by phone number (partial match)
- `email`: Filter by email (partial match)
- `durationMin`: Minimum duration in seconds
- `durationMode`: "min" or "max"
- `timeStart`, `timeEnd`: Time range in "hh:mm:ss A" format
- `timeMode`: "range", "Older", or "Newer"
- `sortColumn`: "date", "time", "phone", "email", "durationMs"
- `sortDirection`: "asc" or "desc"

#### Stream Audio
```http
GET /api/wav-files/recordings/9_26_2025/filename.wav
```

Supports HTTP Range requests for audio seeking.

### Authentication Setup

1. **Register Microsoft App**:
   - Go to Azure Portal > App Registrations
   - Create new application
   - Add redirect URI: `https://your-domain.com/api/auth/callback/microsoft`
   - Note Client ID and create Client Secret

2. **Configure Environment**:
   ```env
   MICROSOFT_CLIENT_ID=your_client_id
   MICROSOFT_CLIENT_SECRET=your_client_secret
   BETTER_AUTH_URL=https://your-domain.com
   ```

## Development

### Local Development

1. **Install dependencies**:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```

2. **Start development servers**:
   ```bash
   # Backend (port 4000)
   cd backend && npm start
   
   # Frontend (port 3000)
   cd frontend && npm start
   ```

### Building Docker Image

```bash
# Build with version tag
docker build -t ghostreaper69/recbot:v1.1.0 .

# Push to Docker Hub
docker push ghostreaper69/recbot:v1.1.0
```

## Performance

### Optimizations
- **Backend Filtering**: All filtering and sorting happens server-side
- **Offset Pagination**: Efficient pagination for datasets with 10,000+ files
- **S3 Caching**: Transcoded audio files cached in S3
- **Lazy Loading**: Files loaded only when date range is selected

### Scaling Considerations
- Backend handles up to 10,000+ files efficiently
- Pagination prevents frontend memory issues
- S3 API calls scale better than filesystem operations
- Consider CDN for audio file delivery in high-traffic scenarios

## Troubleshooting

### Common Issues

**Files not loading**:
- Check S3/B2 credentials and bucket permissions
- Verify file structure matches expected format
- Check Docker container logs: `docker-compose logs recbot`

**Authentication not working**:
- Verify Microsoft OAuth configuration
- Check redirect URIs match exactly
- Ensure BETTER_AUTH_URL is accessible

**Audio not playing**:
- Check FFmpeg installation in container
- Verify audio file formats are supported
- Check browser console for errors

### Logs

```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f recbot
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For issues and questions:
- Create an issue on GitHub
- Check the troubleshooting section
- Review Docker container logs

## Changelog

### v1.1.0
- ✅ Backend pagination and filtering for performance
- ✅ Advanced sorting by all columns
- ✅ Immediate filter updates (fixed async state issues)
- ✅ Enhanced files per page options (up to 1000)
- ✅ Improved error handling and loading states
- ✅ Docker Hub image publishing

### v1.0.x
- Initial release with basic functionality
- S3 and B2 storage support
- Microsoft authentication
- Audio streaming with transcoding
- Basic filtering and search

---

**Built with ❤️ for efficient audio recording management**