import React, { useEffect, useState } from "react";
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
  FormControl,
  InputLabel,
  Button,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import dayjs from "dayjs";
import { ThemeProvider, createTheme } from "@mui/material/styles";

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

function App() {
  const [files, setFiles] = useState([]);
  const [playing, setPlaying] = useState(null);

  const [calendarDateStart, setCalendarDateStart] = useState(null);
  const [calendarDateEnd, setCalendarDateEnd] = useState(null);
  const [timePickerStart, setTimePickerStart] = useState(null);
  const [timePickerEnd, setTimePickerEnd] = useState(null);
  const [phoneFilter, setPhoneFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [sortColumn, setSortColumn] = useState("date");
  const [sortDirection, setSortDirection] = useState("asc");
  const [darkMode, setDarkMode] = useState(false);
  const [durationMin, setDurationMin] = useState("");
  const [durationMode, setDurationMode] = useState("min");
  const [timeMode, setTimeMode] = useState("range");
  const [error500, setError500] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filesPerPage, setFilesPerPage] = useState(25);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [currentOffset, setCurrentOffset] = useState(0);
  const [dbStats, setDbStats] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");

  const theme = createTheme({
    palette: {
      mode: darkMode ? "dark" : "light",
    },
  });

  // Fetch files only when a date is selected or changed
  const fetchFiles = (start, end, offset = 0, limit = filesPerPage, customSortColumn = null, customSortDirection = null, customDurationMin = null, customPhoneFilter = null, customEmailFilter = null, customTimePickerStart = null, customTimePickerEnd = null, customTimeMode = null) => {
    if (!start) return;
    setLoading(true);
    setError500(false);
    
    let url = `/api/wav-files?dateStart=${encodeURIComponent(dayjs(start).format("M_D_YYYY"))}`;
    if (end) url += `&dateEnd=${encodeURIComponent(dayjs(end).format("M_D_YYYY"))}`;
    url += `&offset=${offset}&limit=${limit}`;
    
    // Add filters to URL
    const currentPhoneFilter = customPhoneFilter !== null ? customPhoneFilter : phoneFilter;
    const currentEmailFilter = customEmailFilter !== null ? customEmailFilter : emailFilter;
    const currentDurationMin = customDurationMin !== null ? customDurationMin : durationMin;
    const currentTimePickerStart = customTimePickerStart !== null ? customTimePickerStart : timePickerStart;
    const currentTimePickerEnd = customTimePickerEnd !== null ? customTimePickerEnd : timePickerEnd;
    const currentTimeMode = customTimeMode !== null ? customTimeMode : timeMode;
    
    if (currentPhoneFilter) url += `&phone=${encodeURIComponent(currentPhoneFilter)}`;
    if (currentEmailFilter) url += `&email=${encodeURIComponent(currentEmailFilter)}`;
    if (currentDurationMin) url += `&durationMin=${encodeURIComponent(currentDurationMin)}&durationMode=${durationMode}`;
    if (currentTimePickerStart || currentTimePickerEnd) {
      if (currentTimePickerStart) url += `&timeStart=${encodeURIComponent(dayjs(currentTimePickerStart).format("hh:mm:ss A"))}`;
      if (currentTimePickerEnd) url += `&timeEnd=${encodeURIComponent(dayjs(currentTimePickerEnd).format("hh:mm:ss A"))}`;
      url += `&timeMode=${currentTimeMode}`;
    }
    
    // Add sorting parameters
    const currentSortColumn = customSortColumn || sortColumn;
    const currentSortDirection = customSortDirection || sortDirection;
    url += `&sortColumn=${encodeURIComponent(currentSortColumn)}&sortDirection=${encodeURIComponent(currentSortDirection)}`;
    
    fetch(url)
      .then((res) => {
        if (res.status === 500) {
          setError500(true);
          setLoading(false);
          return { files: [], totalCount: 0, hasMore: false };
        }
        return res.json();
      })
      .then((data) => {
        const result = data.files || data || [];
        setFiles(Array.isArray(result) ? result : []);
        setTotalCount(data.totalCount || result.length || 0);
        setHasMore(data.hasMore || false);
        setCurrentOffset(data.offset || 0);
        setLoading(false);
      })
      .catch(() => {
        setFiles([]);
        setError500(true);
        setLoading(false);
      });
  };

  useEffect(() => {
    if (calendarDateStart) {
      fetchFiles(calendarDateStart, calendarDateEnd);

    }
    // eslint-disable-next-line
  }, [calendarDateStart, calendarDateEnd]);

  const playFile = (file) => {
    const encodedPath = file.split('/').map(encodeURIComponent).join('/');
    setPlaying(`/api/wav-files/${encodedPath}`);
  };

  // Files are now filtered and paginated by the backend
  const displayFiles = files;

  // Backend handles sorting and pagination now
  const pageCount = Math.max(1, Math.ceil(totalCount / filesPerPage));
  const currentPage = Math.floor(currentOffset / filesPerPage) + 1;

  // Handlers
  const handleDarkModeToggle = () => setDarkMode((prev) => !prev);
  
  const refreshFiles = (resetOffset = true) => {
    const offset = resetOffset ? 0 : currentOffset;
    if (resetOffset) setCurrentOffset(0);
    fetchFiles(calendarDateStart, calendarDateEnd, offset, filesPerPage);
  };



  const handleCalendarDateStart = (newValue) => { 
    setCalendarDateStart(newValue); 
    setCurrentOffset(0);
    if (newValue) refreshFiles(true);
  };
  
  const handleCalendarDateEnd = (newValue) => { 
    setCalendarDateEnd(newValue); 
    setCurrentOffset(0);
    if (calendarDateStart) refreshFiles(true);
  };
  
  const handlePhoneFilter = (e) => { 
    const newValue = e.target.value;
    setPhoneFilter(newValue); 
    setCurrentOffset(0);
    // Call fetchFiles directly with the new phone filter value to avoid async state issues
    if (calendarDateStart) {
      fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, null, newValue);
    }
  };
  
  const handleEmailFilter = (e) => { 
    const newValue = e.target.value;
    setEmailFilter(newValue); 
    setCurrentOffset(0);
    // Call fetchFiles directly with the new email filter value to avoid async state issues
    if (calendarDateStart) {
      fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, null, null, newValue);
    }
  };

  const handleDurationFilter = (value) => {
    setDurationMin(value);
    setCurrentOffset(0);
    // Call fetchFiles directly with the new duration value to avoid async state issues
    if (calendarDateStart) {
      fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, value);
    }
  };



  const handlePageChange = (event, newPage) => {
    const newOffset = (newPage - 1) * filesPerPage;
    setCurrentOffset(newOffset);
    fetchFiles(calendarDateStart, calendarDateEnd, newOffset, filesPerPage);
  };

  const handleSort = (column) => {
    let newDirection;
    if (sortColumn === column) {
      newDirection = sortDirection === "asc" ? "desc" : "asc";
      setSortDirection(newDirection);
    } else {
      setSortColumn(column);
      newDirection = "asc";
      setSortDirection("asc");
    }
    setCurrentOffset(0);
    
    // Call fetchFiles directly with the new sort values to avoid async state issues
    if (calendarDateStart) {
      fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, column, newDirection);
    }
  };

  // Database management functions
  const fetchDatabaseStats = async () => {
    try {
      const response = await fetch('/api/database-stats');
      const stats = await response.json();
      setDbStats(stats);
    } catch (error) {
      console.error('Error fetching database stats:', error);
    }
  };

  const syncDatabase = async (dateRange = null) => {
    setSyncing(true);
    setSyncProgress("Starting database sync...");
    
    try {
      const body = dateRange ? { dateRange } : {};
      
      const response = await fetch('/api/sync-database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      const result = await response.json();
      
      if (result.success) {
        setSyncProgress(`✅ Synced ${result.indexedFiles} files in ${result.duration}`);
        await fetchDatabaseStats(); // Refresh stats
        
        // Refresh current file list
        if (calendarDateStart) {
          refreshFiles(true);
        }
      } else {
        setSyncProgress(`❌ Sync failed: ${result.error}`);
      }
    } catch (error) {
      setSyncProgress(`❌ Sync error: ${error.message}`);
    }
    
    setSyncing(false);
  };

  const syncDateRange = () => {
    if (calendarDateStart && calendarDateEnd) {
      const dateRange = {
        startDate: dayjs(calendarDateStart).format("M_D_YYYY"),
        endDate: dayjs(calendarDateEnd).format("M_D_YYYY")
      };
      console.log('🗓️ Syncing date range:', dateRange);
      syncDatabase(dateRange);
    } else if (calendarDateStart) {
      const dateRange = {
        startDate: dayjs(calendarDateStart).format("M_D_YYYY"),
        endDate: dayjs(calendarDateStart).format("M_D_YYYY")
      };
      console.log('🗓️ Syncing single date:', dateRange);
      syncDatabase(dateRange);
    } else {
      console.warn('⚠️ No dates selected for sync');
    }
  };

  // Load database stats on component mount
  useEffect(() => {
    fetchDatabaseStats();
  }, []);

  // No need for useEffect to adjust page since backend handles pagination

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="md" sx={{ mt: 4 }}>
        <Paper elevation={3} sx={{ p: 3 }}>
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <img src="/ColorLogo.svg" alt="RecBot Logo" style={{ height: 96 }} />
            <Box display="flex" alignItems="center">
              <FormControlLabel
                control={
                  <Switch
                    checked={darkMode}
                    onChange={handleDarkModeToggle}
                    color="primary"
                  />
                }
                label={darkMode ? "Dark" : "Light"}
                sx={{ mr: 2 }}
              />
              <IconButton
                aria-label="Refresh"
                color="primary"
                onClick={() => refreshFiles(true)}
                title="Refresh file list"
              >
                <RefreshIcon />
              </IconButton>
              
              {/* Database Stats Display */}
              {dbStats && dbStats.totalFiles !== undefined && (
                <Box sx={{ ml: 2, textAlign: 'center' }}>
                  <Typography variant="caption" display="block">
                    DB: {(dbStats.totalFiles || 0).toLocaleString()} files
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {((dbStats.databaseSize || 0) / 1024 / 1024).toFixed(1)} MB
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
          {/* Column filters */}
          <Grid container spacing={2} mb={2}>
            <Grid item xs={3}>
              <LocalizationProvider dateAdapter={AdapterDayjs}>
                <Box display="flex" alignItems="center" gap={1}>
                  <DatePicker
                    label="Start date"
                    value={calendarDateStart}
                    onChange={handleCalendarDateStart}
                    slotProps={{ textField: { size: "small", fullWidth: true } }}
                    format="MM_DD_YYYY"
                  />
                  <DatePicker
                    label="End date"
                    value={calendarDateEnd}
                    onChange={handleCalendarDateEnd}
                    slotProps={{ textField: { size: "small", fullWidth: true } }}
                    format="MM_DD_YYYY"
                  />
                </Box>
              </LocalizationProvider>
            </Grid>
            <Grid item xs={3}>
              <LocalizationProvider dateAdapter={AdapterDayjs}>
                <Box display="flex" alignItems="center">
                  <TimePicker
                    label={timeMode === "range" ? "Start time" : timeMode}
                    value={timePickerStart}
                    onChange={(value) => { 
                      setTimePickerStart(value); 
                      setCurrentOffset(0);
                      if (calendarDateStart) {
                        fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, null, null, null, value);
                      }
                    }}
                    slotProps={{ textField: { size: "small", fullWidth: true } }}
                    format="hh:mm:ss A"
                  />
                  {timeMode === "range" && (
                    <TimePicker
                      label="End time"
                      value={timePickerEnd}
                      onChange={(value) => { 
                        setTimePickerEnd(value); 
                        setCurrentOffset(0);
                        if (calendarDateStart) {
                          fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, null, null, null, null, value);
                        }
                      }}
                      slotProps={{ textField: { size: "small", fullWidth: true } }}
                      format="hh:mm:ss A"
                      sx={{ ml: 1 }}
                    />
                  )}
                  <Select
                    value={timeMode}
                    onChange={e => { 
                      const newValue = e.target.value;
                      setTimeMode(newValue); 
                      setCurrentOffset(0);
                      if (calendarDateStart) {
                        fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, null, null, null, null, null, newValue);
                      }
                    }}
                    size="small"
                    sx={{ minWidth: 90, ml: 1 }}
                  >
                    <MenuItem value="range">range</MenuItem>
                    <MenuItem value="Older">Older</MenuItem>
                    <MenuItem value="Newer">Newer</MenuItem>
                  </Select>
                </Box>
              </LocalizationProvider>
            </Grid>
            <Grid item xs={2}>
              <Box display="flex" alignItems="center">
                <TextField
                  label={durationMode === "min" ? "Min Duration" : "Max Duration"}
                  variant="outlined"
                  fullWidth
                  type="number"
                  value={durationMin}
                  onChange={e => handleDurationFilter(e.target.value)}
                  InputProps={{
                    endAdornment: <InputAdornment position="end">sec</InputAdornment>,
                    inputProps: { min: 0 }
                  }}
                  size="small"
                  sx={{ mr: 1 }}
                />
                <Select
                  value={durationMode}
                  onChange={e => { 
                    setDurationMode(e.target.value); 
                    setCurrentOffset(0);
                    if (calendarDateStart) {
                      fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, durationMin);
                    }
                  }}
                  size="small"
                  sx={{ minWidth: 70 }}
                >
                  <MenuItem value="min">min</MenuItem>
                  <MenuItem value="max">max</MenuItem>
                </Select>
              </Box>
            </Grid>
            <Grid item xs={2}></Grid>
            <Grid item xs={1}>
              <TextField
                label="Phone"
                variant="outlined"
                fullWidth
                value={phoneFilter}
                onChange={handlePhoneFilter}
                size="small"
              />
            </Grid>
            <Grid item xs={1}>
              <TextField
                label="Email"
                variant="outlined"
                fullWidth
                value={emailFilter}
                onChange={handleEmailFilter}
                size="small"
              />
            </Grid>
          </Grid>
          
          {/* Database Management Section */}
          <Paper elevation={1} sx={{ p: 2, mb: 2, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
            <Typography variant="h6" gutterBottom>
              Database Management - Scale: {dbStats ? `${dbStats.totalFiles.toLocaleString()} files` : 'Loading...'}
            </Typography>
            <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
              <Button
                variant="outlined"
                onClick={syncDateRange}
                disabled={syncing || !calendarDateStart}
                color="primary"
              >
                {syncing ? 'Syncing...' : 'Sync Selected Dates'}
              </Button>
              
              <Button
                variant="outlined"
                onClick={() => syncDatabase()}
                disabled={syncing}
                color="warning"
                title="WARNING: Will sync ALL files - may take time with 300k+ files"
              >
                {syncing ? 'Syncing...' : 'Full Sync (⚠️ All Files)'}
              </Button>
              
              <Button
                variant="text"
                onClick={fetchDatabaseStats}
                size="small"
                disabled={syncing}
              >
                Refresh Stats
              </Button>
              
              {syncProgress && (
                <Typography 
                  variant="body2" 
                  sx={{ 
                    color: syncProgress.includes('✅') ? 'success.main' : 
                           syncProgress.includes('❌') ? 'error.main' : 'info.main',
                    fontWeight: 'medium'
                  }}
                >
                  {syncProgress}
                </Typography>
              )}
              
              {syncing && <CircularProgress size={20} />}
            </Box>
            
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              💡 Performance Mode: For 300k+ files, use "Sync Selected Dates" first, then browse. 
              Full sync recommended during maintenance windows only.
            </Typography>
          </Paper>
          
          {/* Files per page selector */}
          <Box display="flex" justifyContent="flex-end" alignItems="center" mb={2}>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel id="files-per-page-label">Files per page</InputLabel>
              <Select
                labelId="files-per-page-label"
                value={filesPerPage}
                label="Files per page"
                onChange={e => {
                  const newLimit = Number(e.target.value);
                  setFilesPerPage(newLimit);
                  setCurrentOffset(0);
                  if (calendarDateStart) {
                    fetchFiles(calendarDateStart, calendarDateEnd, 0, newLimit, false);
                  }
                }}
              >
                <MenuItem value={25}>25</MenuItem>
                <MenuItem value={50}>50</MenuItem>
                <MenuItem value={100}>100</MenuItem>
                <MenuItem value={250}>250</MenuItem>
                <MenuItem value={500}>500</MenuItem>
                <MenuItem value={1000}>1000</MenuItem>
              </Select>
            </FormControl>
          </Box>
          {loading ? (
            <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
              <CircularProgress />
            </Box>
          ) : error500 ? (
            <Typography variant="body1" color="error" align="center">
              Error 500: files could not be loaded
            </Typography>
          ) : (
            (calendarDateStart || calendarDateEnd || timePickerStart || timePickerEnd || phoneFilter.trim() || emailFilter.trim() || durationMin !== "") ? (
              <>
                <TableContainer component={Paper} sx={{ mb: 2 }}>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableCell>
                          <TableSortLabel
                            active={sortColumn === "date"}
                            direction={sortColumn === "date" ? sortDirection : "asc"}
                            onClick={() => handleSort("date")}
                          >
                            Date
                          </TableSortLabel>
                        </TableCell>
                        <TableCell>
                          <TableSortLabel
                            active={sortColumn === "time"}
                            direction={sortColumn === "time" ? sortDirection : "asc"}
                            onClick={() => handleSort("time")}
                          >
                            Time
                          </TableSortLabel>
                        </TableCell>
                        <TableCell>
                          <TableSortLabel
                            active={sortColumn === "phone"}
                            direction={sortColumn === "phone" ? sortDirection : "asc"}
                            onClick={() => handleSort("phone")}
                          >
                            Phone
                          </TableSortLabel>
                        </TableCell>
                        <TableCell>
                          <TableSortLabel
                            active={sortColumn === "email"}
                            direction={sortColumn === "email" ? sortDirection : "asc"}
                            onClick={() => handleSort("email")}
                          >
                            Email
                          </TableSortLabel>
                        </TableCell>
                        <TableCell>
                          <TableSortLabel
                            active={sortColumn === "durationMs"}
                            direction={sortColumn === "durationMs" ? sortDirection : "asc"}
                            onClick={() => handleSort("durationMs")}
                          >
                            Duration
                          </TableSortLabel>
                        </TableCell>
                        <TableCell>Play</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {displayFiles.map((file) => {
                        const info = parseFileInfo(file);
                        const encodedFile = `/api/wav-files/${file.split('/').map(encodeURIComponent).join('/')}`;
                        const isPlaying = playing === encodedFile;
                        return (
                          <React.Fragment key={file}>
                            <TableRow>
                              <TableCell>{info.date}</TableCell>
                              <TableCell>{info.time}</TableCell>
                              <TableCell>{info.phone}</TableCell>
                              <TableCell>{info.email}</TableCell>
                              <TableCell>{formatDuration(info.durationMs)}</TableCell>
                              <TableCell>
                                <IconButton edge="end" onClick={() => playFile(file)}>
                                  <PlayArrowIcon />
                                </IconButton>
                              </TableCell>
                            </TableRow>
                            {isPlaying && (
                              <TableRow>
                                <TableCell colSpan={6}>
                                  <Box sx={{ width: "100%", py: 2, display: "flex", justifyContent: "center" }}>
                                    <audio
                                      src={playing}
                                      controls
                                      autoPlay
                                      preload="auto"
                                      style={{ width: "100%" }}
                                    />
                                  </Box>
                                </TableCell>
                              </TableRow>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
                {(pageCount > 1) && (
                  <Box display="flex" justifyContent="center" alignItems="center" mt={2} gap={2}>
                    <Pagination
                      count={pageCount}
                      page={currentPage}
                      onChange={handlePageChange}
                      color="primary"
                      siblingCount={1}
                      boundaryCount={1}
                    />
                    <Typography variant="body2" color="text.secondary">
                      Showing {displayFiles.length} of {totalCount} files
                    </Typography>
                  </Box>
                )}
                {displayFiles.length === 0 && (
                  <Typography variant="body1" color="text.secondary" align="center">
                    No files found for your search or filters.
                  </Typography>
                )}
              </>
            ) : (
              <Typography variant="body1" color="text.secondary" align="center">
                Please enter a filter to view files.
              </Typography>
            )
          )}
        </Paper>
      </Container>
    </ThemeProvider>
  );
}

export default App;
