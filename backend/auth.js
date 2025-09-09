import express from "express";
import axios from "axios";
import db from "./db.js";

const router = express.Router();

const BETTERAUTH_TOKEN_URL = "https://auth.better-auth.com/oauth/token";
const BETTERAUTH_USERINFO_URL = "https://auth.better-auth.com/oauth/userinfo";
const CLIENT_ID = process.env.BETTERAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.BETTERAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.BETTERAUTH_REDIRECT_URI;

// Step 1: Handle the OAuth callback
router.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post(BETTERAUTH_TOKEN_URL, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const { access_token } = tokenRes.data;

    // Get user info
    const userRes = await axios.get(BETTERAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const user = userRes.data;

    // Store or update user in SQLite
    db.prepare(`
      INSERT INTO users (id, email, name)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name
    `).run(user.sub, user.email, user.name);

    // Set a session or JWT here as needed (for demo, just send user info)
    res.json({ user });
  } catch (err) {
    console.error("BetterAuth callback error:", err.response?.data || err.message);
    res.status(500).send("Authentication failed");
  }
});

export default router;