import React from "react";
import { Button, Container, Typography, Box } from "@mui/material";

const BETTERAUTH_URL = "https://auth.better-auth.com/oauth/authorize";
const CLIENT_ID = process.env.REACT_APP_BETTERAUTH_CLIENT_ID;
const REDIRECT_URI = window.location.origin + "/auth/callback";
const PROVIDER = "microsoft";

const AUTH_URL =
  `${BETTERAUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&provider=${PROVIDER}`;

function Login() {
  const handleLogin = () => {
    window.location.href = AUTH_URL;
  };

  return (
    <Container maxWidth="sm" sx={{ mt: 8 }}>
      <Box textAlign="center">
        <Typography variant="h4" gutterBottom>
          Login to RecBot
        </Typography>
        <Typography variant="body1" gutterBottom>
          Please sign in with your Microsoft account to continue.
        </Typography>
        <Button
          variant="contained"
          color="primary"
          size="large"
          onClick={handleLogin}
          sx={{ mt: 4 }}
        >
          Sign in with Microsoft
        </Button>
      </Box>
    </Container>
  );
}

export default Login;