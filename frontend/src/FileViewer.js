import React, { useEffect, useState } from "react";
import { useUser, useAuth } from '@clerk/clerk-react';
import {
  Container,
  Typography,
  IconButton,
  Paper,
  Box,
  Pagination,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Grid,
  TableSortLabel,
  InputAdornment,
  Switch,
  FormControlLabel,
  CssBaseline,
  Select,
  MenuItem,
  CircularProgress,
  LinearProgress,
  FormControl,
  InputLabel,
  Button,
  Alert,
  Slider,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import FastForwardIcon from "@mui/icons-material/FastForward";
import FastRewindIcon from "@mui/icons-material/FastRewind";
import RefreshIcon from "@mui/icons-material/Refresh";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import dayjs from "dayjs";

function parseFileInfo(file) {
  const cleanFile = file.startsWith('recordings/') ? file.slice('recordings/'.length) : file;
  const [folder, filename] = cleanFile.split('/');
  if (!folder || !filename) return { file, date: '', phone: '', email: '', time: '', durationMs: 0 };
  const date = folder.replace(/_/g, '/');
  const phoneMatch = filename.match(/^(\d+)/);
  const phone = phoneMatch ? phoneMatch[1] : '';
  const emailMatch = filename.match(/by ([^@]+@[^ ]+)/);
  const email = emailMatch ? emailMatch[1] : '';
  const timeMatch = filename.match(/@ ([\d_]+ [AP]M)/);
  const time = timeMatch ? timeMatch[1].replace(/_/g, ':') : '';
  const durationMatch = filename.match(/_(\d+)\.wav$/);
  const durationMs = durationMatch ? parseInt(durationMatch[1], 10) : 0;
  return { file, date, phone, email, time, durationMs };
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function FileViewer({ darkMode }) {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const [files, setFiles] = useState([]);
  const [playing, setPlaying] = useState(null);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.5); // Default volume 50%

  const [calendarDateStart, setCalendarDateStart] = useState(null);
  const [calendarDateEnd, setCalendarDateEnd] = useState(null);
  const [timePickerStart, setTimePickerStart] = useState(null);
  const [timePickerEnd, setTimePickerEnd] = useState(null);
  const [phoneFilter, setPhoneFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [sortColumn, setSortColumn] = useState("date");
  const [sortDirection, setSortDirection] = useState("asc");
  const [durationMin, setDurationMin] = useState("");
  const [durationMode, setDurationMode] = useState("min");
  const [timeMode, setTimeMode] = useState("range");
  const [error500, setError500] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filesPerPage, setFilesPerPage] = useState(25);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [currentOffset, setCurrentOffset] = useState(0);

  // Get user role and email for filtering
  const userRole = user?.publicMetadata?.role;
  const userEmail = user?.emailAddresses?.[0]?.emailAddress;
  const isAdmin = userRole === 'admin';

  // Fetch files only when a date is selected or changed
  const fetchFiles = (start, end, offset = 0, limit = filesPerPage, customSortColumn = null, customSortDirection = null, customDurationMin = null, customPhoneFilter = null, customEmailFilter = null, customTimePickerStart = null, customTimePickerEnd = null, customTimeMode = null) => {
    if (!start) return;
    setLoading(true);
    setError500(false);
    
    let url = `/api/wav-files?dateStart=${encodeURIComponent(dayjs(start).format("M_D_YYYY"))}`;
    if (end) url += `&dateEnd=${encodeURIComponent(dayjs(end).format("M_D_YYYY"))}`;
    
    // Add role-based email filtering for members
    const effectiveEmailFilter = isAdmin 
      ? (customEmailFilter !== null ? customEmailFilter : emailFilter)
      : userEmail; // Members can only see their own files
    
    url += `&offset=${offset}&limit=${limit}`;
    url += `&sortBy=${customSortColumn || sortColumn}&sortOrder=${customSortDirection || sortDirection}`;
    
    if (customDurationMin !== null && customDurationMin !== "") {
      url += `&durationMin=${encodeURIComponent(customDurationMin)}&durationMode=${durationMode}`;
    } else if (durationMin !== "") {
      url += `&durationMin=${encodeURIComponent(durationMin)}&durationMode=${durationMode}`;
    }
    
    if (customPhoneFilter !== null && customPhoneFilter !== "") {
      url += `&phone=${encodeURIComponent(customPhoneFilter)}`;
    } else if (phoneFilter !== "") {
      url += `&phone=${encodeURIComponent(phoneFilter)}`;
    }
    
    if (effectiveEmailFilter !== "") {
      url += `&email=${encodeURIComponent(effectiveEmailFilter)}`;
    }
    
    const currentTimeMode = customTimeMode !== null ? customTimeMode : timeMode;
    if (currentTimeMode === "range") {
      const startTime = customTimePickerStart !== null ? customTimePickerStart : timePickerStart;
      const endTime = customTimePickerEnd !== null ? customTimePickerEnd : timePickerEnd;
      if (startTime) url += `&timeStart=${encodeURIComponent(dayjs(startTime).format("h:mm A"))}`;
      if (endTime) url += `&timeEnd=${encodeURIComponent(dayjs(endTime).format("h:mm A"))}`;
    }

    const makeRequest = async () => {
      const token = await getToken();
      return fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    };

    makeRequest()
      .then((res) => {
        if (res.status === 500) {
          setError500(true);
          return { files: [], totalCount: 0, hasMore: false };
        }
        return res.json();
      })
      .then((data) => {
        setFiles(data.files.map(parseFileInfo));
        setTotalCount(data.totalCount);
        setHasMore(data.hasMore);
        setCurrentOffset(offset);
      })
      .catch((err) => {
        console.error("Error fetching files:", err);
        setError500(true);
      })
      .finally(() => setLoading(false));
  };

  const refreshFiles = (reset = false) => {
    const newOffset = reset ? 0 : currentOffset;
    fetchFiles(calendarDateStart, calendarDateEnd, newOffset);
  };

  const handleSort = (column) => {
    const isAsc = sortColumn === column && sortDirection === "asc";
    const newDirection = isAsc ? "desc" : "asc";
    setSortColumn(column);
    setSortDirection(newDirection);
    fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, column, newDirection);
  };

  const handlePageChange = (event, value) => {
    const newOffset = (value - 1) * filesPerPage;
    fetchFiles(calendarDateStart, calendarDateEnd, newOffset);
  };

  const playAudio = async (filename) => {
    // Stop current audio if playing
    if (playing) {
      playing.pause();
      setPlaying(null);
      setIsPlaying(false);
      setCurrentTrack(null);
    }

    try {
      // Get authentication token
      const token = await getToken();
      
      // Create new audio element with auth headers
      const audio = new Audio();
      
      // Set up audio source with authentication
      const response = await fetch(`/api/audio/${encodeURIComponent(filename)}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) {
        console.error('Failed to load audio:', response.status);
        return;
      }
      
      // Convert response to blob and create object URL
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      audio.src = audioUrl;
      audio.volume = volume; // Set initial volume
      
      // Set up event listeners
      audio.addEventListener('loadedmetadata', () => {
        setDuration(audio.duration);
      });
      
      audio.addEventListener('timeupdate', () => {
        setCurrentTime(audio.currentTime);
      });
      
      audio.addEventListener('ended', () => {
        setPlaying(null);
        setIsPlaying(false);
        setCurrentTrack(null);
        setCurrentTime(0);
        URL.revokeObjectURL(audioUrl); // Clean up blob URL
      });
      
      audio.addEventListener('error', (e) => {
        console.error('Audio playback error:', e);
        setPlaying(null);
        setIsPlaying(false);
        setCurrentTrack(null);
      });
      
      // Start playback
      await audio.play();
      setPlaying(audio);
      setIsPlaying(true);
      setCurrentTrack(filename);
      
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  };

  const pauseAudio = () => {
    if (playing) {
      playing.pause();
      setIsPlaying(false);
    }
  };

  const resumeAudio = () => {
    if (playing) {
      playing.play();
      setIsPlaying(true);
    }
  };

  const stopAudio = () => {
    if (playing) {
      playing.pause();
      playing.currentTime = 0;
      setPlaying(null);
      setIsPlaying(false);
      setCurrentTrack(null);
      setCurrentTime(0);
    }
  };

  const seekTo = (time) => {
    if (playing && duration > 0) {
      const newTime = Math.max(0, Math.min(time, duration));
      playing.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleVolumeChange = (newVolume) => {
    setVolume(newVolume);
    if (playing) {
      playing.volume = newVolume;
    }
  };

  const seekForward = () => {
    if (playing) {
      seekTo(playing.currentTime + 10); // Seek forward 10 seconds
    }
  };

  const seekBackward = () => {
    if (playing) {
      seekTo(playing.currentTime - 10); // Seek backward 10 seconds
    }
  };

  const handleProgressClick = (event) => {
    if (playing && duration > 0) {
      const progressBar = event.currentTarget;
      const rect = progressBar.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const progressWidth = rect.width;
      const newTime = (clickX / progressWidth) * duration;
      const clampedTime = Math.max(0, Math.min(newTime, duration));
      playing.currentTime = clampedTime;
      setCurrentTime(clampedTime);
    }
  };

  const handleFilesPerPageChange = (event) => {
    const newLimit = event.target.value;
    setFilesPerPage(newLimit);
    fetchFiles(calendarDateStart, calendarDateEnd, 0, newLimit);
  };

  const handleFilterChange = () => {
    fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, durationMin, phoneFilter, emailFilter, timePickerStart, timePickerEnd, timeMode);
  };

  useEffect(() => {
    const delayedFilterChange = setTimeout(() => {
      if (calendarDateStart) {
        handleFilterChange();
      }
    }, 300);
    return () => clearTimeout(delayedFilterChange);
  }, [phoneFilter, emailFilter, durationMin, timePickerStart, timePickerEnd, timeMode]);

  // Keyboard controls for audio player
  useEffect(() => {
    const handleKeyDown = (event) => {
      // Only handle keyboard events when audio is playing and not typing in input fields
      if (!playing || event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return;
      }

      console.log('Key pressed:', event.key, 'Playing:', !!playing); // Debug log

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          if (playing && duration > 0) {
            const newTime = Math.max(0, playing.currentTime - 5);
            playing.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (playing && duration > 0) {
            const newTime = Math.min(duration, playing.currentTime + 5);
            playing.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case ' ': // Spacebar for play/pause
          event.preventDefault();
          if (playing) {
            if (isPlaying) {
              playing.pause();
              setIsPlaying(false);
            } else {
              playing.play();
              setIsPlaying(true);
            }
          }
          break;
        default:
          break;
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [playing, isPlaying]); // Dependencies: re-setup when playing state changes

  if (!isLoaded) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto', mt: 4 }}>
        <Alert severity="info">
          <Typography variant="h6">Please Sign In</Typography>
          <Typography>You need to be signed in to view recordings.</Typography>
        </Alert>
      </Box>
    );
  }

  if (!userRole) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto', mt: 4 }}>
        <Alert severity="warning">
          <Typography variant="h6">Access Pending</Typography>
          <Typography>Your account needs to be assigned a role. Please contact an administrator.</Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Typography variant="h4" gutterBottom>
          Audio Recordings {!isAdmin && '(Your Files Only)'}
        </Typography>
        
        {/* Audio Player */}
        {currentTrack && (
          <Paper 
            elevation={3} 
            sx={{ 
              position: 'fixed', 
              bottom: 20, 
              left: '50%', 
              transform: 'translateX(-50%)', 
              p: 2, 
              zIndex: 1000,
              minWidth: 400,
              maxWidth: 500,
              background: darkMode ? '#424242' : '#fff'
            }}
          >
            <Box>
              <Typography variant="subtitle2" noWrap sx={{ mb: 1 }}>
                Now Playing: {currentTrack.split('/').pop()}
              </Typography>
              
              <Box display="flex" alignItems="center" gap={1}>
                <IconButton onClick={seekBackward} size="small" title="Rewind 10s">
                  <FastRewindIcon />
                </IconButton>
                
                <IconButton 
                  onClick={isPlaying ? pauseAudio : resumeAudio} 
                  color="primary"
                  size="small"
                >
                  {isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
                </IconButton>
                
                <IconButton onClick={seekForward} size="small" title="Forward 10s">
                  <FastForwardIcon />
                </IconButton>
                
                <IconButton onClick={stopAudio} size="small">
                  <StopIcon />
                </IconButton>
                
                <Box sx={{ flexGrow: 1, mx: 2 }}>
                  <Box 
                    onClick={handleProgressClick}
                    sx={{ 
                      cursor: 'pointer',
                      py: 1, // Add some padding for easier clicking
                      '&:hover .progress-bar': {
                        opacity: 0.8
                      }
                    }}
                  >
                    <LinearProgress 
                      className="progress-bar"
                      variant="determinate" 
                      value={duration ? (currentTime / duration) * 100 : 0}
                      sx={{ 
                        height: 6, 
                        borderRadius: 3,
                        transition: 'opacity 0.2s'
                      }}
                    />
                  </Box>
                </Box>
                
                <Typography variant="caption" sx={{ minWidth: 80, textAlign: 'right' }}>
                  {Math.floor(currentTime / 60)}:{(Math.floor(currentTime % 60)).toString().padStart(2, '0')} / {Math.floor(duration / 60)}:{(Math.floor(duration % 60)).toString().padStart(2, '0')}
                </Typography>
                
                <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 100, ml: 1 }}>
                  <VolumeUpIcon fontSize="small" sx={{ mr: 1, opacity: 0.7 }} />
                  <Slider
                    size="small"
                    value={volume}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(_, newValue) => handleVolumeChange(newValue)}
                    sx={{ 
                      width: 60,
                      '& .MuiSlider-thumb': {
                        width: 12,
                        height: 12,
                      }
                    }}
                  />
                </Box>
              </Box>
              
              {/* Keyboard shortcuts hint */}
              <Typography 
                variant="caption" 
                sx={{ 
                  display: 'block', 
                  textAlign: 'center', 
                  mt: 1, 
                  opacity: 0.6, 
                  fontSize: '0.65rem' 
                }}
              >
                ← → arrow keys: seek ±5s | spacebar: play/pause
              </Typography>
            </Box>
          </Paper>
        )}
        
        {!isAdmin && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can only view recordings associated with your email: {userEmail}
          </Alert>
        )}

        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Box display="flex" alignItems="center" gap={2}>
            <Typography variant="h6">
              {calendarDateStart
                ? `${calendarDateEnd ? `${dayjs(calendarDateStart).format("MMM D")} - ${dayjs(calendarDateEnd).format("MMM D, YYYY")}` : dayjs(calendarDateStart).format("MMM D, YYYY")}`
                : "Select dates to view recordings"}
            </Typography>
            <IconButton 
              onClick={() => refreshFiles(true)} 
              disabled={loading || !calendarDateStart}
              color="primary"
            >
              <RefreshIcon />
            </IconButton>
          </Box>
        </Box>

        {/* Date Selection */}
        <Paper elevation={1} sx={{ p: 2, mb: 2, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
          <Typography variant="h6" gutterBottom>
            Date Selection
          </Typography>
          <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
            <DatePicker
              label="Start Date"
              value={calendarDateStart}
              onChange={(newValue) => {
                setCalendarDateStart(newValue);
                if (newValue) {
                  fetchFiles(newValue, calendarDateEnd, 0);
                }
              }}
              slotProps={{ textField: { size: 'small' } }}
            />
            <DatePicker
              label="End Date (Optional)"
              value={calendarDateEnd}
              onChange={(newValue) => {
                setCalendarDateEnd(newValue);
                if (calendarDateStart) {
                  fetchFiles(calendarDateStart, newValue, 0);
                }
              }}
              slotProps={{ textField: { size: 'small' } }}
            />
          </Box>
        </Paper>

        {/* Column filters */}
        <Grid container spacing={2} mb={2}>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              size="small"
              label="Phone Number"
              value={phoneFilter}
              onChange={(e) => setPhoneFilter(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start">📞</InputAdornment>,
              }}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              size="small"
              label="Email"
              value={isAdmin ? emailFilter : userEmail}
              onChange={(e) => isAdmin && setEmailFilter(e.target.value)}
              disabled={!isAdmin}
              InputProps={{
                startAdornment: <InputAdornment position="start">📧</InputAdornment>,
              }}
            />
          </Grid>
          <Grid item xs={12} md={2}>
            <TextField
              fullWidth
              size="small"
              label="Min Duration"
              value={durationMin}
              onChange={(e) => setDurationMin(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start">⏱️</InputAdornment>,
              }}
            />
          </Grid>
          <Grid item xs={12} md={2}>
            <FormControl fullWidth size="small">
              <InputLabel>Duration Mode</InputLabel>
              <Select value={durationMode} onChange={(e) => setDurationMode(e.target.value)}>
                <MenuItem value="min">Minutes</MenuItem>
                <MenuItem value="sec">Seconds</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} md={2}>
            <FormControl fullWidth size="small">
              <InputLabel>Time Filter</InputLabel>
              <Select value={timeMode} onChange={(e) => setTimeMode(e.target.value)}>
                <MenuItem value="range">Time Range</MenuItem>
                <MenuItem value="none">No Time Filter</MenuItem>
              </Select>
            </FormControl>
          </Grid>
        </Grid>

        {timeMode === "range" && (
          <Grid container spacing={2} mb={2}>
            <Grid item xs={6} md={3}>
              <TimePicker
                label="Start Time"
                value={timePickerStart}
                onChange={setTimePickerStart}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
              />
            </Grid>
            <Grid item xs={6} md={3}>
              <TimePicker
                label="End Time"
                value={timePickerEnd}
                onChange={setTimePickerEnd}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
              />
            </Grid>
          </Grid>
        )}

        {/* Results and pagination controls */}
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Typography variant="body2" color="text.secondary">
            {loading ? "Loading..." : `Showing ${files.length} of ${totalCount.toLocaleString()} files`}
          </Typography>
          <Box display="flex" alignItems="center" gap={2}>
            <FormControl size="small">
              <InputLabel>Per Page</InputLabel>
              <Select value={filesPerPage} onChange={handleFilesPerPageChange}>
                <MenuItem value={10}>10</MenuItem>
                <MenuItem value={25}>25</MenuItem>
                <MenuItem value={50}>50</MenuItem>
                <MenuItem value={100}>100</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </Box>

        {error500 && (
          <Paper sx={{ p: 2, mb: 2, backgroundColor: 'error.light' }}>
            <Typography color="error.contrastText">
              ❌ Server error occurred. Please try again or contact support.
            </Typography>
          </Paper>
        )}

        {loading && (
          <Box display="flex" justifyContent="center" mb={2}>
            <CircularProgress />
          </Box>
        )}

        {files.length === 0 && !loading && calendarDateStart && (
          <Paper sx={{ p: 4, textAlign: 'center', backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
            <Typography variant="h6" color="text.secondary">
              No recordings found for the selected criteria
            </Typography>
          </Paper>
        )}

        {files.length > 0 && (
          <>
            <TableContainer component={Paper} sx={{ mb: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'date'}
                        direction={sortColumn === 'date' ? sortDirection : 'asc'}
                        onClick={() => handleSort('date')}
                      >
                        Date
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'time'}
                        direction={sortColumn === 'time' ? sortDirection : 'asc'}
                        onClick={() => handleSort('time')}
                      >
                        Time
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'phone'}
                        direction={sortColumn === 'phone' ? sortDirection : 'asc'}
                        onClick={() => handleSort('phone')}
                      >
                        Phone
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'email'}
                        direction={sortColumn === 'email' ? sortDirection : 'asc'}
                        onClick={() => handleSort('email')}
                      >
                        Email
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>
                      <TableSortLabel
                        active={sortColumn === 'duration'}
                        direction={sortColumn === 'duration' ? sortDirection : 'asc'}
                        onClick={() => handleSort('duration')}
                      >
                        Duration
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="center">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {files.map((fileInfo, index) => (
                    <TableRow key={index} hover>
                      <TableCell>{fileInfo.date}</TableCell>
                      <TableCell>{fileInfo.time}</TableCell>
                      <TableCell>{fileInfo.phone}</TableCell>
                      <TableCell>{fileInfo.email}</TableCell>
                      <TableCell>{formatDuration(fileInfo.durationMs)}</TableCell>
                      <TableCell align="center">
                        <IconButton 
                          color="primary" 
                          onClick={() => playAudio(fileInfo.file)}
                          size="small"
                        >
                          <PlayArrowIcon />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Box display="flex" justifyContent="center">
              <Pagination
                count={Math.ceil(totalCount / filesPerPage)}
                page={Math.floor(currentOffset / filesPerPage) + 1}
                onChange={handlePageChange}
                color="primary"
                showFirstButton
                showLastButton
              />
            </Box>
          </>
        )}
      </Container>
    </LocalizationProvider>
  );
}

export default FileViewer;