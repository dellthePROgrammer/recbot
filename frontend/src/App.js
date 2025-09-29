import React, { useState, useEffect } from "react";
import { ClerkProvider, SignIn, SignUp, SignedIn, SignedOut, UserButton, useUser } from '@clerk/clerk-react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  Switch,
  FormControlLabel,
  CssBaseline,
  Button,
  Container,
} from "@mui/material";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import FileViewer from './FileViewer';
import AdminPage from './AdminPage';

// Try build-time env var first, then runtime config
const CLERK_PUBLISHABLE_KEY = process.env.REACT_APP_CLERK_PUBLISHABLE_KEY;

function Navigation({ darkMode, setDarkMode }) {
  const { user } = useUser();
  const isAdmin = user?.publicMetadata?.role === 'admin';

  return (
    <AppBar position="static" color="default" elevation={1}>
      <Toolbar>
        <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
          RecBot - Audio Manager
        </Typography>
        
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {isAdmin && (
            <Button component={Link} to="/admin" variant="outlined" size="small">
              Admin Dashboard
            </Button>
          )}
          
          <Button component={Link} to="/" variant="text" size="small">
            Files
          </Button>
          
          <FormControlLabel
            control={<Switch checked={darkMode} onChange={(e) => setDarkMode(e.target.checked)} />}
            label="Dark Mode"
          />
          
          <UserButton afterSignOutUrl="/" />
        </Box>
      </Toolbar>
    </AppBar>
  );
}

function AppContent() {
  const [darkMode, setDarkMode] = useState(localStorage.getItem('darkMode') === 'true');

  React.useEffect(() => {
    localStorage.setItem('darkMode', darkMode);
  }, [darkMode]);

  const theme = createTheme({
    palette: { mode: darkMode ? "dark" : "light" },
  });

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <Router>
          <SignedIn>
            <Navigation darkMode={darkMode} setDarkMode={setDarkMode} />
            <Routes>
              <Route path="/" element={<FileViewer darkMode={darkMode} />} />
              <Route path="/admin" element={<AdminPage darkMode={darkMode} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </SignedIn>
          
          <SignedOut>
            <Container maxWidth="sm" sx={{ mt: 8 }}>
              <Typography variant="h4" gutterBottom align="center">
                RecBot Audio Manager
              </Typography>
              <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                <SignIn routing="hash" />
              </Box>
            </Container>
          </SignedOut>
        </Router>
      </LocalizationProvider>
    </ThemeProvider>
  );
}

function ClerkConfigLoader() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // If we have a build-time key, use it immediately
    if (CLERK_PUBLISHABLE_KEY) {
      setConfig({ clerkPublishableKey: CLERK_PUBLISHABLE_KEY });
      setLoading(false);
      return;
    }

    // Otherwise, fetch config from backend at runtime
    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        if (data.clerkPublishableKey) {
          setConfig(data);
        } else {
          setError('Clerk publishable key not configured on server');
        }
      })
      .catch(err => {
        console.error('Failed to load config:', err);
        setError('Failed to load configuration');
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Container maxWidth="sm" sx={{ mt: 8 }}>
        <Box sx={{ textAlign: 'center', p: 4 }}>
          <Typography variant="h6">Loading configuration...</Typography>
        </Box>
      </Container>
    );
  }

  if (error || !config?.clerkPublishableKey) {
    return (
      <Container maxWidth="sm" sx={{ mt: 8 }}>
        <Box sx={{ textAlign: 'center', p: 4, bgcolor: 'error.light', borderRadius: 2 }}>
          <Typography variant="h5" color="error" gutterBottom>
            ⚠️ Configuration Error
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            {error || 'Clerk publishable key is not configured.'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Please set CLERK_PUBLISHABLE_KEY in your server environment variables.
          </Typography>
          <Typography variant="caption" display="block" sx={{ mt: 2, fontFamily: 'monospace' }}>
            Expected format: pk_test_... or pk_live_...
          </Typography>
        </Box>
      </Container>
    );
  }

  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <AppContent />
    </ClerkProvider>
  );
}

function App() {
  return <ClerkConfigLoader />;
}

export default App;
