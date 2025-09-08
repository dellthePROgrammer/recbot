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
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import dayjs from "dayjs";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";

function parseFileInfo(file) {
  const [folder, filename] = file.split('/');
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
  const [page, setPage] = useState(1);
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
  const [durationMode, setDurationMode] = useState("min"); // "min" or "max"
  const [timeMode, setTimeMode] = useState("range"); // "range", "Older", or "Newer"
  const [error500, setError500] = useState(false);
  const [loading, setLoading] = useState(false);
  const [totalFiles, setTotalFiles] = useState(0);
  const [filesPerPage, setFilesPerPage] = useState(25);

  const theme = createTheme({
    palette: {
      mode: darkMode ? "dark" : "light",
    },
  });

  // Fetch files only when a date is selected
  const fetchFiles = (
    start,
    end,
    pageNum = 1,
    pageSize = filesPerPage,
    phone = phoneFilter,
    email = emailFilter,
    duration = durationMin,
    durationModeParam = durationMode
  ) => {
    if (!start) return;
    setLoading(true);
    setError500(false);
    let url = `/api/wav-files?dateStart=${encodeURIComponent(dayjs(start).format("M_D_YYYY"))}&page=${pageNum}&pageSize=${pageSize}`;
    if (end) url += `&dateEnd=${encodeURIComponent(dayjs(end).format("M_D_YYYY"))}`;
    if (phone) url += `&phone=${encodeURIComponent(phone)}`;
    if (email) url += `&email=${encodeURIComponent(email)}`;
    if (duration) url += `&duration=${encodeURIComponent(duration)}&durationMode=${durationModeParam}`;
    fetch(url)
      .then((res) => {
        if (res.status === 500) {
          setError500(true);
          setLoading(false);
          return { files: [] };
        }
        return res.json();
      })
      .then((data) => {
        setFiles(Array.isArray(data.files) ? data.files : []);
        setTotalFiles(data.total || 0);
        const calculatedPageCount = Math.max(1, Math.ceil((data.total || 0) / filesPerPage));
        setPage(calculatedPageCount);
        if (page > calculatedPageCount) setPage(1);
        setLoading(false);
      })
      .catch(() => {
        setFiles([]);
        setError500(true);
        setLoading(false);
      });
  };

  // When the user selects a date or date range, or changes filesPerPage, fetch files
  useEffect(() => {
    if (calendarDateStart) {
      fetchFiles(calendarDateStart, calendarDateEnd, 1, filesPerPage, phoneFilter, emailFilter, durationMin, durationMode);
      setPage(1);
    }
    // eslint-disable-next-line
  }, [calendarDateStart, calendarDateEnd, filesPerPage, phoneFilter, emailFilter, durationMin, durationMode]);

  // When the user changes page, fetch that page
  useEffect(() => {
    if (calendarDateStart) {
      fetchFiles(calendarDateStart, calendarDateEnd, page, filesPerPage);
    }
    // eslint-disable-next-line
  }, [page]);

  const playFile = (file) => {
    const encodedPath = file.split('/').map(encodeURIComponent).join('/');
    setPlaying(`/api/wav-files/${encodedPath}`);
  };

  // Filter files by column filters
  const filteredFiles = files.filter((file) => {
    const info = parseFileInfo(file);

    // Date filter logic (range)
    let dateMatch = true;
    if (calendarDateStart && calendarDateEnd) {
      const fileDate = dayjs(info.date, "M/D/YYYY");
      dateMatch =
        fileDate.isValid() &&
        !fileDate.isBefore(dayjs(calendarDateStart)) &&
        !fileDate.isAfter(dayjs(calendarDateEnd));
    } else if (calendarDateStart) {
      const fileDate = dayjs(info.date, "M/D/YYYY");
      dateMatch = fileDate.isValid() && fileDate.isSame(dayjs(calendarDateStart), "day");
    }

    // Time filter logic
    let timeMatch = true;
    const fileTime = dayjs(info.time, "hh:mm:ss A");
    if (timeMode === "range" && timePickerStart && timePickerEnd) {
      timeMatch =
        fileTime.isValid() &&
        !fileTime.isBefore(dayjs(timePickerStart)) &&
        !fileTime.isAfter(dayjs(timePickerEnd));
    } else if (timeMode === "Older" && timePickerStart) {
      // Older: fileTime <= selected time
      timeMatch = fileTime.isValid() && !fileTime.isAfter(dayjs(timePickerStart));
    } else if (timeMode === "Newer" && timePickerStart) {
      // Newer: fileTime >= selected time
      timeMatch = fileTime.isValid() && !fileTime.isBefore(dayjs(timePickerStart));
    }

    // Duration filter logic (min or max)
    let durationMatch = true;
    const durationSec = Math.floor(info.durationMs / 1000);
    if (durationMin !== "" && !isNaN(durationMin)) {
      if (durationMode === "min") {
        durationMatch = durationSec >= Number(durationMin);
      } else {
        durationMatch = durationSec <= Number(durationMin);
      }
    }
    return (
      dateMatch &&
      timeMatch &&
      info.phone.toLowerCase().includes(phoneFilter.toLowerCase()) &&
      info.email.toLowerCase().includes(emailFilter.toLowerCase()) &&
      durationMatch
    );
  });

  // Sort filtered files
  const sortedFiles = [...files].sort((a, b) => {
    const infoA = parseFileInfo(a);
    const infoB = parseFileInfo(b);
    let valA = infoA[sortColumn];
    let valB = infoB[sortColumn];

    if (sortColumn === "durationMs") {
      valA = Number(valA);
      valB = Number(valB);
    } else if (sortColumn === "time") {
      // Parse time strings to dayjs objects for comparison
      const timeA = dayjs(valA, "hh:mm:ss A");
      const timeB = dayjs(valB, "hh:mm:ss A");
      if (timeA.isValid() && timeB.isValid()) {
        if (timeA.isBefore(timeB)) return sortDirection === "asc" ? -1 : 1;
        if (timeA.isAfter(timeB)) return sortDirection === "asc" ? 1 : -1;
        return 0;
      }
      // Fallback to string comparison if invalid
      valA = valA || "";
      valB = valB || "";
    } else {
      valA = valA || "";
      valB = valB || "";
    }

    if (valA < valB) return sortDirection === "asc" ? -1 : 1;
    if (valA > valB) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  const pageCount = Math.max(1, Math.ceil(sortedFiles.length / filesPerPage));
  const paginatedFiles = sortedFiles.slice((page - 1) * filesPerPage, page * filesPerPage);

  const handleDarkModeToggle = () => {
    setDarkMode((prev) => !prev);
  };

  const handleCalendarDateStart = (newValue) => {
    setCalendarDateStart(newValue);
    setPage(1);
  };

  const handleCalendarDateEnd = (newValue) => {
    setCalendarDateEnd(newValue);
    setPage(1);
  };

  const handlePhoneFilter = (e) => {
    setPhoneFilter(e.target.value);
    setPage(1);
  };

  const handleEmailFilter = (e) => {
    setEmailFilter(e.target.value);
    setPage(1);
  };

  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
    setPage(1);
  };

  // When the filtered files change, adjust the page if necessary
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredFiles.length / filesPerPage));
    if (page > maxPage) setPage(1);
    // eslint-disable-next-line
  }, [filteredFiles.length, filesPerPage]);

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
                onClick={() => fetchFiles(calendarDateStart, calendarDateEnd)}
                title="Refresh file list"
              >
                <RefreshIcon />
              </IconButton>
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
                    label={
                      timeMode === "range"
                        ? "Start time"
                        : timeMode
                    }
                    value={timePickerStart}
                    onChange={setTimePickerStart}
                    slotProps={{ textField: { size: "small", fullWidth: true } }}
                    format="hh:mm:ss A"
                  />
                  {timeMode === "range" && (
                    <TimePicker
                      label="End time"
                      value={timePickerEnd}
                      onChange={setTimePickerEnd}
                      slotProps={{ textField: { size: "small", fullWidth: true } }}
                      format="hh:mm:ss A"
                      sx={{ ml: 1 }}
                    />
                  )}
                  <Select
                    value={timeMode}
                    onChange={e => setTimeMode(e.target.value)}
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
                  onChange={e => setDurationMin(e.target.value)}
                  InputProps={{
                    endAdornment: <InputAdornment position="end">sec</InputAdornment>,
                    inputProps: { min: 0 }
                  }}
                  size="small"
                  sx={{ mr: 1 }}
                />
                <Select
                  value={durationMode}
                  onChange={e => setDurationMode(e.target.value)}
                  size="small"
                  sx={{ minWidth: 70 }}
                >
                  <MenuItem value="min">min</MenuItem>
                  <MenuItem value="max">max</MenuItem>
                </Select>
              </Box>
            </Grid>
            <Grid item xs={2}>
              {/* Empty grid to keep layout aligned */}
            </Grid>
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
          {/* Add files per page selector */}
          <Box display="flex" justifyContent="flex-end" alignItems="center" mb={2}>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel id="files-per-page-label">Files per page</InputLabel>
              <Select
                labelId="files-per-page-label"
                value={filesPerPage}
                label="Files per page"
                onChange={e => setFilesPerPage(Number(e.target.value))}
              >
                <MenuItem value={25}>25</MenuItem>
                <MenuItem value={50}>50</MenuItem>
                <MenuItem value={75}>75</MenuItem>
                <MenuItem value={100}>100</MenuItem>
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
                      {paginatedFiles.map((file) => {
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
                  <Box display="flex" justifyContent="center" mt={2}>
                    <Pagination
                      count={pageCount}
                      page={page}
                      onChange={(e, value) => setPage(value)}
                      color="primary"
                      siblingCount={1}
                      boundaryCount={1}
                    />
                  </Box>
                )}
                {sortedFiles.length === 0 && (
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
