import React, { useState, useEffect } from 'react';
import { useUser, useAuth } from '@clerk/clerk-react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Alert,
  LinearProgress,
  Divider
} from '@mui/material';
import {
  Storage as DatabaseIcon,
  Sync as SyncIcon,
  Warning as WarningIcon
} from '@mui/icons-material';

function AdminPage({ darkMode }) {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const [dbStats, setDbStats] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");

  // Check if user has admin role
  const isAdmin = user?.publicMetadata?.role === 'admin';

  useEffect(() => {
    if (isLoaded && !isAdmin) {
      // Redirect non-admin users or show error
      return;
    }
    if (isAdmin) {
      fetchDatabaseStats();
    }
  }, [isLoaded, isAdmin]);

  const fetchDatabaseStats = async () => {
    try {
      const response = await fetch('/api/database-stats', {
        headers: {
          'Authorization': `Bearer ${await getToken()}`
        }
      });
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
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getToken()}`
        },
        body: JSON.stringify(body)
      });
      
      const result = await response.json();
      
      if (result.success) {
        setSyncProgress(`✅ Synced ${result.indexedFiles} files in ${result.duration}`);
        await fetchDatabaseStats(); // Refresh stats
      } else {
        setSyncProgress(`❌ Sync failed: ${result.error}`);
      }
    } catch (error) {
      setSyncProgress(`❌ Sync failed: ${error.message}`);
    } finally {
      setSyncing(false);
    }
  };

  if (!isLoaded) {
    return <LinearProgress />;
  }

  if (!isAdmin) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto', mt: 4 }}>
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography>This page is not available.</Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
      <Typography variant="h4" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <DatabaseIcon />
        Admin Dashboard
      </Typography>
      
      <Divider sx={{ mb: 3 }} />

      <Paper elevation={1} sx={{ p: 3, mb: 3, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
        <Typography variant="h6" gutterBottom>
          Database Management - Scale: {dbStats ? `${dbStats.totalFiles.toLocaleString()} files` : 'Loading...'}
        </Typography>
        
        {dbStats && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Database Size: {((dbStats.databaseSize || 0) / 1024 / 1024).toFixed(1)} MB
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Database Path: {dbStats.databasePath}
            </Typography>
          </Box>
        )}

        <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
          <Button
            variant="outlined"
            onClick={() => syncDatabase()}
            disabled={syncing}
            color="warning"
            startIcon={<WarningIcon />}
            title="WARNING: Will sync ALL files - may take time with 300k+ files"
          >
            {syncing ? 'Syncing...' : 'Full Sync (⚠️ All Files)'}
          </Button>
          
          <Button
            variant="text"
            onClick={fetchDatabaseStats}
            disabled={syncing}
            startIcon={<SyncIcon />}
          >
            Refresh Stats
          </Button>
        </Box>

        {syncProgress && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {syncProgress}
            </Typography>
            {syncing && <LinearProgress sx={{ mt: 1 }} />}
          </Box>
        )}
      </Paper>

      <Paper elevation={1} sx={{ p: 3, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
        <Typography variant="h6" gutterBottom>
          System Information
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Admin User: {user?.emailAddresses?.[0]?.emailAddress}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Role: {user?.publicMetadata?.role || 'No role assigned'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Auto-sync: Current day files are synced every 5 minutes automatically
        </Typography>
      </Paper>
    </Box>
  );
}

export default AdminPage;