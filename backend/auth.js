import { clerkMiddleware, getAuth, clerkClient } from '@clerk/express';
import { logUserSession, logAuditEvent, getLastLogin } from './database.js';

// Initialize Clerk with required environment variables
if (!process.env.CLERK_SECRET_KEY) {
  console.error('❌ CLERK_SECRET_KEY environment variable is required');
  process.exit(1);
}

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  console.error('❌ CLERK_PUBLISHABLE_KEY environment variable is required');
  process.exit(1);
}

// Export the Clerk middleware for use in Express
export const clerkAuth = clerkMiddleware({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  secretKey: process.env.CLERK_SECRET_KEY,
});

// Middleware to ensure user is authenticated and populate user data
export const requireAuth = async (req, res, next) => {
  try {
    const auth = getAuth(req);
    
    if (!auth?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Get full user details from Clerk
    const user = await clerkClient.users.getUser(auth.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const primaryEmailAddress = user.emailAddresses?.find(email => email.id === user.primaryEmailAddressId);
    const userEmail = primaryEmailAddress?.emailAddress;
    const isEmailVerified = primaryEmailAddress?.verification?.status === 'verified';
    
    // DOMAIN RESTRICTION: Only allow @mtgpros.com domain
    if (!userEmail || !userEmail.endsWith('@mtgpros.com')) {
      console.log(`🚫 [DOMAIN ACCESS DENIED] User ${userEmail} attempted access - not @mtgpros.com domain`);
      return res.status(403).json({ 
        error: 'Access denied', 
        message: 'Access is restricted to @mtgpros.com email addresses only' 
      });
    }
    
    // EMAIL VERIFICATION: Require verified email
    if (!isEmailVerified) {
      console.log(`🚫 [EMAIL NOT VERIFIED] User ${userEmail} attempted access - email not verified`);
      return res.status(403).json({ 
        error: 'Email verification required', 
        message: 'Please verify your email address to access this application' 
      });
    }
    
    console.log(`✅ [DOMAIN ACCESS] User ${userEmail} granted access (@mtgpros.com domain, verified)`);

    // Get client IP and user agent for audit logging
    const ipAddress = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    // Check if this is a new session (check last login)
    const lastLogin = getLastLogin(user.id);
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // If no last login or last login was more than 1 hour ago, log new session
    if (!lastLogin || new Date(lastLogin) < oneHourAgo) {
      logUserSession(user.id, userEmail, ipAddress, userAgent);
      logAuditEvent(user.id, userEmail, 'LOGIN', null, null, ipAddress, userAgent, null, {
        lastLogin: lastLogin,
        loginTime: now.toISOString()
      });
    }

    // Add user info to request for easier access
    req.user = {
      id: user.id,
      email: userEmail,
      role: user.publicMetadata?.role || null,
      firstName: user.firstName,
      lastName: user.lastName,
      ipAddress: ipAddress,
      userAgent: userAgent
    };
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// Middleware to check if user has admin role
export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  next();
};

// Middleware to check if user has member or admin role
export const requireMemberOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  if (!req.user.role || (req.user.role !== 'admin' && req.user.role !== 'member')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  next();
};

// Simplified middleware - any authenticated user can access
export const requireAuthenticatedUser = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  next();
};

// Middleware for manager/admin access (for downloads, etc.)
export const requireManagerOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  if (!req.user.role || (req.user.role !== 'admin' && req.user.role !== 'manager')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  next();
};