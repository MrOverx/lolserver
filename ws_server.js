const fs = require('fs');
const path = require('path');
// Ensure the local backend node_modules folder is resolved even when the file
// is launched from a different CWD (for example, running nodemon from the root).
module.paths.unshift(path.join(__dirname, 'node_modules'));

// Load environment variables from the nearest .env file in the backend or workspace root.
const envCandidates = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
];
let envPathUsed = null;
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    envPathUsed = envPath;
    break;
  }
}
if (!envPathUsed) {
  require('dotenv').config();
}

if (envPathUsed) {
  console.log(`🔐 Loaded environment variables from: ${envPathUsed}`);
} else {
  console.log('⚠️ No .env found in backend search paths; relying on process environment only');
}

const express = require('express');
const http = require('http');
const https = require('https');
const socketIO = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const compression = require('compression');
const helmet = require('helmet');

async function fetchGoogleTokenInfo(idToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.googleapis.com',
      path: `/oauth2/v3/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const tokenData = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(tokenData);
          } else {
            const error = new Error(`Google token validation failed: ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.responseBody = tokenData;
            reject(error);
          }
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Google OAuth configuration
const DEFAULT_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '638788559518-has2jchutlob4bj1cud789u2vjs13pkv.apps.googleusercontent.com';
const configuredGoogleClientIds = process.env.GOOGLE_CLIENT_IDS
  ? process.env.GOOGLE_CLIENT_IDS.split(',').map(id => id.trim()).filter(Boolean)
  : [];
const GOOGLE_CLIENT_IDS = Array.from(
  new Set([
    ...(process.env.GOOGLE_CLIENT_ID ? [process.env.GOOGLE_CLIENT_ID.trim()] : []),
    ...configuredGoogleClientIds,
    DEFAULT_GOOGLE_CLIENT_ID,
  ])
);

// ✅ Import optimization utilities
const { Logger } = require('./utils/logger');
const { sendError, sendSuccess } = require('./utils/responseHandler');
const { validateUserData } = require('./utils/userRegistration');
const { userCache } = require('./utils/userCache');
const { mongoDBManager } = require('./utils/mongoDBManager');
const { sendOtpEmail, isEmailConfigured } = require('./utils/emailService');
const { createOtpForEmail, verifyOtpForEmail, startOtpCleanup } = require('./utils/otpStore');
const cors = require('cors');

// ✅ Import enhancement middleware
const { validateAuth, validateRegistration, validateProfileUpdate } = require('./middleware/validation');
const { globalRateLimit, createRateLimiter, startCleanupInterval } = require('./middleware/rateLimiter');
const { errorHandler, notFoundHandler, asyncHandler } = require('./middleware/errorHandler');

// ✅ Import enhancement utilities
const health = require('./utils/health');

// Set log level based on environment
Logger.setLevel(process.env.NODE_ENV === 'development' ? Logger.LOG_LEVELS.DEBUG : Logger.LOG_LEVELS.INFO);

const app = express();
const server = http.createServer(app);

let ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];

// Backwards-compatible developer convenience: allow wildcard in development only.
if (ALLOWED_ORIGINS.length === 0) {
  // If no origins specified, default to a strict empty list in production
  if (process.env.NODE_ENV === 'development') {
    ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:8080'];
    Logger.info('cors', 'No ALLOWED_ORIGINS set; using development defaults', { ALLOWED_ORIGINS });
  } else {
    Logger.warn('cors', 'No ALLOWED_ORIGINS configured; CORS will be restricted. Set ALLOWED_ORIGINS in env to allow origins.');
  }
} else if (ALLOWED_ORIGINS.includes('*') && process.env.NODE_ENV !== 'development') {
  // Prevent wildcard in non-dev to avoid accidental open CORS in production
  Logger.warn('cors', 'Wildcard origin (*) detected in ALLOWED_ORIGINS in non-development environment. Removing wildcard for safety.');
  ALLOWED_ORIGINS = ALLOWED_ORIGINS.filter(o => o !== '*');
}

const corsOptions = {
  origin: (origin, callback) => {
    // Allow same-origin or no origin (e.g., curl, server-to-server)
    if (!origin) return callback(null, true);
    
    // Check string origins
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    
    // In development, allow any localhost:* origin (for Flutter dev server, etc.)
    if (process.env.NODE_ENV === 'development' && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    
    return callback(new Error('CORS policy: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// ✅ Add JSON parsing middleware with compression
app.use(compression()); // ✅ Gzip compression for all responses
app.use(helmet()); // ✅ Security headers (X-Frame-Options, Content-Security-Policy, etc.)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors(corsOptions));

// ✅ Register global middleware (BEFORE routes)
app.use(globalRateLimit);

// ✅ Health check endpoint
app.get('/health', health.handleHealthCheck);

// ✅ Register database health check
health.registerService('database', async () => {
  try {
    await mongoose.connection.db.admin().ping();
    return { status: 'healthy', message: 'MongoDB connected' };
  } catch (err) {
    return { status: 'unhealthy', message: err.message };
  }
});

// ✅ Start health monitoring
health.startMonitoring(60);

// ✅ Start rate limit cleanup
startCleanupInterval();
startOtpCleanup();

// ========== MONGODB CONNECTION CONSTANTS ==========
// 🔐 MongoDB Atlas Connection String (from environment variable)
// Format: mongodb+srv://username:password@cluster.mongodb.net/databaseName?options
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not configured. Set it in .env or environment variables.');
  process.exit(1);
}

const dbNameMatch = MONGODB_URI.match(/^[^\/]+\/([^?]+)(\?|$)/);
const configuredDb = dbNameMatch ? dbNameMatch[1] : null;
if (!configuredDb) {
  console.error('❌ MongoDB URI does not include a database name. This backend requires a target database.');
  console.error('   Expected URI like: mongodb+srv://user:password@cluster.mongodb.net/lolcluster?retryWrites=true&w=majority');
  process.exit(1);
}
if (configuredDb !== 'lolcluster') {
  console.warn(`⚠️ MongoDB URI uses database '${configuredDb}'. Confirm this is the intended target.`);
}

console.log(`🔐 MongoDB URI loaded and targeting database: ${configuredDb}`);

const MONGODB_CONFIG = {
  URI: MONGODB_URI,
  options: {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    maxPoolSize: 10,
    minPoolSize: 2,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    retryWrites: true,
    retryReads: true,
    writeConcern: { w: 'majority' },
  },
};

// ========== CONFIGURATION ==========
const CONFIG = {
  PORT: process.env.PORT || 8080,
  // ✅ For development: Use 0.0.0.0 (accessible from Android emulator at 10.0.2.2)
  // For production: Set SERVER_IP env var to public IP
  SERVER_IP: process.env.SERVER_IP || 'localhost',
  // Host/interface to bind the HTTP server to (defaults to all interfaces for emulator access)
  SERVER_BIND: process.env.SERVER_BIND || '0.0.0.0',
  STALE_TIMEOUT: 5 * 60 * 1000, // 5 minutes
  CLEANUP_INTERVAL: 60 * 1000, // 60 seconds
  MAX_USERNAME_LENGTH: 50,
  // ✅ GROUP ROOM CAPACITY: 10-user limit per room with auto-replica creation
  GROUP_ROOM_CAPACITY: 10,
  // ✅ OPTIMIZE: Faster member list sync
  MEMBER_SYNC_INTERVAL: 500, // ms - how often to sync member list to room
  PRESENCE_BROADCAST_INTERVAL: 250, // ms - debounce status broadcasts
  // Optional TURN config via environment variables
  TURN_URL: process.env.TURN_URL || null,
  TURN_USERNAME: process.env.TURN_USERNAME || null,
  TURN_CREDENTIAL: process.env.TURN_CREDENTIAL || null,
  // Default ICE servers (will include TURN if provided via env)
  DEFAULT_ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  // Suggested media constraints clients can use to improve quality
  MEDIA_CONSTRAINTS: {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: true,
    // Suggested target bitrate in kbps for clients to try to apply via setParameters
    suggestedVideoBitrateKbps: 1000,
  },
};

const isDatabaseConnected = () => mongoose.connection.readyState === 1;
let serverStarted = false;

function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  server.listen(CONFIG.PORT, CONFIG.SERVER_BIND, () => {
    Logger.info('startup', 'WebSocket server listening', {
      bind: CONFIG.SERVER_BIND,
      advertisedIP: CONFIG.SERVER_IP,
      port: CONFIG.PORT,
    });
  });
}

// ========== MONGODB CONNECTION ==========
const safeMongoUri = MONGODB_CONFIG.URI.replace(/^(mongodb(?:\+srv)?:\/\/)([^@]+@)?/, '$1****@');
console.log('🔄 Connecting to MongoDB...');
console.log(`📍 MongoDB Host: ${safeMongoUri}`);

// ✅ START SERVER IMMEDIATELY (don't wait for MongoDB)
// This allows Cloud Run health check to pass while MongoDB connects in the background
startServer();

// ✅ IMPROVED: Use MongoDB Manager with exponential backoff retry
Logger.info('mongodb', '🔄 Initializing MongoDB connection manager', {
  uri: safeMongoUri,
});

(async () => {
  let connected = await mongoDBManager.connect(MONGODB_CONFIG.URI, MONGODB_CONFIG.options);

  if (!connected) {
    // Attempt to reconnect with exponential backoff
    const reconnectLoop = async () => {
      if (!mongoDBManager.getConnectionStatus()) {
        connected = await mongoDBManager.reconnect(MONGODB_CONFIG.URI, MONGODB_CONFIG.options);
        if (!connected && mongoDBManager.reconnectAttempts < mongoDBManager.maxReconnectAttempts) {
          // Schedule next reconnection attempt
          return;
        }
      }
    };

    // Attempt reconnection every 5 seconds if not connected
    const reconnectInterval = setInterval(async () => {
      if (mongoDBManager.getConnectionStatus()) {
        clearInterval(reconnectInterval);
        health.setDbConnected(true);
        Logger.info('mongodb', '✅ Database reconnected successfully');
      } else {
        await reconnectLoop();
      }
    }, 5000);
  } else {
    health.setDbConnected(true);
  }
})();

// Handle MongoDB connection events
mongoose.connection.on('disconnected', () => {
  Logger.warn('mongodb', '⚠️ Disconnected from MongoDB');
  health.setDbConnected(false);
});

mongoose.connection.on('error', (err) => {
  Logger.error('mongodb', '❌ MongoDB error', err.message);
  health.setDbConnected(false);
});


// ✅ OPTIMIZED: Socket.IO Configuration for maximum performance
const io = socketIO(server, {
  cors: {
    origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
  
  // ✅ OPTIMIZED: Transport options - prefer WebSocket only to avoid polling/backpressure
  transports: ['websocket'],
  // Allow older engine.io v3 clients (mobile clients may use older engines)
  allowEIO3: true,
  
  // ✅ OPTIMIZED: Connection timing
  pingInterval: 10000,  // Check connection every 10s (was 15s)
  pingTimeout: 4000,    // Wait 4s for pong (was 45s) - faster detection
  
  // ✅ CRITICAL FIX: Payload settings
  // Increased from 100KB to 5MB to allow profile images in register_user payload
  // Server-side validation will discard large images before re-emitting
  maxHttpBufferSize: 5 * 1024 * 1024,  // 5MB max payload (allows initial profile image upload)
  
  // ✅ OPTIMIZED: Connection settings
  upgrade: true,           // Allow upgrade from polling to WebSocket
  rememberUpgrade: true,   // Remember which transport works
  connectTimeout: 5000,    // 5s to establish connection
});

// ✅ NEW: Global Socket.IO error handler for connection issues
io.engine.on('connection_error', (err) => {
  Logger.error('io_engine', '❌ Socket.IO connection error', {
    code: err.code,
    message: err.message,
    transport: err.req?.url || 'unknown',
  });
});

// ✅ NEW: Log all socket disconnection reasons
io.on('disconnect', (reason) => {
  Logger.warn('io_disconnect', `🔴 Global disconnect: ${reason}`);
});

// ========== MONGODB SCHEMAS ==========

// User Schema
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true, index: true },
  userName: { type: String, required: true, index: true },
  email: { type: String, unique: true, sparse: true, index: true, lowercase: true },
  authType: { type: String, enum: ['GOOGLE_OAUTH', 'LOCAL', 'GUEST'], default: 'LOCAL', index: true },
  isGuest: { type: Boolean, default: false, index: true },
  
  // Profile Information
  gender: { type: String, enum: ['male', 'female', 'other'], default: 'other' },
  country: { type: String, default: null, index: true },
  birthDate: { type: Date, default: null },
  profileComplete: { type: Boolean, default: false, index: true }, // ✅ Track if user completed profile setup
  
  // Avatar & Profile
  avatarColor: { type: String, default: '#128C7E' },
  avatarLetter: { type: String, default: 'U' },
  profileImageUrl: { type: String, default: null },
  passwordHash: { type: String, default: null },
  useColorProfile: { type: Boolean, default: true },
  pictureName: { type: String, default: null },
  emailVerified: { type: Boolean, default: false, index: true },
  emailVerifiedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null, index: true },

  // Stats & achievements
  xp: { type: Map, of: Number, default: {} },
  
  // Account Status
  isActive: { type: Boolean, default: true, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now, index: true },
  lastLogin: { type: Date, default: null, index: true },
});

// ✅ Create compound indexes for common query patterns
userSchema.index({ isActive: 1, createdAt: -1 }); // Get active users by creation date
userSchema.index({ country: 1, isActive: 1 }); // Find users by country
userSchema.index({ authType: 1, isActive: 1 }); // Auth type filtering
userSchema.index({ email: 1, isGuest: 1 }); // Email lookups
userSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true }); // Guest account TTL cleanup

// ✅ Helper function to normalize xp output (handles legacy starCount fallback)
function getUserXp(user) {
  if (!user) return {};
  if (user.xp && typeof user.xp === 'object') {
    return user.xp;
  }
  if (user.starCount != null) {
    return { total: Number(user.starCount) || 0 };
  }
  return {};
}

// Blocked Users Schema (tracks blocks and time-based unblocks)
const blockedUserSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  blockedByUserId: { type: String, required: true, index: true },
  reason: { type: String, default: 'User reported' },
  blockType: { type: String, enum: ['report', 'manual'], default: 'report' },
  blockDuration: { type: Number, default: null },
  blockedUntil: { type: Date, default: null, index: true }, // TTL cleanup query
  reportCount: { type: Number, default: 1 },
  reporters: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

// ✅ Compound index for block lookups
blockedUserSchema.index({ userId: 1, blockedByUserId: 1 }, { unique: true });
blockedUserSchema.index({ blockedUntil: 1 }, { sparse: true }); // Sparse index for TTL

// Report History Schema (tracks all reports against a user)
const reportSchema = new mongoose.Schema({
  reportedUserId: { type: String, required: true, index: true },
  reporterId: { type: String, required: true },
  reason: { type: String, default: 'User reported' },
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // Auto-delete after 24 hours
});

// ✅ NEW: Friends Schema (tracks friend relationships)
const friendSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  friendId: { type: String, required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted'], default: 'accepted' },
  createdAt: { type: Date, default: Date.now, index: true },
});

// Compound index for friend lookups
friendSchema.index({ userId: 1, friendId: 1 }, { unique: true });
friendSchema.index({ friendId: 1, userId: 1 });

// Create Models
const User = mongoose.model('User', userSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);
const Report = mongoose.model('Report', reportSchema);
const Friend = mongoose.model('Friend', friendSchema);

// Simple lookup endpoint to help debug join-by-invite behavior from clients
app.get('/room/by-invite/:code', (req, res) => {
  try {
    const code = (req.params.code || '').toString().trim().toUpperCase();
    if (!code) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CODE',
          message: 'Invite code is required and cannot be empty',
        },
      });
    }

    for (const room of rooms.values()) {
      if (room.inviteCode && room.inviteCode.toUpperCase() === code) {
        return res.json({
          success: true,
          room: {
            roomId: room.roomId,
            roomName: room.roomName,
            creatorName: room.creatorName,
            memberCount: room.memberIds.length,
            maxMembers: room.maxMembers,
            status: room.status,
          },
        });
      }
    }
    return res.status(404).json({
      success: false,
      error: {
        code: 'ROOM_NOT_FOUND',
        message: 'Room with the specified invite code not found',
      },
    });
  } catch (err) {
    Logger.error('http', 'Error in /room/by-invite', err && err.message);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred while looking up the room',
      },
    });
  }
});

// ✅ Create rate limiters for auth endpoints
const validateTokenLimiter = createRateLimiter('validate-token', 10, 15 * 60); // 10 per 15 minutes
const registerLimiter = createRateLimiter('register', 3, 60 * 60); // 3 per hour
const loginLimiter = createRateLimiter('login', 5, 15 * 60); // 5 per 15 minutes

// Google OAuth Token Validation Endpoint (No Firebase required)
app.post('/auth/validate-token', validateTokenLimiter, asyncHandler(async (req, res) => {
  try {
    const { idToken, googleUser, googleUserData } = req.body;
    const userMeta = googleUser || googleUserData;

    if (!idToken) {
      return sendError(res, 400, 'ID token is required');
    }

    // Validate token with Google's API
    let tokenData;
    try {
      tokenData = await fetchGoogleTokenInfo(idToken);
    } catch (fetchErr) {
      Logger.warn(
        'oauth/validate',
        'Token validation failed',
        {
          message: fetchErr.message,
          statusCode: fetchErr.statusCode,
          responseBody: fetchErr.responseBody,
        }
      );
      return sendError(res, 401, 'Invalid or expired token', 'INVALID_TOKEN');
    }

    if (!isDatabaseConnected()) {
      return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
    }

    const tokenAudiences = Array.isArray(tokenData.aud) ? tokenData.aud : [tokenData.aud];
    const tokenAuthorizedParty = tokenData.azp ? [tokenData.azp] : [];
    const tokenIssuer = tokenData.iss;
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];

    const validatedAudiences = Array.from(
      new Set([
        ...tokenAudiences.filter(Boolean),
        ...tokenAuthorizedParty.filter(Boolean),
      ])
    );

    const audienceMatches = validatedAudiences.some(aud => GOOGLE_CLIENT_IDS.includes(aud));
    if (!audienceMatches) {
      Logger.warn('oauth/validate', 'Google ID token audience mismatch', {
        expected: GOOGLE_CLIENT_IDS,
        actualAud: tokenData.aud,
        actualAzp: tokenData.azp,
      });
      return sendError(res, 401, 'Invalid token audience', 'INVALID_TOKEN_AUDIENCE');
    }

    if (!validIssuers.includes(tokenIssuer)) {
      Logger.warn('oauth/validate', 'Google ID token issuer invalid', {
        issuer: tokenIssuer,
      });
      return sendError(res, 401, 'Invalid token issuer', 'INVALID_TOKEN_ISSUER');
    }

    Logger.info('oauth/validate', '✅ Token validated successfully', {
      userId: tokenData.sub,
      emailVerified: tokenData.email_verified,
    });

    // ✅ Save or update user in MongoDB after Google validation
    const userId = tokenData.sub;
    console.log('🔍 Token data sub:', tokenData.sub, 'type:', typeof tokenData.sub);
    const userParams = {
      userId,
      userName: userMeta?.displayName || tokenData.name || 'User',
      email: tokenData.email || userMeta?.email || null,
      authType: 'GOOGLE_OAUTH',
      isGuest: false,
      profileImageUrl: tokenData.picture || userMeta?.photoUrl || null,
      lastLogin: new Date(),
      updatedAt: new Date(),
    };

    let savedUser = null;
    let isExistingUser = false;

    try {
      // ✅ STEP 1: Check if email ALREADY EXISTS before upserting
      // This is the PRIMARY way to determine if user is returning or new
      let fullExistingUser = null;
      const userEmail = userParams.email?.toLowerCase();
      
      if (userEmail) {
        fullExistingUser = await User.findOne({ email: userEmail });
        if (fullExistingUser) {
          Logger.info('oauth/validate', '✅ Existing user found by email', { 
            userId: fullExistingUser.userId,
            email: userEmail,
            profileComplete: fullExistingUser.profileComplete
          });
        }
      }

      // If no email match, check by userId as fallback
      if (!fullExistingUser && userId) {
        fullExistingUser = await User.findOne({ userId });
        if (fullExistingUser) {
          Logger.info('oauth/validate', '✅ Existing user found by userId', { 
            userId,
            email: fullExistingUser.email,
            profileComplete: fullExistingUser.profileComplete
          });
        }
      }

      const updateData = {
        userName: userParams.userName,
        email: userParams.email,
        authType: userParams.authType,
        isGuest: userParams.isGuest,
        profileImageUrl: userParams.profileImageUrl,
        lastLogin: userParams.lastLogin,
        updatedAt: userParams.updatedAt,
      };

      Logger.debug('oauth/validate', '🔄 Upserting user to MongoDB', { userId });

      // ✅ STEP 2: Update or create the user
      savedUser = await User.findOneAndUpdate(
        { userId },
        {
          $set: updateData,
          $setOnInsert: {
            userId,
            gender: 'other',
            country: null,
            avatarColor: '#128C7E',
            profileComplete: false, // Default to false for new users
            createdAt: new Date(),
          },
        },
        { upsert: true, new: true, lean: true, setDefaultsOnInsert: true }
      );

      Logger.info('oauth/validate', '✅ User upserted successfully', { userId });

      // ✅ STEP 3: Determine if user is existing
      // Source of truth: Was user in database BEFORE this upsert?
      isExistingUser = fullExistingUser !== null;
      
      Logger.info('oauth/validate', '📊 User Status', {
        userId,
        email: userEmail,
        isExistingUser,
        profileComplete: savedUser?.profileComplete || false,
        hasGender: !!savedUser?.gender,
        hasCountry: !!savedUser?.country
      });

      // ✅ Return complete user profile with all required fields
      const userResponse = {
        userId: savedUser.userId,
        userName: savedUser.userName,
        email: savedUser.email,
        gender: savedUser.gender || 'other',
        country: savedUser.country || null,
        birthDate: savedUser.birthDate || null,
        avatarColor: savedUser.avatarColor || '#128C7E',
        profileImageUrl: savedUser.profileImageUrl || null,
        profileImagePath: savedUser.profileImagePath || null,
        profileComplete: savedUser.profileComplete === true,
        xp: getUserXp(savedUser),
        authType: savedUser.authType,
        isGuest: savedUser.isGuest || false,
        lastLogin: savedUser.lastLogin,
        createdAt: savedUser.createdAt,
      };

      return sendSuccess(res, {
        isExistingUser,
        user: userResponse,
      }, `Token validated - ${isExistingUser ? 'Existing' : 'New'} user`);
    } catch (mongoErr) {
      Logger.error('oauth/validate', 'Error upserting user to MongoDB', mongoErr?.message);
      return sendError(res, 500, 'Database error', { details: mongoErr?.message });
    }
  } catch (err) {
    Logger.error('oauth/validate', 'Error validating token', err && err.message);
    return sendError(res, 500, 'Token validation error', { details: err?.message });
  }
}));

// ========== NEW: REGISTER ENDPOINT ==========
app.post('/auth/register', registerLimiter, validateRegistration, asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const {
      userId: requestedUserId,
      userName,
      email,
      password,
      gender,
      country,
      avatarColor,
      birthDate,
      profileImageUrl,
      pictureName,
      emailVerified,
    } = req.body;

    if (!userName || !email || !password) {
      return sendError(res, 400, 'userName, email, and password are required', 'VALIDATION_ERROR');
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const newUserId = requestedUserId && String(requestedUserId).trim().length > 0
      ? String(requestedUserId).trim()
      : `local_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Check if user already exists by email or generated userId
    const existingUser = await User.findOne({ $or: [{ userId: newUserId }, { email: normalizedEmail }] });
    if (existingUser) {
      return sendError(res, 409, 'User already exists', 'USER_EXISTS');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const birthDateValue = birthDate ? new Date(String(birthDate)) : null;

    const newUser = new User({
      userId: newUserId,
      userName: String(userName).trim(),
      email: normalizedEmail,
      passwordHash: hashedPassword,
      authType: 'LOCAL',
      isGuest: false,
      gender: gender ? String(gender).toLowerCase() : 'other',
      country: country || null,
      birthDate: birthDateValue,
      avatarColor: avatarColor || '#128C7E',
      profileImageUrl: profileImageUrl || null,
      pictureName: pictureName || null,
      emailVerified: emailVerified === true,
      emailVerifiedAt: emailVerified === true ? new Date() : null,
      profileComplete: true,
      lastLogin: new Date(),
    });

    await newUser.save();

    Logger.info('auth/register', '✅ New user registered', { userId: newUserId, email: normalizedEmail });

    return sendSuccess(res, {
      user: {
        userId: newUser.userId,
        userName: newUser.userName,
        email: newUser.email,
        authType: newUser.authType,
        isGuest: newUser.isGuest,
        avatarColor: newUser.avatarColor,
        gender: newUser.gender,
        country: newUser.country,
      },
    }, 'User registered successfully');
  } catch (err) {
    Logger.error('auth/register', 'Error registering user', err.message);
    return sendError(res, 500, 'Registration error', { details: err.message });
  }
}));

// ========== NEW: LOGIN ENDPOINT ==========
app.post('/auth/login', loginLimiter, validateAuth, asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const { userId, email, password } = req.body;
    const normalizedEmail = email ? String(email).toLowerCase().trim() : null;

    Logger.debug('auth/login', 'Login request received', {
      userId: userId ? String(userId).trim() : null,
      email: normalizedEmail ? normalizedEmail.replace(/(.{2}).+@/, '$1***@') : null,
    });

    if (!userId && !normalizedEmail) {
      return sendError(res, 400, 'userId or email is required');
    }

    if (!password) {
      return sendError(res, 400, 'Password is required', 'VALIDATION_ERROR');
    }

    const lookup = { $or: [] };
    if (userId) lookup.$or.push({ userId: String(userId).trim() });
    if (normalizedEmail) lookup.$or.push({ email: normalizedEmail });

    if (lookup.$or.length === 0) {
      return sendError(res, 400, 'userId or email is required');
    }

    const user = await User.findOne(lookup);

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (!user.passwordHash) {
      return sendError(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return sendError(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }

    user.lastLogin = new Date();
    await user.save();

    Logger.info('auth/login', '✅ User logged in', { userId: user.userId, email: user.email });

    return sendSuccess(res, {
      user: {
        userId: user.userId,
        userName: user.userName,
        email: user.email,
        authType: user.authType,
        isGuest: user.isGuest,
        gender: user.gender,
        country: user.country,
        avatarColor: user.avatarColor,
        profileImageUrl: user.profileImageUrl,
        xp: getUserXp(user),
        profileComplete: user.profileComplete || false,
        lastLogin: user.lastLogin,
      },
    }, 'Login successful');
  } catch (err) {
    Logger.error('auth/login', 'Error during login', err.message);
    return sendError(res, 500, 'Login error', { details: err.message });
  }
}));

const sendOtpLimiter = createRateLimiter('send-otp', 5, 15 * 60); // 5 per 15 minutes
const verifyOtpLimiter = createRateLimiter('verify-otp', 10, 15 * 60); // 10 per 15 minutes

app.post('/auth/send-otp', sendOtpLimiter, asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  if (!isEmailConfigured()) {
    return sendError(res, 503, 'OTP email service is not configured', 'OTP_CONFIG_ERROR');
  }

  const { email } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }

  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const otp = await createOtpForEmail(normalizedEmail);

    sendOtpEmail(normalizedEmail, otp)
      .then((info) => {
        Logger.info('auth/send-otp', 'OTP email queued for delivery', {
          to: normalizedEmail,
          messageId: info.messageId,
        });
      })
      .catch((sendError) => {
        Logger.error(
          'auth/send-otp',
          'OTP email delivery failed after response was returned',
          sendError?.message || sendError,
        );
      });

    return sendSuccess(res, {
      email: normalizedEmail,
      expiresIn: Number(process.env.OTP_EXPIRE_SECONDS || 300),
    }, 'OTP requested. Check your email shortly.');
  } catch (err) {
    const message = err?.message || 'Unable to send OTP';
    Logger.error('auth/send-otp', 'Error sending OTP', message);

    if (err?.code === 'OTP_RESEND_WAIT') {
      return sendError(res, 429, message, {
        code: 'OTP_RESEND_WAIT',
        resetTime: new Date(err.resetTime).toISOString(),
      });
    }

    return sendError(res, 500, message, { code: 'OTP_SEND_ERROR', details: err?.message });
  }
}));

app.post('/auth/verify-otp', verifyOtpLimiter, asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { email, otp } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }

  if (!otp || typeof otp !== 'string' || otp.trim().length === 0) {
    return sendError(res, 400, 'OTP is required', 'INVALID_OTP');
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const result = await verifyOtpForEmail(normalizedEmail, otp.trim());

  if (!result.success) {
    const reason = result.reason || 'OTP_INVALID';
    const message = reason === 'OTP_EXPIRED'
      ? 'OTP expired. Please request a new one.'
      : reason === 'OTP_TOO_MANY_ATTEMPTS'
        ? 'Too many verification attempts. Please request a new OTP.'
        : 'OTP did not match. Please try again.';

    return sendError(res, 400, message, reason);
  }

  return sendSuccess(res, { verified: true }, 'OTP verified successfully');
}));

const forgotPasswordLimiter = createRateLimiter('forgot-password', 5, 15 * 60);
const resetPasswordLimiter = createRateLimiter('reset-password', 5, 15 * 60);

app.post('/auth/forgot-password', forgotPasswordLimiter, asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { email } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const user = await User.findOne({ email: normalizedEmail }).lean();

  if (!user) {
    Logger.info('auth/forgot-password', 'Password reset request for unknown email', { email: normalizedEmail });
  }

  try {
    const otp = await createOtpForEmail(normalizedEmail);
    await sendOtpEmail(normalizedEmail, otp);
    return sendSuccess(res, { email: normalizedEmail }, 'Password reset OTP sent if the email is registered');
  } catch (err) {
    Logger.error('auth/forgot-password', 'Error sending password reset OTP', err.message);
    return sendError(res, 500, 'Unable to send password reset OTP', { code: 'OTP_SEND_ERROR', details: err?.message });
  }
}));

app.post('/auth/reset-password', resetPasswordLimiter, asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  const { email, otp, newPassword } = req.body;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return sendError(res, 400, 'Email is required', 'INVALID_EMAIL');
  }
  if (!otp || typeof otp !== 'string' || otp.trim() === '') {
    return sendError(res, 400, 'OTP is required', 'INVALID_OTP');
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return sendError(res, 400, 'New password must be at least 6 characters', 'INVALID_PASSWORD');
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const result = await verifyOtpForEmail(normalizedEmail, otp.trim());
  if (!result.success) {
    const reason = result.reason || 'OTP_INVALID';
    const message = reason === 'OTP_EXPIRED'
      ? 'OTP expired. Please request a new one.'
      : reason === 'OTP_TOO_MANY_ATTEMPTS'
        ? 'Too many verification attempts. Please request a new OTP.'
        : 'OTP did not match. Please try again.';

    return sendError(res, 400, message, reason);
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return sendError(res, 404, 'Email is not registered', 'USER_NOT_FOUND');
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.passwordHash = hashedPassword;
    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    user.updatedAt = new Date();
    await user.save();

    Logger.info('auth/reset-password', 'Password reset successfully', { email: normalizedEmail, userId: user.userId });
    return sendSuccess(res, { email: normalizedEmail }, 'Password reset successfully');
  } catch (err) {
    Logger.error('auth/reset-password', 'Error resetting password', err.message);
    return sendError(res, 500, 'Unable to reset password', { code: 'RESET_PASSWORD_ERROR', details: err?.message });
  }
}));

// ========== NEW: CHECK EMAIL EXISTS ENDPOINT ==========
// ✅ CRITICAL: Frontend calls this to check if email is registered (for new/existing user detection)
// Called on fresh Google login to determine if user is new or returning
app.get('/auth/check-email', asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const { email } = req.query;

    if (!email || typeof email !== 'string' || email.trim() === '') {
      return sendError(res, 400, 'Email query parameter is required', 'INVALID_EMAIL');
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Query for user with this email (case-insensitive)
    const existingUser = await User.findOne({
      email: { $regex: `^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
    });

    if (existingUser) {
      // ✅ EMAIL EXISTS - Return user profile for direct home navigation
      Logger.info('auth/check-email', '✅ Email found in database', { email: normalizedEmail, userId: existingUser.userId });

      return sendSuccess(res, {
        exists: true,
        user: {
          userId: existingUser.userId,
          userName: existingUser.userName,
          email: existingUser.email,
          authType: existingUser.authType,
          isGuest: existingUser.isGuest || false,
          gender: existingUser.gender || 'other',
          country: existingUser.country || null,
          birthDate: existingUser.birthDate || null,
          avatarColor: existingUser.avatarColor || '#128C7E',
          profileImageUrl: existingUser.profileImageUrl || null,
          profileComplete: existingUser.profileComplete === true, // ✅ Critical flag for profile check
          xp: getUserXp(existingUser),
          createdAt: existingUser.createdAt,
          lastLogin: existingUser.lastLogin,
        }
      }, 'Email found - returning user');
    } else {
      // ✅ EMAIL NOT FOUND - New user, should proceed to profile creation
      Logger.info('auth/check-email', 'ℹ️ Email not found in database', { email: normalizedEmail });
      
      return sendError(res, 404, 'Email not registered', 'EMAIL_NOT_FOUND');
    }
  } catch (err) {
    Logger.error('auth/check-email', 'Error checking email', err.message);
    return sendError(res, 500, 'Email check error', { details: err.message });
  }
}));

// ========== NEW: GUEST LOGIN ENDPOINT ==========
// ✅ OPTIMIZED: Quick guest account creation with TTL cleanup
const guestLimiter = createRateLimiter('guest-login', 20, 60); // 20 per minute
app.post('/auth/guest-login', guestLimiter, asyncHandler(async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const { deviceId } = req.body;
    
    // ✅ OPTIMIZED: Generate unique guest ID based on timestamp + random
    const guestId = `guest_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const guestName = `Guest${Math.floor(Math.random() * 9000) + 1000}`;

    // ✅ Create guest user (auto-expire after 24 hours)
    const guestUser = new User({
      userId: guestId,
      userName: guestName,
      email: null,
      authType: 'GUEST',
      isGuest: true,
      gender: 'other',
      country: null,
      avatarColor: '#6200EE',
      profileImageUrl: null,
      lastLogin: new Date(),
      // TTL cleanup: Guest accounts expire after 24 hours
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await guestUser.save();

    Logger.info('auth/guest-login', '✅ Guest account created', { userId: guestId, deviceId });

    return sendSuccess(res, {
      user: {
        userId: guestUser.userId,
        userName: guestUser.userName,
        authType: 'GUEST',
        isGuest: true,
        avatarColor: guestUser.avatarColor,
        gender: guestUser.gender,
        country: guestUser.country,
        lastLogin: guestUser.lastLogin,
      },
    }, 'Guest account created');
  } catch (err) {
    Logger.error('auth/guest-login', 'Error creating guest account', err.message);
    return sendError(res, 500, 'Guest login error', { details: err.message });
  }
}));

// ========== PERFORMANCE: SYSTEM STATS ENDPOINT ==========
app.get('/stats/system', (req, res) => {
  const cacheStats = userCache.getStats();
  const dbStats = mongoDBManager.getStats();
  
  return sendSuccess(res, {
    cache: cacheStats,
    database: dbStats,
    timestamp: new Date().toISOString(),
  });
});

// ========== PERFORMANCE: CACHE MANAGEMENT ==========
app.post('/cache/clear', (req, res) => {
  const sizeBefore = userCache.cache.size;
  userCache.clear();
  Logger.info('cache/clear', 'Cache cleared', { sizeBefore });
  return sendSuccess(res, { cleared: sizeBefore });
});

// ========== NEW: GET USER PROFILE ENDPOINT ==========
app.get('/user/:userId', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const { userId } = req.params;

    // ✅ PERFORMANCE: Check cache first
    let user = userCache.get(userId);
    
    if (!user) {
      // ✅ Optimize query with .lean() for read-only operations
      user = await User.findOne({ userId }).lean().exec();
      
      if (!user) {
        return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
      }
      
      // ✅ Cache the result for future requests
      userCache.set(userId, user);
    }

    return sendSuccess(res, {
      user: {
        userId: user.userId,
        userName: user.userName,
        email: user.email,
        authType: user.authType,
        isGuest: user.isGuest,
        gender: user.gender,
        country: user.country,
        avatarColor: user.avatarColor,
        profileImageUrl: user.profileImageUrl,
        xp: getUserXp(user),
        profileComplete: user.profileComplete || false,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      },
    });
  } catch (err) {
    Logger.error('user/get', 'Error retrieving user', err.message);
    return sendError(res, 500, 'Error retrieving user', { details: err.message });
  }
});

// ========== NEW: SEARCH USERS ENDPOINT ==========
app.get('/users/search', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }

  try {
    const queryValue = req.query.q;
    const searchText = Array.isArray(queryValue)
      ? String(queryValue[0]).trim()
      : String(queryValue ?? '').trim();

    if (!searchText) {
      return sendError(res, 400, 'Search query is required', 'VALIDATION_ERROR');
    }

    // ✅ FIXED: Create case-insensitive regex for fuzzy search
    const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fuzzyRegex = new RegExp(escaped, 'i');

    // ✅ IMPROVED: Search without isActive filter for better results
    // Include users even if isActive is not set or false (for compatibility with old data)
    const users = await User.find({
      $or: [
        { userName: fuzzyRegex },
        { userId: fuzzyRegex },
        { email: fuzzyRegex },
      ],
    })
      .select('userId userName email gender country avatarColor avatarLetter profileImageUrl profileImagePath createdAt lastLogin xp')
      .sort({ createdAt: -1 })
      .limit(25)
      .lean()
      .exec();

    Logger.info('users/search', `Search results: ${users.length} users found`, {
      query: searchText,
      count: users.length,
    });

    // ✅ PERFORMANCE: Cache results for repeated queries
    users.forEach(user => {
      userCache.set(user.userId, user);
    });

    // ✅ ENHANCED: Return all fields frontend needs
    return res.status(200).json(users.map((user) => ({
      userId: user.userId,
      userName: user.userName,
      email: user.email,
      gender: user.gender,
      country: user.country,
      avatarColor: user.avatarColor,
      avatarLetter: (user.userName && user.userName.length > 0) 
        ? user.userName.charAt(0).toUpperCase() 
        : 'U',
      profileImageUrl: user.profileImageUrl,
      profileImagePath: user.profileImagePath,
      isOnline: false,
      xp: getUserXp(user),
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    })));

  } catch (err) {
    Logger.error('users/search', 'Error searching users', err.message);
    return sendError(res, 500, 'Error searching users', { details: err.message });
  }
});

// ========== NEW: SEND FRIEND REQUEST ENDPOINT ==========
app.post('/friends/add', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const { friendId } = req.body;
    const userId = req.body.userId || req.headers['x-user-id'];

    if (!userId || !friendId) {
      return sendError(res, 400, 'userId and friendId are required');
    }

    if (userId === friendId) {
      return sendError(res, 400, 'Cannot add yourself as a friend');
    }

    // ✅ OPTIMIZED: Check if friend exists with cache or single query
    let friendUser = userCache.get(friendId);
    if (!friendUser) {
      friendUser = await User.findOne({ userId: friendId, isActive: true }).lean().exec();
      if (friendUser) userCache.set(friendId, friendUser);
    }
    
    if (!friendUser) {
      return sendError(res, 404, 'User not found');
    }

    // Check if already friends or pending request
    const existingRequest = await Friend.findOne({
      $or: [
        { userId: userId, friendId: friendId },
        { userId: friendId, friendId: userId },
      ],
    }).lean().exec();

    if (existingRequest) {
      return sendError(res, 400, 'Already friends or request pending');
    }

    // Create pending friend request
    const friendRequest = new Friend({
      userId: userId,
      friendId: friendId,
      status: 'pending',
    });

    await friendRequest.save();

    Logger.info('friends/add', 'Friend request sent', { userId, friendId });

    // ✅ OPTIMIZED: Get sender user for notification from cache
    let senderUser = userCache.get(userId);
    if (!senderUser) {
      senderUser = await User.findOne({ userId: userId }).lean().exec();
      if (senderUser) userCache.set(userId, senderUser);
    }

    // ✅ Emit socket event to notify the recipient if they are online
    const recipientSocketId = userSockets.get(friendId);
    if (recipientSocketId && senderUser) {
      io.to(recipientSocketId).emit('friend_request', {
        requestId: friendRequest._id,
        fromUserId: userId,
        fromUserName: senderUser.userName || 'Unknown',
        fromUserAvatar: senderUser.avatarColor || '#128C7F',
        fromUserImage: senderUser.profileImageUrl,
      });
    } else {
      Logger.info('friends/add', 'Recipient not online', { friendId });
    }

    return res.status(201).json({
      success: true,
      message: 'Friend request sent successfully',
      requestId: friendRequest._id,
    });

  } catch (err) {
    Logger.error('friends/add', 'Error sending friend request', err.message);
    return sendError(res, 500, 'Error sending friend request', { details: err.message });
  }
});

// ========== NEW: ACCEPT FRIEND REQUEST ENDPOINT ==========
app.post('/friends/request/:requestId/accept', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const { requestId } = req.params;
    const userId = req.body.userId || req.headers['x-user-id'];

    if (!userId || !requestId) {
      return sendError(res, 400, 'userId and requestId are required');
    }

    // Find the friend request
    const friendRequest = await Friend.findById(requestId).lean().exec();
    if (!friendRequest) {
      return sendError(res, 404, 'Friend request not found');
    }

    // Verify this user is the recipient
    if (friendRequest.friendId !== userId) {
      return sendError(res, 403, 'Not authorized to accept this request');
    }

    // ✅ OPTIMIZED: Update request status
    const updatedRequest = await Friend.findByIdAndUpdate(
      requestId,
      { status: 'accepted', updatedAt: new Date() },
      { new: true, lean: true }
    ).exec();

    Logger.info('friends/request/accept', 'Friend request accepted', { userId, requestId });

    // ✅ OPTIMIZED: Get recipient data from cache
    let recipientUser = userCache.get(userId);
    if (!recipientUser) {
      recipientUser = await User.findOne({ userId: userId }).lean().exec();
      if (recipientUser) userCache.set(userId, recipientUser);
    }

    // ✅ Emit socket event to notify the sender if they are online
    const senderSocketId = userSockets.get(friendRequest.userId);
    if (senderSocketId && recipientUser) {
      io.to(senderSocketId).emit('friend_request_accepted', {
        requestId: updatedRequest._id,
        userIdAccepted: userId,
        userName: recipientUser.userName || 'Unknown',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Friend request accepted',
    });

  } catch (err) {
    Logger.error('friends/request/accept', 'Error accepting friend request', err.message);
    return sendError(res, 500, 'Error accepting friend request', { details: err.message });
  }
});

// ========== NEW: DENY FRIEND REQUEST ENDPOINT ==========
app.post('/friends/request/:requestId/deny', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const { requestId } = req.params;
    const userId = req.body.userId || req.headers['x-user-id'];

    if (!userId || !requestId) {
      return sendError(res, 400, 'userId and requestId are required');
    }

    // Find and delete the friend request
    const friendRequest = await Friend.findByIdAndDelete(requestId);
    if (!friendRequest) {
      return sendError(res, 404, 'Friend request not found');
    }

    // Verify this user is the recipient
    if (friendRequest.friendId !== userId) {
      return sendError(res, 403, 'Not authorized to deny this request');
    }

    Logger.info('friends/request/deny', 'Friend request denied', { userId, requestId });

    return res.status(200).json({
      success: true,
      message: 'Friend request denied',
    });

  } catch (err) {
    Logger.error('friends/request/deny', 'Error denying friend request', err.message);
    return sendError(res, 500, 'Error denying friend request', { details: err.message });
  }
});

// ========== NEW: REMOVE FRIEND ENDPOINT ==========
app.post('/friends/remove', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const { friendId } = req.body;
    const userId = req.body.userId || req.headers['x-user-id'];

    if (!userId || !friendId) {
      return sendError(res, 400, 'userId and friendId are required');
    }

    if (userId === friendId) {
      return sendError(res, 400, 'Cannot remove yourself as a friend');
    }

    const deleted = await Friend.findOneAndDelete({
      $or: [
        { userId: userId, friendId: friendId },
        { userId: friendId, friendId: userId },
      ],
      status: 'accepted',
    });

    if (!deleted) {
      return sendError(res, 404, 'Friend relationship not found');
    }

    Logger.info('friends/remove', 'Friend removed', { userId, friendId });

    return res.status(200).json({
      success: true,
      message: 'Friend removed successfully',
    });
  } catch (err) {
    Logger.error('friends/remove', 'Error removing friend', err.message);
    return sendError(res, 500, 'Error removing friend', { details: err.message });
  }
});

// ========== NEW: GET FRIENDS LIST ENDPOINT ==========
app.get('/friends/list', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const userId = req.query.userId || req.headers['x-user-id'];

    if (!userId) {
      return sendError(res, 400, 'userId is required');
    }

    // Get all friends
    const friends = await Friend.find({
      $or: [
        { userId: userId },
        { friendId: userId },
      ],
      status: 'accepted',
    }).lean();

    // Get friend user details with all profile fields
    const friendIds = friends.map((f) => (f.userId === userId ? f.friendId : f.userId));
    const friendUsers = await User.find(
      { userId: { $in: friendIds }, isActive: true },
      'userId userName avatarColor avatarLetter profileImageUrl gender country'
    ).lean();

    // ✅ Enhanced: Include online status by checking if user has active socket
    const friendList = friendUsers.map((u) => ({
      userId: u.userId,
      userName: u.userName,
      avatarColor: u.avatarColor,
      avatarLetter: u.avatarLetter || u.userName.charAt(0).toUpperCase(),
      profileImageUrl: u.profileImageUrl,
      gender: u.gender || 'other',
      country: u.country || null,
      isOnline: userSockets.has(u.userId), // ✅ Check if user is currently connected
    }));

    return res.status(200).json({
      success: true,
      friends: friendList,
      count: friendList.length,
    });

  } catch (err) {
    Logger.error('friends/list', 'Error getting friends list', err.message);
    return sendError(res, 500, 'Error getting friends list', { details: err.message });
  }
});

// ========== NEW: GET INCOMING FRIEND REQUESTS ENDPOINT ==========
app.get('/friends/requests/incoming', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const userId = req.query.userId || req.headers['x-user-id'];

    if (!userId) {
      return sendError(res, 400, 'userId is required');
    }

    // Get all incoming friend requests (where user is the recipient)
    const incomingRequests = await Friend.find({
      friendId: userId,
      status: 'pending',
    }).lean();

    // Get sender user details
    const senderIds = incomingRequests.map((r) => r.userId);
    const senderUsers = await User.find(
      { userId: { $in: senderIds }, isActive: true },
      'userId userName avatarColor avatarLetter profileImageUrl gender country'
    ).lean();

    // Map requests to include sender details
    const requestsList = incomingRequests.map((req) => {
      const sender = senderUsers.find((u) => u.userId === req.userId);
      return {
        requestId: req._id.toString(),
        userId: req.userId,
        userName: sender?.userName || 'Unknown',
        avatarColor: sender?.avatarColor,
        avatarLetter: sender?.avatarLetter || (sender?.userName || 'U').charAt(0).toUpperCase(),
        profileImageUrl: sender?.profileImageUrl,
        gender: sender?.gender || 'other',
        country: sender?.country || null,
        createdAt: req.createdAt,
      };
    });

    return res.status(200).json({
      success: true,
      requests: requestsList,
      count: requestsList.length,
    });

  } catch (err) {
    Logger.error('friends/requests/incoming', 'Error getting incoming requests', err.message);
    return sendError(res, 500, 'Error getting incoming requests', { details: err.message });
  }
});

// ========== NEW: GET OUTGOING FRIEND REQUESTS ENDPOINT ==========
app.get('/friends/requests/outgoing', async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not available');
  }

  try {
    const userId = req.query.userId || req.headers['x-user-id'];

    if (!userId) {
      return sendError(res, 400, 'userId is required');
    }

    // Get all outgoing friend requests (where user is the sender)
    const outgoingRequests = await Friend.find({
      userId: userId,
      status: 'pending',
    }).lean();

    // Get recipient user details
    const recipientIds = outgoingRequests.map((r) => r.friendId);
    const recipientUsers = await User.find(
      { userId: { $in: recipientIds }, isActive: true },
      'userId userName avatarColor avatarLetter profileImageUrl gender country'
    ).lean();

    // Map requests to include recipient details
    const requestsList = outgoingRequests.map((req) => {
      const recipient = recipientUsers.find((u) => u.userId === req.friendId);
      return {
        requestId: req._id.toString(),
        userId: req.friendId,
        userName: recipient?.userName || 'Unknown',
        avatarColor: recipient?.avatarColor,
        avatarLetter: recipient?.avatarLetter || (recipient?.userName || 'U').charAt(0).toUpperCase(),
        profileImageUrl: recipient?.profileImageUrl,
        gender: recipient?.gender || 'other',
        country: recipient?.country || null,
        createdAt: req.createdAt,
      };
    });

    return res.status(200).json({
      success: true,
      requests: requestsList,
      count: requestsList.length,
    });

  } catch (err) {
    Logger.error('friends/requests/outgoing', 'Error getting outgoing requests', err.message);
    return sendError(res, 500, 'Error getting outgoing requests', { details: err.message });
  }
});

const VALID_GENDERS = ['male', 'female', 'other'];

function sanitizeGenderInput(genderValue) {
  if (!genderValue || typeof genderValue !== 'string') {
    return null;
  }

  const normalized = String(genderValue).trim().toLowerCase();
  if (VALID_GENDERS.includes(normalized)) {
    return normalized;
  }

  if (normalized.startsWith('gender.')) {
    const candidate = normalized.substring('gender.'.length);
    if (VALID_GENDERS.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ========== NEW: UPDATE USER PROFILE ENDPOINT ==========
app.post('/user/:userId/update', validateProfileUpdate, async (req, res) => {
  if (!isDatabaseConnected()) {
    return sendError(res, 503, 'Database not connected', 'DB_NOT_CONNECTED');
  }
  try {
    const { userId } = req.params;
    const { userName, email, gender, country, avatarColor, profileImageUrl, profileImagePath, pictureName, birthDate, authType, isGuest } = req.body;

    Logger.info('user/update', 'Received profile update payload', {
      userId,
      hasGender: !!gender,
      hasCountry: !!country,
      hasImage: !!profileImageUrl,
    });

    const updateData = {
      updatedAt: new Date(),
    };

    if (userName) updateData.userName = String(userName).trim();

    const normalizedGender = sanitizeGenderInput(gender);
    if (normalizedGender) {
      updateData.gender = normalizedGender;
    } else if (gender != null) {
      Logger.warn('user/update', 'Invalid gender value ignored', { userId, gender });
    }

    if (country) updateData.country = String(country).trim();
    if (avatarColor) updateData.avatarColor = String(avatarColor).trim();
    if (profileImageUrl) {
      updateData.profileImageUrl = String(profileImageUrl).trim();
    } else if (profileImagePath) {
      Logger.warn(
        'user/update',
        'profileImagePath provided but ignored to prevent local file upload to MongoDB',
        { userId, profileImagePath }
      );
    }
    if (pictureName) updateData.pictureName = String(pictureName).trim();
    if (email) updateData.email = String(email).toLowerCase().trim();
    if (authType) updateData.authType = String(authType).trim();
    if (typeof isGuest === 'boolean') updateData.isGuest = isGuest;
    if (birthDate) {
      try {
        updateData.birthDate = new Date(String(birthDate));
      } catch (e) {
        Logger.warn('user/update', 'Invalid birthDate format', { birthDate });
      }
    }

    // ✅ Set profileComplete to true if both gender and country are provided
    if (normalizedGender && country) {
      updateData.profileComplete = true;
      Logger.info('user/update', '✅ Profile marked as complete', { userId });
    }

    const safeFields = ['email', 'userName', 'gender', 'country', 'avatarColor', 'profileImageUrl', 'pictureName', 'birthDate', 'authType', 'isGuest', 'xp', 'profileComplete', 'updatedAt'];
    const safeUpdateData = {};
    for (const key of safeFields) {
      if (Object.prototype.hasOwnProperty.call(updateData, key)) {
        safeUpdateData[key] = updateData[key];
      }
    }

    // ✅ OPTIMIZED: Use lean() for the response
    const user = await User.findOneAndUpdate(
      { userId },
      {
        $set: safeUpdateData,
        $setOnInsert: {
          userId,
          createdAt: new Date(),
          authType: 'GOOGLE_OAUTH',
          isGuest: false,
        },
      },
      { upsert: true, new: true, lean: true, setDefaultsOnInsert: true }
    ).exec();

    // ✅ PERFORMANCE: Invalidate cache so next request gets fresh data
    userCache.invalidate(userId);

    // ✅ SYNC LIVE SOCKET METADATA: If the user is connected, refresh their live socket profile data
    try {
      const connectedSocketId = userSockets.get(userId);
      if (connectedSocketId) {
        const existingMeta = socketMetadata.get(connectedSocketId) || {};
        socketMetadata.set(connectedSocketId, {
          ...existingMeta,
          userName: user.userName || existingMeta.userName,
          avatarColor: user.avatarColor || existingMeta.avatarColor,
          profileImageUrl: user.profileImageUrl || existingMeta.profileImageUrl,
          profileImagePath: user.profileImageUrl || existingMeta.profileImagePath,
          country: user.country || existingMeta.country,
          gender: user.gender || existingMeta.gender,
        });
        Logger.info('user/update', '✅ Synchronized socket metadata for updated user', { userId, socketId: connectedSocketId });
      }
    } catch (syncErr) {
      Logger.warn('user/update', 'Failed to sync socket metadata', { userId, error: syncErr && syncErr.message });
    }

    // ✅ BROADCAST: Notify connected clients of the profile change
    try {
      io.emit('profile_update', {
        userId: user.userId,
        userName: user.userName,
        avatarColor: user.avatarColor,
        profileImageUrl: user.profileImageUrl,
        gender: user.gender,
        country: user.country,
        timestamp: Date.now(),
      });
      Logger.info('user/update', '✅ Broadcast profile_update to connected clients', { userId });
    } catch (broadcastErr) {
      Logger.warn('user/update', 'Failed to broadcast profile_update', { userId, error: broadcastErr && broadcastErr.message });
    }

    Logger.info('user/update', '✅ User profile updated or created', {
      userId,
      created: user.createdAt.getTime() === user.updatedAt.getTime(),
    });

    return sendSuccess(res, {
      user: {
        userId: user.userId,
        userName: user.userName,
        email: user.email,
        gender: user.gender,
        country: user.country,
        avatarColor: user.avatarColor,
        profileImageUrl: user.profileImageUrl,
        profileComplete: user.profileComplete || false,
        xp: getUserXp(user),
        birthDate: user.birthDate,
        authType: user.authType,
      },
    }, 'User profile updated successfully');
  } catch (err) {
    Logger.error('user/update', 'Error updating user', err.message);
    return sendError(res, 500, 'Error updating user', { details: err.message });
  }
});

// Room ID / Invite generation constants
const ROOM_CONSTS = {
  INVITE_CHARS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  INVITE_LENGTH: 6,
  ROOM_ID_CHARS: 'abcdefghijklmnopqrstuvwxyz0123456789',
  ROOM_ID_PREFIX: 'room_',
  ROOM_ID_LENGTH: 12,
  INVITE_LINK_PREFIX: 'omeglelol://join-room/',
  DEFAULT_MAX_MEMBERS: 100,
};

function generateInviteCode() {
  let code = '';
  for (let i = 0; i < ROOM_CONSTS.INVITE_LENGTH; i++) {
    code += ROOM_CONSTS.INVITE_CHARS.charAt(Math.floor(Math.random() * ROOM_CONSTS.INVITE_CHARS.length));
  }
  return code;
}

function generateRoomId() {
  let id = ROOM_CONSTS.ROOM_ID_PREFIX;
  for (let i = 0; i < ROOM_CONSTS.ROOM_ID_LENGTH; i++) {
    id += ROOM_CONSTS.ROOM_ID_CHARS.charAt(Math.floor(Math.random() * ROOM_CONSTS.ROOM_ID_CHARS.length));
  }
  return id;
}

function generateMatchId() {
  return `m_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function buildIceServers() {
  const list = Array.isArray(CONFIG.DEFAULT_ICE_SERVERS) ? [...CONFIG.DEFAULT_ICE_SERVERS] : [];
  if (CONFIG.TURN_URL && CONFIG.TURN_USERNAME && CONFIG.TURN_CREDENTIAL) {
    list.push({
      urls: CONFIG.TURN_URL,
      username: CONFIG.TURN_USERNAME,
      credential: CONFIG.TURN_CREDENTIAL,
    });
  }
  return list;
}

// In-memory rooms store: roomId -> room object
// room object fields: roomId, roomName, creatorId, creatorName, description,
// roomType ('public'|'private'), inviteCode, inviteLink, createdAt, memberIds (userIds), maxMembers, status
const rooms = new Map();

// ========== STATE MANAGEMENT ==========
const videoPairings = new Map(); // socket.id -> { peerId, userData }
const chatPairings = new Map();
const videoQueue = []; // Array of { socketId, userData, joinedAt }
const chatQueue = []; // Array of { socketId, userData, joinedAt }
const userSockets = new Map(); // userId -> socketId
const socketMetadata = new Map(); // socketId -> { userId, userName, joinedAt }
const socketQueues = new Map(); // socket.id -> 'video' | 'chat' (track which queue user is in)
const rateLimitMap = new Map(); // socketId -> { count, resetTime } for abuse prevention
// ✅ NEW: Cache profile images separately for matched events (not re-emitted in normal traffic)
const profileImageCache = new Map(); // socketId -> profileImagePath (full data URI or URL)
// ✅ NEW: Store offline messages to deliver when user comes online
let offlineMessages = new Map(); // userId -> [{ payload: messagePayload, ts: number }]
// TTL for offline messages (default 7 days) - can be adjusted via env
const OFFLINE_MESSAGE_TTL_MS = (Number(process.env.OFFLINE_MESSAGE_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;

// Periodic cleanup for offlineMessages to avoid unbounded memory growth
function startOfflineMessagesCleanup() {
  setInterval(() => {
    try {
      const now = Date.now();
      let removedCount = 0;
      for (const [userId, list] of offlineMessages.entries()) {
        const filtered = list.filter(item => now - item.ts <= OFFLINE_MESSAGE_TTL_MS);
        removedCount += (list.length - filtered.length);
        if (filtered.length > 0) {
          offlineMessages.set(userId, filtered);
        } else {
          offlineMessages.delete(userId);
        }
      }
      if (removedCount > 0) {
        Logger.info('offlineMessages', 'Cleaned expired offline messages', { removedCount });
      }
    } catch (e) {
      Logger.warn('offlineMessages', 'Error during offline messages cleanup', { err: e && e.message });
    }
  }, 60 * 60 * 1000); // run hourly
}
startOfflineMessagesCleanup();
// Star gifting state: counts per room or match and one-time gift tracking
const starCounts = new Map(); // key -> number (roomId or matchId)
const oneTimeGifts = new Set(); // `${socketId}:${key}` to prevent duplicate gifts

// ========== REPORTING & BLOCKING SYSTEM ==========
const REPORT_CONFIG = {
  reportWindowMs: 24 * 60 * 60 * 1000,    // 24 hours
  
  // Progressive blocking (matching frontend implementation)
  blockDuration_1report_Ms: 10 * 60 * 1000,      // 10 minutes
  blockDuration_3reports_Ms: 3 * 60 * 60 * 1000, // 3 hours
  blockDuration_5reports_Ms: 24 * 60 * 60 * 1000, // 1 day (24 hours)
};

// ========== GENDER FILTER SYSTEM ==========
const userGenderPreferences = new Map(); // userId -> 'male'|'female'|'other'|'all'

// ========== BLOCKING & REPORTING SYSTEM (MONGODB-BACKED) ==========

// Check if a user is currently blocked
async function isUserBlocked(userId) {
  try {
    const now = new Date();
    
    // Find active blocks
    const block = await BlockedUser.findOne({
      userId,
      $or: [
        { blockedUntil: null }, // Permanent blocks
        { blockedUntil: { $gte: now } }, // Temporary blocks still active
      ],
    });
    
    if (block && block.blockedUntil && block.blockedUntil <= now) {
      // Block has expired, delete it
      await BlockedUser.deleteOne({ _id: block._id });
      return false;
    }
    
    return !!block;
  } catch (err) {
    Logger.error('isUserBlocked', 'Error checking block status', err.message);
    return false;
  }
}

// Record a report and apply progressive blocking
async function recordReport(reportedUserId, reporterId, reason = 'User reported') {
  try {
    Logger.info('recordReport', 'Processing report', { reportedUserId, reporterId });
    
    if (!reportedUserId || !reporterId) {
      Logger.warn('recordReport', 'Invalid inputs', { reportedUserId, reporterId });
      return false;
    }
    
    // Check if this reporter already reported this user in last 24 hours
    const existingReport = await Report.findOne({
      reportedUserId,
      reporterId,
      createdAt: { $gte: new Date(Date.now() - REPORT_CONFIG.reportWindowMs) },
    });
    
    if (existingReport) {
      Logger.warn('recordReport', 'Duplicate report from same reporter within 24 hours', {
        reportedUserId,
        reporterId,
      });
      return false;
    }
    
    // Create new report
    const newReport = new Report({
      reportedUserId,
      reporterId,
      reason,
    });
    await newReport.save();
    
    // Count recent unique reports
    const recentReports = await Report.find({
      reportedUserId,
      createdAt: { $gte: new Date(Date.now() - REPORT_CONFIG.reportWindowMs) },
    }).distinct('reporterId');
    
    const reportCount = recentReports.length;
    Logger.info('recordReport', 'Recent report count', { reportedUserId, count: reportCount });
    
    // Determine block duration based on report count
    let blockDuration = null;
    let blockReason = '';
    
    if (reportCount >= 5) {
      blockDuration = REPORT_CONFIG.blockDuration_5reports_Ms;
      blockReason = '5+ reports - 24 hour block';
    } else if (reportCount >= 3) {
      blockDuration = REPORT_CONFIG.blockDuration_3reports_Ms;
      blockReason = '3+ reports - 3 hour block';
    } else if (reportCount >= 1) {
      blockDuration = REPORT_CONFIG.blockDuration_1report_Ms;
      blockReason = '1+ reports - 10 minute block';
    }
    
    if (blockDuration) {
      const blockedUntil = new Date(Date.now() + blockDuration);
      
      // Create or update block
      await BlockedUser.findOneAndUpdate(
        { userId: reportedUserId },
        {
          userId: reportedUserId,
          blockedByUserId: reporterId,
          reason: blockReason,
          blockType: 'report',
          blockDuration,
          blockedUntil,
          reportCount,
          reporters: recentReports,
        },
        { upsert: true, new: true }
      );
      
      Logger.warn('recordReport', `User blocked: ${blockReason}`, {
        reportedUserId,
        reportCount,
        blockedUntil,
      });
    }
    
    return true;
  } catch (err) {
    Logger.error('recordReport', 'Error recording report', err.message);
    return false;
  }
}

// ========== RATE LIMITING ==========
const RATE_LIMIT_CONFIG = {
  maxRequestsPerMinute: 30,
  checkIntervalMs: 60000, // 1 minute
};

function checkRateLimit(socketId) {
  const now = Date.now();
  const limit = rateLimitMap.get(socketId);
  
  if (!limit || now > limit.resetTime) {
    rateLimitMap.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_CONFIG.checkIntervalMs });
    return true;
  }
  
  if (limit.count >= RATE_LIMIT_CONFIG.maxRequestsPerMinute) {
    return false;
  }
  
  limit.count++;
  return true;
}

// ========== VALIDATION & UTILITIES ==========
function isValidSocketId(socketId) {
  return typeof socketId === 'string' && socketId.length > 0;
}

// ✅ Helper function to sanitize nested reply chains (reply to a reply)
function _sanitizeNestedReply(replyData) {
  if (!replyData || typeof replyData !== 'object') return null;
  
  const replyUserName = (replyData.userName || replyData.senderName || '').trim();
  const finalReplyUserName = replyUserName || replyData.userId || 'Unknown User';
  
  const sanitized = {
    messageId: replyData.messageId || null,
    userName: finalReplyUserName.substring(0, 50),
    message: replyData.message || null,
    timestamp: replyData.timestamp || null,
    mediaUrl: replyData.mediaUrl || replyData.media || replyData.media_url || null,
    mediaType: replyData.mediaType || null,
    senderProfileImagePath: replyData.senderProfileImagePath || replyData.profileImagePath || replyData.profile_image_path || null,
    avatarColor: replyData.avatarColor || '#128C7E',
    avatarLetter: ((replyData.avatarLetter || finalReplyUserName.charAt(0).toUpperCase() || 'U').substring(0, 1)),
  };
  
  // ✅ Recursively handle deeper nested replies
  if (replyData.replyTo && typeof replyData.replyTo === 'object') {
    sanitized.replyTo = _sanitizeNestedReply(replyData.replyTo);
  }
  
  return sanitized;
}

// ========== ROOM MANAGEMENT ==========

function decomposeRoom(socketId, roomType = 'video') {
  if (!isValidSocketId(socketId)) {
    Logger.warn('decomposeRoom', 'Invalid socketId provided');
    return;
  }

  const pairings = roomType === 'video' ? videoPairings : chatPairings;
  const queue = roomType === 'video' ? videoQueue : chatQueue;

  Logger.info('decomposeRoom', `Decomposing ${roomType} room`, { socketId });

  try {
    if (pairings.has(socketId)) {
      const pairing = pairings.get(socketId);
      const peerId = pairing.peerId;

      if (!isValidSocketId(peerId)) {
        Logger.warn('decomposeRoom', 'Invalid peerId in pairing', { socketId, peerId });
        return;
      }

      // Notify peer
      io.to(peerId).emit('partner_left', {
        reason: 'partner_left',
        timestamp: Date.now(),
      });

      // Remove both sides
      pairings.delete(socketId);
      pairings.delete(peerId);
      socketQueues.delete(peerId);

      // Requeue peer
      queue.push({
        socketId: peerId,
        userData: socketMetadata.get(peerId) || {},
        joinedAt: Date.now(),
      });
      socketQueues.set(peerId, roomType);

      Logger.info('decomposeRoom', `Peer requeued`, { peerId, queueSize: queue.length });
    } else {
      // Remove from queue if present
      const queueIndex = queue.findIndex((item) => item.socketId === socketId);
      if (queueIndex !== -1) {
        queue.splice(queueIndex, 1);
        socketQueues.delete(socketId);
        Logger.info('decomposeRoom', `Removed from queue`, { socketId, queueSize: queue.length });
      }
    }
  } catch (error) {
    Logger.error('decomposeRoom', 'Error during room decomposition', error.message);
  }
}

// ✅ NEW HELPER: Fetch fresh profile from MongoDB to get latest profileImageUrl
async function getFreshUserProfile(userId) {
  try {
    if (!userId) return null;
    
    const user = await User.findOne({ userId }).lean().select('userId userName avatarColor gender country profileImageUrl').exec();
    
    if (user) {
      Logger.debug('getFreshUserProfile', 'Fetched fresh user profile', { userId, hasProfileImageUrl: !!user.profileImageUrl });
    } else {
      Logger.warn('getFreshUserProfile', 'User not found in MongoDB', { userId });
    }
    
    return user;
  } catch (error) {
    Logger.error('getFreshUserProfile', 'Error fetching fresh profile', { userId, error: error.message });
    return null;
  }
}

async function attemptMatch(roomType = 'video') {
  try {
    const pairings = roomType === 'video' ? videoPairings : chatPairings;
    const queue = roomType === 'video' ? videoQueue : chatQueue;

    Logger.info('attemptMatch', `Checking queue for ${roomType} pairing`, {
      queueSize: queue.length,
      currentPairings: pairings.size,
    });

    if (queue.length < 2) {
      Logger.warn('attemptMatch', `Not enough users in ${roomType} queue to match`, {
        needed: 2,
        available: queue.length,
      });
      return false;
    }

    // Pop first valid user from the head of the queue
    let user1 = null;
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (isValidSocketId(candidate?.socketId)) {
        user1 = candidate;
        break;
      }
      Logger.warn('attemptMatch', 'Skipping invalid socket in queue', { socketId: candidate?.socketId });
    }
    if (!user1) {
      Logger.warn('attemptMatch', 'No valid user found at head of queue');
      return false;
    }

    // Find a partner later in the queue to avoid shifting twice; splice out the partner when found
    const partnerIndex = queue.findIndex(item => isValidSocketId(item?.socketId) && item.socketId !== user1.socketId);
    if (partnerIndex === -1) {
      // No suitable partner currently - requeue user1 to the end
      queue.push(user1);
      return false;
    }
    const user2 = queue.splice(partnerIndex, 1)[0];
    
    // ✅ CRITICAL FIX: AWAIT async blocking check instead of fire-and-forget
    const user1Blocked = user1.userData && user1.userData.userId && (await isUserBlocked(user1.userData.userId));
    const user2Blocked = user2.userData && user2.userData.userId && (await isUserBlocked(user2.userData.userId));
    
    if (user1Blocked) {
      Logger.warn('attemptMatch', 'User1 is blocked, requeuing User2', { user1Id: user1.socketId, user2Id: user2.socketId });
      queue.push(user2);
      return false;
    }
    
    if (user2Blocked) {
      Logger.warn('attemptMatch', 'User2 is blocked, requeuing User1', { user1Id: user1.socketId, user2Id: user2.socketId });
      queue.push(user1);
      return false;
    }

    // ✅ CRITICAL: Prevent self-pairing (same socket matched with itself)
    if (user1.socketId === user2.socketId) {
      Logger.warn('attemptMatch', 'Attempted self-pairing, requeuing both', {
        socketId: user1.socketId,
        roomType,
      });
      // Requeue both to end of queue to avoid immediate re-matching
      queue.push(user1);
      queue.push(user2);
      return false;
    }

    Logger.info('attemptMatch', `Matched ${roomType} pair`, {
      user1Id: user1.socketId,
      user1Name: user1.userData?.userName,
      user1DataValid: user1.userData ? 'YES' : 'NULL',
      user2Id: user2.socketId,
      user2Name: user2.userData?.userName,
      user2DataValid: user2.userData ? 'YES' : 'NULL',
    });

    // ✅ DEFENSIVE: Ensure userData is always valid (fallback if not)
    const ensureUserData = (userData, socketId) => {
      if (!userData) {
        Logger.warn('attemptMatch', 'userData missing, creating fallback', { socketId });
        return {
          userId: `user_${socketId.substring(0, 8)}`,
          userName: `User_${socketId.substring(0, 8)}`,
          avatarColor: '#128C7E',
          avatarLetter: 'U',
          profileImagePath: null,
        };
      }
      return userData;
    };

    const user1DataValid = ensureUserData(user1.userData, user1.socketId);
    const user2DataValid = ensureUserData(user2.userData, user2.socketId);

    // ✅ NEW: Fetch fresh profiles from MongoDB to get latest profileImageUrl
    // This ensures profile images are always current, not stale socket-register data
    const user1FreshProfile = user1DataValid.userId ? await getFreshUserProfile(user1DataValid.userId) : null;
    const user2FreshProfile = user2DataValid.userId ? await getFreshUserProfile(user2DataValid.userId) : null;
    
    // Merge fresh profile data with socket metadata
    // Fresh profile takes priority for profileImageUrl, but keep other socket data as fallback
    if (user1FreshProfile) {
      user1DataValid.profileImageUrl = user1FreshProfile.profileImageUrl || user1DataValid.profileImageUrl;
      user1DataValid.userName = user1FreshProfile.userName || user1DataValid.userName;
      user1DataValid.avatarColor = user1FreshProfile.avatarColor || user1DataValid.avatarColor;
      user1DataValid.gender = user1FreshProfile.gender || user1DataValid.gender;
      user1DataValid.country = user1FreshProfile.country || user1DataValid.country;
    }
    if (user2FreshProfile) {
      user2DataValid.profileImageUrl = user2FreshProfile.profileImageUrl || user2DataValid.profileImageUrl;
      user2DataValid.userName = user2FreshProfile.userName || user2DataValid.userName;
      user2DataValid.avatarColor = user2FreshProfile.avatarColor || user2DataValid.avatarColor;
      user2DataValid.gender = user2FreshProfile.gender || user2DataValid.gender;
      user2DataValid.country = user2FreshProfile.country || user2DataValid.country;
    }
    Logger.info('attemptMatch', 'Merged fresh profiles from MongoDB', {
      user1: { id: user1DataValid.userId, hasProfileImageUrl: !!user1DataValid.profileImageUrl },
      user2: { id: user2DataValid.userId, hasProfileImageUrl: !!user2DataValid.profileImageUrl },
    });

    // ✅ NEW: Check gender compatibility AFTER data validation
    const user1Gender = userGenderPreferences.get(user1DataValid.userId) || 'all';
    const user2Gender = userGenderPreferences.get(user2DataValid.userId) || 'all';
    const user1UserGender = user1DataValid.gender || 'other';
    const user2UserGender = user2DataValid.gender || 'other';

    Logger.info('attemptMatch', 'Gender compatibility check', {
      user1Id: user1.socketId,
      user1PreferredGender: user1Gender,
      user1ActualGender: user1UserGender,
      user2Id: user2.socketId,
      user2PreferredGender: user2Gender,
      user2ActualGender: user2UserGender,
    });

    // ✅ IMPROVED: If EITHER user selected "All", they're open to everyone → MATCH
    // Otherwise, check mutual compatibility:
    // - User1's preference must match User2's actual gender
    // - User2's preference must match User1's actual gender
    
    const user1HasAllFilter = user1Gender === 'all';
    const user2HasAllFilter = user2Gender === 'all';

    // If either has "All" selected, they match (open to everyone)
    if (!user1HasAllFilter && !user2HasAllFilter) {
      // Both have specific preferences - check mutual compatibility
      if (user1Gender !== user2UserGender) {
        Logger.warn('attemptMatch', 'Gender mismatch - user1 preference incompatible', {
          user1Gender: user1Gender,
          user2ActualGender: user2UserGender,
          action: 'requeue_user2',
        });
        queue.push(user2);
        return false;
      }

      if (user2Gender !== user1UserGender) {
        Logger.warn('attemptMatch', 'Gender mismatch - user2 preference incompatible', {
          user2Gender: user2Gender,
          user1ActualGender: user1UserGender,
          action: 'requeue_user1',
        });
        queue.push(user1);
        return false;
      }
    }

    Logger.info('attemptMatch', 'Gender compatibility passed - proceeding with match', {
      user1: user1DataValid.userId,
      user2: user2DataValid.userId,
    });

    // Normalize outgoing user object to guarantee profile image keys the frontend expects
    const normalizeOutgoingUser = (ud) => {
      const profileImage = ud && (ud.profileImagePath || ud.profile_image_path || ud.profileImage || ud.profile_pic || ud.photo) ? (ud.profileImagePath || ud.profile_image_path || ud.profileImage || ud.profile_pic || ud.photo) : null;
    const profileImageUrl = ud && (ud.profileImageUrl || ud.photoUrl || ud.photo_url || ud.avatarUrl || ud.avatar_url) ? (ud.profileImageUrl || ud.photoUrl || ud.photo_url || ud.avatarUrl || ud.avatar_url) : null;
      return {
        userId: ud.userId || null,
        userName: ud.userName || 'Unknown',
        avatarColor: ud.avatarColor || '#128C7E',
        avatarLetter: (ud.avatarLetter || (ud.userName ? ud.userName.charAt(0).toUpperCase() : 'U')).substring(0,1),
        // Provide multiple variants so different clients can read whichever key they expect
        profileImagePath: profileImage,
        profile_image_path: profileImage,
        profileImage: profileImage,
        profileImageUrl: profileImageUrl,
      };
    };

    const user1Out = normalizeOutgoingUser(user1DataValid);
    const user2Out = normalizeOutgoingUser(user2DataValid);

    // Create pairing with validated (normalized) user data
    const matchId = generateMatchId();
    pairings.set(user1.socketId, {
      peerId: user2.socketId,
      userData: user2Out,
      matchId,
    });
    pairings.set(user2.socketId, {
      peerId: user1.socketId,
      userData: user1Out,
      matchId,
    });
    socketQueues.delete(user1.socketId);
    socketQueues.delete(user2.socketId);

    // Notify both users - send matched event with peers array
    const iceServers = buildIceServers();
    const matchedData1 = {
      peers: [user1.socketId, user2.socketId],
      peerId: user2.socketId,
      initiator: true,
      remoteUser: user2Out,
      matchId,
      iceServers,
      mediaConstraints: CONFIG.MEDIA_CONSTRAINTS,
      matchedAt: Date.now(),
    };
    const matchedData2 = {
      peers: [user1.socketId, user2.socketId],
      peerId: user1.socketId,
      initiator: false,
      remoteUser: user1Out,
      matchId,
      iceServers,
      mediaConstraints: CONFIG.MEDIA_CONSTRAINTS,
      matchedAt: Date.now(),
    };

    Logger.info('attemptMatch', `Matched ${roomType} pair, storing in ${roomType === 'video' ? 'videoPairings' : 'chatPairings'}`, {
      user1: { socketId: user1.socketId, userName: user1.userData?.userName },
      user2: { socketId: user2.socketId, userName: user2.userData?.userName },
      pairingsSize: pairings.size,
    });

    Logger.info('attemptMatch', 'Sending matched events to both peers', {
      user1: user1.socketId,
      user2: user2.socketId,
      roomType,
    });

    io.to(user1.socketId).emit('matched', matchedData1);
    io.to(user2.socketId).emit('matched', matchedData2);

    Logger.info('attemptMatch', `Successfully matched and notified ${roomType} pair, verifying pairings...`, {
      user1InPairings: pairings.has(user1.socketId),
      user2InPairings: pairings.has(user2.socketId),
      pairingForUser1: pairings.get(user1.socketId) ? 'exists' : 'missing',
      pairingForUser2: pairings.get(user2.socketId) ? 'exists' : 'missing',
    });

    // ✅ NEW: Send connection_ready event after both users are matched 
    // This ensures client waits for server confirmation before showing animation
    setImmediate(() => {
      try {
        // connection_ready is advisory; use volatile to avoid buffering if client is slow
        io.volatile.to(user1.socketId).emit('connection_ready', {
          matchId,
          peerId: user2.socketId,
          readyAt: Date.now(),
        });
        io.volatile.to(user2.socketId).emit('connection_ready', {
          matchId,
          peerId: user1.socketId,
          readyAt: Date.now(),
        });
        Logger.info('attemptMatch', 'connection_ready events sent to both peers', {
          user1: user1.socketId,
          user2: user2.socketId,
        });
      } catch (err) {
        Logger.error('attemptMatch', 'Error sending connection_ready', err.message);
      }
    });

    return true;
  } catch (error) {
    Logger.error('attemptMatch', 'Error during matching', error.message);

    return false;
  }
}

function broadcastStats() {
  try {
    const stats = {
      videoQueueSize: videoQueue.length,
      chatQueueSize: chatQueue.length,
      videoPairings: videoPairings.size,
      chatPairings: chatPairings.size,
      totalPairings: videoPairings.size + chatPairings.size,
      totalOnline: socketMetadata.size,
    };

    // Use volatile emits for high-frequency/non-critical telemetry to avoid building up server-side buffers
    io.volatile.emit('stats', stats);
    io.volatile.emit('online_count', stats.totalOnline);
  } catch (error) {
    Logger.error('broadcastStats', 'Error broadcasting stats', error.message);
  }
}

// ========== GROUP CHAT ROOMS ==========
const groupChatRooms = new Map(); // roomName -> Set of socketIds
const messageIdCache = new Map(); // groupName -> { ids: Set, timestamp }
const MESSAGE_CACHE_TIMEOUT = 30000; // 30 seconds

// ========== SOCKET.IO CONNECTION HANDLER ==========
io.on('connection', (socket) => {
  Logger.info('connection', '🟢 Client connected', { socketId: socket.id });
  health.updateSocketConnections(io.of('/').sockets.size);

  // Try to disable Nagle (TCP_NODELAY) to reduce buffering/delays on slow networks
  try {
    const transportSocket = socket.conn && socket.conn.transport && socket.conn.transport.socket;
    if (transportSocket && typeof transportSocket.setNoDelay === 'function') {
      transportSocket.setNoDelay(true);
      Logger.info('connection', '✅ TCP_NODELAY (setNoDelay) enabled on socket', { socketId: socket.id });
    }
  } catch (err) {
    Logger.warn('connection', 'Could not set TCP_NODELAY on socket', { socketId: socket.id, error: err && err.message });
  }

  // ✅ NEW: Add error handler to catch transport errors early
  socket.on('error', (error) => {
    Logger.error('socket_error', '❌ Socket error event', {
      socketId: socket.id,
      error: error?.message || String(error),
      code: error?.code,
    });
  });

  socket.emit('SignallingClient', socket.id);

  // Preserve handshake userId so home-screen socket connections can still receive notifications
  const handshakeUserId = socket.handshake?.query?.userId;
  if (handshakeUserId) {
    socket.data = socket.data || {};
    socket.data.userId = handshakeUserId;
    userSockets.set(handshakeUserId, socket.id);
    socketMetadata.set(socket.id, {
      userId: handshakeUserId,
      joinedAt: Date.now(),
    });
  }

  // User registration - MINIMAL data only for socket identification
  socket.on('register_user', (userData, callback) => {
    try {
      // ✅ NEW: Log incoming user data size for diagnostics
      const incomingDataSize = JSON.stringify(userData).length;
      Logger.info('register_user', `📥 Received user data (${Math.round(incomingDataSize / 1024)}KB)`, {
        socketId: socket.id,
        dataSizeBytes: incomingDataSize,
        hasProfileImage: userData?.profileImagePath ? 'yes' : 'no',
        profileImageSizeKB: userData?.profileImagePath ? Math.round(userData.profileImagePath.length / 1024) : 0,
      });

      const validation = validateUserData(userData);

      if (!validation.valid) {
        Logger.warn('register_user', `❌ Validation failed: ${validation.error}`, { socketId: socket.id });
        const errorResponse = {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: validation.error,
          },
        };
        socket.emit('error', errorResponse);
        if (typeof callback === 'function') callback(errorResponse);
        return;
      }

      // Extract profile image from multiple possible keys
      const profileImageCandidates = [
        'profileImagePath',
        'profile_image_path',
        'profileImage',
        'profile_pic',
        'photo',
        'avatarUrl',
        'img',
      ];
      let profileImagePath = null;
      for (const k of profileImageCandidates) {
        if (userData[k]) {
          profileImagePath = userData[k];
          break;
        }
      }

      // ✅ CRITICAL: Validate image size (prevent "transport error" / "transport close")
      const MAX_IMAGE_SIZE = 100 * 1024; // 100KB limit for real-time socket emission
      if (profileImagePath && typeof profileImagePath === 'string') {
        const imageSizeBytes = profileImagePath.length; // Base64 string length approximates byte size
        if (imageSizeBytes > MAX_IMAGE_SIZE) {
          Logger.warn('register_user', `⚠️ Image too large (${Math.round(imageSizeBytes / 1024)}KB) - discarding to prevent transport error`, {
            socketId: socket.id,
            userId: userData.userId,
            imageSizeKB: Math.round(imageSizeBytes / 1024),
            maxSizeKB: Math.round(MAX_IMAGE_SIZE / 1024),
          });
          // Discard large image to prevent 'transport error' / 'transport close'
          profileImagePath = null;
        }
      }

      // Store MINIMAL socket metadata (only what's needed for real-time features)
      socketMetadata.set(socket.id, {
        userId: userData.userId,
        userName: userData.userName,
        avatarColor: userData.avatarColor || '#128C7E',
        avatarLetter: userData.avatarLetter || userData.userName[0].toUpperCase(),
        profileImagePath: profileImagePath || null,
        joinedAt: Date.now(),
        // NOTE: Email, authType, isGuest are stored LOCALLY on phone
        // Backend only keeps what's needed for video/chat identification
      });

      socket.data = socket.data || {};
      socket.data.userId = userData.userId;
      socket.data.userName = userData.userName;
      userSockets.set(userData.userId, socket.id);

      // ✅ NEW: Deliver any offline messages when user comes online (respect TTL)
      if (offlineMessages && offlineMessages.has(userData.userId)) {
        const messages = offlineMessages.get(userData.userId) || [];
        const now = Date.now();
        const validMessages = messages.filter(item => now - item.ts <= OFFLINE_MESSAGE_TTL_MS);
        Logger.info('register_user', `Delivering ${validMessages.length} offline messages to ${userData.userId}`, {
          userId: userData.userId,
          messageCount: validMessages.length,
        });

        // Send valid offline messages to the newly connected socket
        validMessages.forEach(item => {
          try { socket.emit('direct_message', item.payload); } catch (e) {}
        });

        // Remove delivered messages
        offlineMessages.delete(userData.userId);
      }

      // Simple logging - no sensitive data stored
      Logger.info('register_user', '✅ User registered', {
        socketId: socket.id,
        userId: userData.userId,
        userName: userData.userName,
        hasProfileImage: profileImagePath !== null,
        imageSizeKB: profileImagePath ? Math.round(profileImagePath.length / 1024) : 0,
      });

      broadcastStats();
      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } catch (error) {
      Logger.error('register_user', 'Error registering user', error.message);
      socket.emit('error', { message: 'Registration failed' });
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Registration failed' });
      }
    }
  });

  // Update user status (mic/camera) and notify room members
  socket.on('update_user_status', (data, callback) => {
    try {
      Logger.info('update_user_status', 'Received status update', { socketId: socket.id, data });
      const meta = socketMetadata.get(socket.id) || {};
      const userId = meta.userId;
      if (!userId) {
        if (callback) callback({ success: false, error: 'User not registered' });
        return;
      }

      const micOn = data && typeof data.micOn === 'boolean' ? data.micOn : true;
      const cameraOn = data && typeof data.cameraOn === 'boolean' ? data.cameraOn : true;

      // Persist status on socket metadata
      meta.status = { micOn, cameraOn };
      socketMetadata.set(socket.id, meta);

      // Find rooms where this user is present and notify members (including sender)
      for (const room of rooms.values()) {
        if (room.memberIds && room.memberIds.includes(userId) && room.status === 'active') {
          for (const memberId of room.memberIds) {
            const memberSocketId = userSockets.get(memberId);
              if (memberSocketId) {
              // Use volatile emit for status updates to avoid buffering on slow clients
              io.volatile.to(memberSocketId).emit('room_member_updated', {
                roomId: room.roomId,
                userId,
                status: { micOn, cameraOn },
              });
            }
          }
        }
      }

      if (callback) callback({ success: true });
    } catch (err) {
      Logger.error('update_user_status', 'Error updating user status', err && err.message);
      if (callback) callback({ success: false, error: 'Failed to update status' });
    }
  });

  // ========== GROUP ROOM EVENTS ==========
  // Create a new room (public/private)
  socket.on('create_room', (data, callback) => {
    try {
      let meta = socketMetadata.get(socket.id);
      // If socket not registered, allow auto-registration when client provides user info
      if (!meta) {
        const userPayload = data && (data.user || data.userId || data.userName) ? (data.user || {
          userId: data.userId,
          userName: data.userName,
          avatarColor: data.avatarColor,
          avatarLetter: data.avatarLetter,
          profileImagePath: data.profileImagePath,
        }) : null;

        if (userPayload) {
          const validation = validateUserData(userPayload);
          if (validation.valid) {
            socketMetadata.set(socket.id, {
              userId: userPayload.userId,
              userName: userPayload.userName,
              avatarColor: userPayload.avatarColor || '#128C7E',
              avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'U'),
              profileImagePath: userPayload.profileImagePath || null,
              joinedAt: Date.now(),
            });
            userSockets.set(userPayload.userId, socket.id);
            meta = socketMetadata.get(socket.id) || {};
            Logger.info('create_room', 'Auto-registered user from create_room payload', { socketId: socket.id, userId: userPayload.userId });
            broadcastStats();
          } else {
            if (callback) callback({ success: false, error: validation.error });
            return;
          }
        } else {
          const err = 'User not registered';
          if (callback) callback({ success: false, error: err });
          return;
        }
      }

      const roomName = (data && data.roomName) ? String(data.roomName).trim() : null;
      if (!roomName) {
        if (callback) callback({ success: false, error: 'Invalid room name' });
        return;
      }

      const roomType = (data && data.roomType) === 'public' ? 'public' : 'private';
      let maxMembers = (data && Number.isInteger(data.maxMembers) && data.maxMembers > 0) ? data.maxMembers : ROOM_CONSTS.DEFAULT_MAX_MEMBERS;
      if (maxMembers < 2) maxMembers = 2;
      if (maxMembers > 500) maxMembers = ROOM_CONSTS.DEFAULT_MAX_MEMBERS;

      const inviteCode = roomType === 'private' ? generateInviteCode() : null;
      const inviteLink = inviteCode ? ROOM_CONSTS.INVITE_LINK_PREFIX + inviteCode : null;
      const roomId = generateRoomId();

      const room = {
        roomId,
        roomName,
        creatorId: meta.userId,
        creatorName: meta.userName,
        description: (data && data.description) ? String(data.description).trim() : null,
        roomType,
        inviteCode,
        inviteLink,
        createdAt: new Date().toISOString(),
        memberIds: [meta.userId],
        maxMembers,
        status: 'active',
      };

      rooms.set(roomId, room);

      Logger.info('create_room', 'Room created', {
        roomId,
        roomName,
        roomType,
        inviteCode,
        creatorId: meta.userId,
        totalRooms: rooms.size,
      });

      // Inform caller
      if (callback) callback({ success: true, room });

      // Broadcast updated public rooms list
      if (roomType === 'public') {
        // Use volatile broadcast for rooms list updates to avoid queuing when many clients are slow
        io.volatile.emit('rooms_updated', { type: 'public', rooms: Array.from(rooms.values()).filter(r => r.roomType === 'public' && r.status === 'active') });
      }
    } catch (error) {
      Logger.error('create_room', 'Error creating room', error.message);
      if (callback) callback({ success: false, error: 'Failed to create room' });
    }
  });

  // Join a room by invite code or roomId
  socket.on('join_room', (data, callback) => {
    try {
      const inviteCode = data && data.inviteCode ? String(data.inviteCode).trim() : null;
      const roomId = data && data.roomId ? String(data.roomId).trim() : null;
      
      Logger.info('join_room', 'Received join request', {
        socketId: socket.id,
        inviteCode,
        roomId,
      });

      let meta = socketMetadata.get(socket.id) || {};
      let userId = meta.userId;

      // If client included user info with the join request, auto-register the socket.
      if (!userId && data && (data.user || data.userId || data.userName)) {
        try {
          const userPayload = data.user || {
            userId: data.userId,
            userName: data.userName,
            avatarColor: data.avatarColor,
            avatarLetter: data.avatarLetter,
            profileImagePath: data.profileImagePath,
          };

          const validation = validateUserData(userPayload);
          if (validation.valid) {
            socketMetadata.set(socket.id, {
              userId: userPayload.userId,
              userName: userPayload.userName,
              avatarColor: userPayload.avatarColor || '#128C7E',
              avatarLetter: userPayload.avatarLetter || (userPayload.userName ? userPayload.userName[0].toUpperCase() : 'U'),
              profileImagePath: userPayload.profileImagePath || null,
              joinedAt: Date.now(),
            });
            userSockets.set(userPayload.userId, socket.id);
            meta = socketMetadata.get(socket.id) || {};
            userId = meta.userId;
            Logger.info('join_room', 'Auto-registered user from join payload', { socketId: socket.id, userId });
            broadcastStats();
          } else {
            Logger.warn('join_room', `Auto-registration failed validation: ${validation.error}`, { socketId: socket.id });
          }
        } catch (e) {
          Logger.error('join_room', 'Auto-registration error', e && e.message);
        }
      }

      if (!userId) {
        Logger.warn('join_room', 'User not registered for this socket', {
          socketId: socket.id,
          registeredUsers: Array.from(socketMetadata.keys()),
        });
        if (callback) callback({ success: false, error: 'User not registered' });
        return;
      }

      let room = null;
      if (inviteCode) {
        Logger.info('join_room', 'Searching for room by inviteCode', {
          searchCode: inviteCode.toUpperCase(),
          totalRooms: rooms.size,
          roomCodes: Array.from(rooms.values()).map(r => ({
            roomId: r.roomId,
            inviteCode: r.inviteCode,
            status: r.status,
          })),
        });

        for (const r of rooms.values()) {
          if (r.inviteCode && r.inviteCode.toUpperCase() === inviteCode.toUpperCase() && r.status === 'active') {
            room = r;
            Logger.info('join_room', 'Room found by inviteCode', {
              roomId: r.roomId,
              roomName: r.roomName,
            });
            break;
          }
        }

        if (!room) {
          Logger.warn('join_room', 'Room not found by inviteCode', {
            searchedCode: inviteCode.toUpperCase(),
            totalRooms: rooms.size,
          });
        }
      } else if (roomId) {
        room = rooms.get(roomId) || null;
        if (room && room.status !== 'active') room = null;
      }

      if (!room) {
        if (callback) callback({ success: false, error: 'Room not found' });
        return;
      }

      if (room.memberIds.includes(userId)) {
        if (callback) callback({ success: true, room });
        return;
      }

      if (room.memberIds.length >= room.maxMembers) {
        if (callback) callback({ success: false, error: 'Room is full' });
        return;
      }

      room.memberIds.push(userId);
      rooms.set(room.roomId, room);

      Logger.info('join_room', 'User joined room', { roomId: room.roomId, userId, totalMembers: room.memberIds.length });

      // ✅ OPTIMIZE: Build complete member details with caching
      const buildMemberDetails = () => {
        return room.memberIds.map(memberId => {
          const memberSocketId = userSockets.get(memberId);
          const memberMeta = memberSocketId ? socketMetadata.get(memberSocketId) : {};
          return {
            userId: memberId,
            userName: memberMeta.userName || `User ${memberId.substring(0, 6)}`,
            avatarColor: memberMeta.avatarColor || '#128C7E',
            avatarLetter: memberMeta.avatarLetter || 'U',
            profileImagePath: memberMeta.profileImagePath || null,
            status: memberMeta.status || { micOn: true, cameraOn: true },
          };
        });
      };

      const completeMemberDetails = buildMemberDetails();
      const totalMembers = room.memberIds.length;

      // ✅ OPTIMIZE: Send to new member immediately on same tick
      setImmediate(() => {
        try {
          io.to(socket.id).emit('room_member_list', {
            roomId: room.roomId,
            memberIds: room.memberIds,
            memberDetails: completeMemberDetails,
            timestamp: Date.now(),
          });
        } catch (err) {
          Logger.error('join_room', 'Error sending room_member_list to new member', err.message);
        }
      });

      // ✅ OPTIMIZE: Broadcast to others with reduced payload
      for (const memberId of room.memberIds) {
        if (memberId !== userId) { // Don't send duplicate to the new joiner
          const memberSocketId = userSockets.get(memberId);
          if (memberSocketId) {
            setImmediate(() => {
              try {
                // Use volatile emit for room updates to avoid buffering on slow clients
                io.volatile.to(memberSocketId).emit('room_member_list_updated', {
                  roomId: room.roomId,
                  memberIds: room.memberIds,
                  memberDetails: completeMemberDetails,
                  totalMembers: totalMembers,
                  newMemberId: userId,
                  newMemberName: meta.userName,
                  timestamp: Date.now(),
                });
              } catch (err) {
                Logger.error('join_room', 'Error sending room_member_list_updated to member', err.message);
              }
            });
          }
        }
      }

      if (callback) callback({ success: true, room, memberIds: room.memberIds });
    } catch (error) {
      Logger.error('join_room', 'Error joining room', error.message);
      if (callback) callback({ success: false, error: 'Failed to join room' });
    }
  });

  // List public rooms (simple discovery)
  socket.on('list_public_rooms', (data, callback) => {
    try {
      const publicRooms = Array.from(rooms.values()).filter(r => r.roomType === 'public' && r.status === 'active');
      if (callback) callback({ success: true, rooms: publicRooms });
    } catch (error) {
      Logger.error('list_public_rooms', 'Error listing public rooms', error.message);
      if (callback) callback({ success: false, error: 'Failed to list rooms' });
    }
  });

  // ✅ NEW: Report a user (MongoDB-backed)
  socket.on('report_user', async (data, callback) => {
    try {
      Logger.info('report_user', 'RECEIVED report_user event', { data });
      
      const reportedUserId = (data && data.reportedUserId) || (data && data.userId);
      const reporterId = (data && data.reporterId) || (socketMetadata.get(socket.id)?.userId);
      const reason = (data && data.reason) || 'Unspecified';
      
      Logger.info('report_user', 'Parsed data', { reportedUserId, reporterId, reason });
      
      if (!reportedUserId || !reporterId) {
        Logger.warn('report_user', 'Missing reportedUserId or reporterId', { data });
        if (callback) callback({ success: false, error: 'Missing required fields' });
        return;
      }
      
      // Prevent self-reporting
      if (reportedUserId === reporterId) {
        Logger.warn('report_user', 'User attempted self-report', { userId: reportedUserId });
        if (callback) callback({ success: false, error: 'Cannot report yourself' });
        return;
      }
      
      // Record report in MongoDB
      const result = await recordReport(reportedUserId, reporterId, reason);
      Logger.info('report_user', `User ${reportedUserId} reported by ${reporterId}`, { 
        reported: reportedUserId, 
        reporter: reporterId, 
        recordResult: result 
      });
      
      // Check if user is now blocked
      const isBlocked = await isUserBlocked(reportedUserId);
      if (isBlocked) {
        Logger.warn('report_user', 'Reported user is now blocked', { reportedUserId });
        
        // If reported user is online, disconnect them gracefully
        const reportedUserSocketId = userSockets.get(reportedUserId);
        if (reportedUserSocketId) {
          io.to(reportedUserSocketId).emit('user_blocked_notification', {
            reason: 'Your account has been temporarily blocked due to community reports.',
            timestamp: Date.now(),
          });
          
          // Decompose any active pairings
          decomposeRoom(reportedUserSocketId, 'video');
          decomposeRoom(reportedUserSocketId, 'chat');
          
          Logger.info('report_user', 'Blocked user disconnected from pairings', { reportedUserId, socketId: reportedUserSocketId });
        }
      }
      
      // Send notification to the reported user if they're online
      const reportedUserSocketId = userSockets.get(reportedUserId);
      Logger.info('report_user', `Looking up online status for ${reportedUserId}`, { 
        socketId: reportedUserSocketId, 
        allOnlineUsers: Array.from(userSockets.keys()).length 
      });
      
      if (reportedUserSocketId) {
        io.to(reportedUserSocketId).emit('report_notification', {
          reporterId: reporterId,
          reason: reason,
          timestamp: Date.now(),
        });
        Logger.info('report_user', `Notification sent to ${reportedUserId}`, { socketId: reportedUserSocketId });
      }
      
      if (callback) callback({ success: true, message: 'Report recorded successfully', isBlocked });
    } catch (error) {
      Logger.error('report_user', 'Error recording report', error.message);
      if (callback) callback({ success: false, error: 'Failed to record report' });
    }
  });

  // ✅ NEW: Handle gender filter preference from frontend
  socket.on('set_gender_preference', (data, callback) => {
    try {
      const socketMeta = socketMetadata.get(socket.id);
      if (!socketMeta || !socketMeta.userId) {
        Logger.warn('gender_preference', 'Invalid user metadata', { socketId: socket.id });
        if (callback) callback({ success: false, error: 'Invalid user' });
        return;
      }

      const { gender } = data;
      const validGenders = ['male', 'female', 'other', 'all'];
      
      if (!gender || !validGenders.includes(gender)) {
        Logger.warn('gender_preference', 'Invalid gender value', { gender, socketId: socket.id });
        if (callback) callback({ success: false, error: 'Invalid gender value' });
        return;
      }

      userGenderPreferences.set(socketMeta.userId, gender);
      Logger.info('gender_preference', 'Gender filter set successfully', { 
        userId: socketMeta.userId, 
        gender,
        socketId: socket.id
      });
      
      if (callback) callback({ success: true });
    } catch (error) {
      Logger.error('gender_preference', 'Error setting gender preference', error.message);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Find partner for video/chat (MongoDB-backed blocking checks)
  socket.on('find_partner', async (data) => {
    try {
      const roomType = (data && data.type) || 'video';
      const userData = socketMetadata.get(socket.id);

      Logger.info('find_partner', `🔍 User requesting ${roomType} partner`, {
        socketId: socket.id,
        userId: userData?.userId,
        userName: userData?.userName,
      });

      // Rate limiting check
      if (!checkRateLimit(socket.id)) {
        Logger.warn('find_partner', '⏱️ Rate limit exceeded', { socketId: socket.id });
        // ✅ IMPROVED: Better rate limit error response
        socket.emit('error', {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down.',
          retryAfter: 60,
        });
        return;
      }

      if (!isValidSocketId(socket.id)) {
        Logger.warn('find_partner', 'Invalid socket ID', { socketId: socket.id });
        socket.emit('error', {
          code: 'INVALID_SOCKET',
          message: 'Invalid or missing socket ID. Please reconnect.',
        });
        return;
      }

      // ✅ NEW: Check if user is blocked by reports (MongoDB-backed, async)
      if (userData && userData.userId) {
        const blocked = await isUserBlocked(userData.userId);
        if (blocked) {
          Logger.warn('find_partner', 'Blocked user attempted to find partner', { 
            userId: userData.userId, 
            userName: userData.userName 
          });
          
          // Get block info from MongoDB
          const blockInfo = await BlockedUser.findOne({ userId: userData.userId });
          const remainingMs = blockInfo && blockInfo.blockedUntil 
            ? Math.max(0, blockInfo.blockedUntil - Date.now())
            : 0;
          
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const hours = Math.floor(remainingSeconds / 3600);
          const minutes = Math.floor((remainingSeconds % 3600) / 60);
          
          let timeStr = '';
          if (hours > 0) {
            timeStr = `${hours}h ${minutes}m`;
          } else {
            timeStr = `${minutes}m`;
          }
          
          socket.emit('error', {
            code: 'USER_BLOCKED',
            message: `You are blocked from pairing. Blocked for ${timeStr}.`,
            remainingSeconds: remainingSeconds,
            blockedUntil: blockInfo?.blockedUntil,
          });
          return;
        }
      }

      const queue = roomType === 'chat' ? chatQueue : videoQueue;
      const pairings = roomType === 'chat' ? chatPairings : videoPairings;

      // Check if already paired
      if (pairings.has(socket.id)) {
        Logger.info('find_partner', 'User already paired', { socketId: socket.id, roomType });
        socket.emit('already_paired', {
          message: 'You are already in a conversation. End it before starting a new one.',
        });
        return;
      }

      // ✅ NEW: Check if already in queue to prevent duplicates
      if (queue.some((item) => item.socketId === socket.id)) {
        Logger.warn('find_partner', 'User already in queue', { socketId: socket.id, roomType });
        socket.emit('queued', {
          queuePosition: queue.findIndex((item) => item.socketId === socket.id) + 1,
          type: roomType,
        });
        return;
      }

      // ✅ DEFENSIVE: Ensure userData exists before queueing
      if (!userData) {
        Logger.error('find_partner', 'userData not found for socket', {
          socketId: socket.id,
          hasMetadata: socketMetadata.has(socket.id),
          metadataKeys: socketMetadata.get(socket.id) ? Object.keys(socketMetadata.get(socket.id)) : [],
        });
        socket.emit('error', {
          code: 'NOT_REGISTERED',
          message: 'Please register first via register_user',
        });
        return;
      }

      const queuedUser = {
        socketId: socket.id,
        userData: userData,
        joinedAt: Date.now(),
      };
      queue.push(queuedUser);
      socketQueues.set(socket.id, roomType);

      Logger.info('find_partner', 'User added to queue', {
        socketId: socket.id,
        roomType,
        userDataKeys: Object.keys(userData),
        queuePosition: queue.length,
        queueSize: queue.length,
      });

      socket.emit('queued', {
        queuePosition: queue.length,
        type: roomType,
      });

      Logger.info('find_partner', 'Attempting to match after queueing', {
        socketId: socket.id,
        roomType,
        queueSizeBeforeMatch: queue.length,
      });

      const matchResult = await attemptMatch(roomType);

      Logger.info('find_partner', 'Match attempt completed', {
        socketId: socket.id,
        roomType,
        matched: matchResult,
        queueSizeAfterMatch: queue.length,
      });

      broadcastStats();
    } catch (error) {
      Logger.error('find_partner', 'Error finding partner', error.message);
      socket.emit('error', { message: 'Failed to find partner' });
    }
  });

  // Quick invite check (socket) - useful for clients to validate invite codes before joining
  socket.on('check_invite', (data, callback) => {
    try {
      const code = data && typeof data === 'string' ? data.toString().trim().toUpperCase() : (data && data.inviteCode ? String(data.inviteCode).trim().toUpperCase() : null);
      if (!code) {
        if (typeof callback === 'function') callback({ success: false, error: 'Invalid invite code' });
        return;
      }

      for (const r of rooms.values()) {
        if (r.inviteCode && r.inviteCode.toUpperCase() === code && r.status === 'active') {
          if (typeof callback === 'function') callback({ success: true, room: r });
          return;
        }
      }
      if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
    } catch (err) {
      Logger.error('check_invite', 'Error checking invite', err && err.message);
      if (typeof callback === 'function') callback({ success: false, error: 'Internal error' });
    }
  });

  // Handle 'next' button
  socket.on('next', () => {
    try {
      if (videoPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'video');
      } else if (chatPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'chat');
      }
    } catch (error) {
      Logger.error('next', 'Error processing next', error.message);
    }
  });

  // Room leave
  socket.on('room_leave', (data) => {
    try {
      const roomType = (data && data.type) || 'video';
      Logger.info('room_leave', `User leaving ${roomType} room`, { socketId: socket.id });
      decomposeRoom(socket.id, roomType);
      broadcastStats();
    } catch (error) {
      Logger.error('room_leave', 'Error leaving room', error.message);
    }
  });

  // Switch to chat
  socket.on('switch_to_chat', (data) => {
    try {
      Logger.info('switch_to_chat', 'User switching to chat', { socketId: socket.id });

      if (videoPairings.has(socket.id)) {
        const pairing = videoPairings.get(socket.id);
        const peerId = pairing.peerId;

        if (isValidSocketId(peerId)) {
          io.to(peerId).emit('partner_switched', {
            reason: 'partner_switched_to_chat',
            timestamp: Date.now(),
          });

          videoPairings.delete(socket.id);
          videoPairings.delete(peerId);
          socketQueues.delete(peerId);

          chatQueue.push({
            socketId: peerId,
            userData: socketMetadata.get(peerId) || {},
            joinedAt: Date.now(),
          });
          socketQueues.set(peerId, 'chat');
        }
      }

      chatQueue.push({
        socketId: socket.id,
        userData: socketMetadata.get(socket.id) || {},
        joinedAt: Date.now(),
      });
      socketQueues.set(socket.id, 'chat');

      socket.emit('queued', {
        type: 'chat',
        queuePosition: chatQueue.length,
      });

      attemptMatch('chat');
      broadcastStats();
    } catch (error) {
      Logger.error('switch_to_chat', 'Error switching to chat', error.message);
      socket.emit('error', { message: 'Failed to switch to chat' });
    }
  });

  // WebRTC - offer
  socket.on('offer', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      Logger.info('offer', '📤 Received offer from initiator', {
        fromId: socket.id,
        peerId,
        matchId: pairing?.matchId,
        hasPairingForSender: videoPairings.has(socket.id),
        videoPairingSize: videoPairings.size,
        offerSdpLength: data?.sdpOffer?.sdp?.length || 0,
      });
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('offer', '📤➡️ Forwarding offer to peer', {
          fromId: socket.id,
          toId: peerId,
          hasPairingForReceiver: videoPairings.has(peerId),
        });
        // Include sender id and matchId for easier routing/debugging on client
        const out = Object.assign({}, data || {}, {
          fromId: socket.id,
          matchId: pairing?.matchId,
          forwardedAt: Date.now(),
        });
        io.to(peerId).emit('makeCall', out);
      } else {
        Logger.warn('offer', '⚠️ No valid peer found for offer', {
          fromId: socket.id,
          peerId,
          hasPairingForSender: videoPairings.has(socket.id),
          videoPairingSize: videoPairings.size,
        });
      }
    } catch (error) {
      Logger.error('offer', '❌ Error sending offer', error.message);
    }
  });

  // WebRTC - answer
  socket.on('answer', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      Logger.info('answer', '📨 Received answer from responder', {
        fromId: socket.id,
        peerId,
        matchId: pairing?.matchId,
        hasPairingForSender: videoPairings.has(socket.id),
        videoPairingSize: videoPairings.size,
        answerSdpLength: data?.sdpAnswer?.sdp?.length || 0,
      });
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('answer', '📨➡️ Forwarding answer to peer', {
          fromId: socket.id,
          toId: peerId,
          hasPairingForReceiver: videoPairings.has(peerId),
        });
        const out = Object.assign({}, data || {}, {
          fromId: socket.id,
          matchId: pairing?.matchId,
          forwardedAt: Date.now(),
        });
        io.to(peerId).emit('callAnswered', out);
      } else {
        Logger.warn('answer', '⚠️ No valid peer found for answer', {
          fromId: socket.id,
          peerId,
          hasPairingForSender: videoPairings.has(socket.id),
          videoPairingSize: videoPairings.size,
        });
      }
    } catch (error) {
      Logger.error('answer', '❌ Error sending answer', error.message);
    }
  });

  // WebRTC - ICE candidates
  socket.on('IceCandidate', (data) => {
    try {
      const pairing = videoPairings.get(socket.id);
      const peerId = pairing?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        Logger.info('IceCandidate', '❄️ Forwarding ICE candidate', {
          fromId: socket.id,
          toId: peerId,
          matchId: pairing?.matchId,
          candidate: data?.candidate?.substring(0, 50) || 'none',
        });
        const out = Object.assign({}, data || {}, {
          fromId: socket.id,
          matchId: pairing?.matchId,
          forwardedAt: Date.now(),
        });
        io.to(peerId).emit('IceCandidate', out);
      } else {
        Logger.warn('IceCandidate', '⚠️ No valid peer for ICE candidate', {
          fromId: socket.id,
          peerId,
          hasPairingForSender: videoPairings.has(socket.id),
        });
      }
    } catch (error) {
      Logger.error('IceCandidate', '❌ Error sending ICE candidate', error.message);
    }
  });

  // Chat message relay
  socket.on('message', (data) => {
    try {
      if (!data || (!data.message && !data.mediaUrl && !data.media && !data.mediaType)) {
        Logger.warn('message', 'Empty message or media', { socketId: socket.id });
        return;
      }

      const peerId = chatPairings.get(socket.id)?.peerId;
      if (peerId && isValidSocketId(peerId)) {
        // Build payload allowing text and media (GIF / sticker / mp4)
        // ✅ CRITICAL: Include ALL media fields for proper GIF/image delivery
        const mediaUrl = data.mediaUrl || data.media || null;
        const mediaType = data.mediaType || null;

        // ✅ FIXED: Get sender metadata and fallback to message data if not in socketMetadata
        const senderMeta = socketMetadata.get(socket.id) || {};
        
        // Use profile image from message if not in socketMetadata (fallback)
        const profileImageFromMessage = data.profileImagePath || data.profile_image_path || data.profileImage || data.profile_pic || null;
        const profileImage = senderMeta.profileImagePath || profileImageFromMessage || null;
        
        const senderWithProfileImage = Object.assign({}, senderMeta, {
          // Use message-sent data as fallback if socketMetadata is incomplete
          userName: senderMeta.userName || data.userName || 'Anonymous',
          userId: senderMeta.userId || data.userId || socket.id,
          avatarColor: senderMeta.avatarColor || data.avatarColor || '#128C7E',
          avatarLetter: senderMeta.avatarLetter || data.avatarLetter || 'U',
          // Include profile image in all possible field names for compatibility
          profileImagePath: profileImage,
          profile_image_path: profileImage,
          profileImage: profileImage,
        });

        const payload = {
          message: data.message ? String(data.message).substring(0, 500) : null,
          mediaUrl: mediaUrl,
          mediaType: mediaType,
          messageId: data.messageId || null,
          sender: senderWithProfileImage,
          timestamp: data.timestamp || Date.now(),
        };

        // ✅ NEW: Include reply metadata if message is a reply (preserve media fields)
        if (data.replyTo && typeof data.replyTo === 'object') {
          const replyUserName = (data.replyTo.userName || data.replyTo.senderName || '').trim();
          const finalReplyUserName = replyUserName || data.replyTo.userId || 'Unknown User';
          
          payload.replyTo = {
            messageId: data.replyTo.messageId || null,
            userName: finalReplyUserName.substring(0, 50),
            message: data.replyTo.message || null,
            timestamp: data.replyTo.timestamp || null,
            mediaUrl: data.replyTo.mediaUrl || data.replyTo.media || data.replyTo.media_url || null,
            mediaType: data.replyTo.mediaType || null,
            senderProfileImagePath: data.replyTo.senderProfileImagePath || data.replyTo.profileImagePath || data.replyTo.profile_image_path || null,
            avatarColor: data.replyTo.avatarColor || '#128C7E',
            avatarLetter: ((data.replyTo.avatarLetter || finalReplyUserName.charAt(0).toUpperCase() || 'U').substring(0, 1)),
            replyTo: data.replyTo.replyTo && typeof data.replyTo.replyTo === 'object'
              ? _sanitizeNestedReply(data.replyTo.replyTo)
              : null,
          };
        }

        Logger.info('message', 'Relaying message to peer', {
          from: socket.id,
          to: peerId,
          hasMessage: !!payload.message,
          hasMediaUrl: !!mediaUrl,
          mediaType: mediaType,
          mediaUrlLength: mediaUrl ? mediaUrl.length : 0,
          messageId: payload.messageId,
          hasReply: !!payload.replyTo,
          senderProfileImagePath: senderMeta.profileImagePath || 'MISSING',
        });

        // Send to peer
        io.to(peerId).emit('receiveMessage', payload);
      } else {
        Logger.warn('message', 'No valid peer found', { socketId: socket.id, hasChatPairing: chatPairings.has(socket.id) });
      }
    } catch (error) {
      Logger.error('message', 'Error relaying message', error.message);
    }
  });

  // One-time star gift for peer or room
  socket.on('gift_star', (data, callback) => {
    try {
      // Accept either { roomId } or { groupName } for group rooms, or empty for pair match-based gift
      const roomId = data && data.roomId ? String(data.roomId) : null;
      const groupName = data && data.groupName ? String(data.groupName) : null;
      const pairing = chatPairings.get(socket.id) || videoPairings.get(socket.id);
      const matchId = pairing && pairing.matchId ? pairing.matchId : null;

      // Prefer explicit roomId, then groupName (if provided), else matchId
      const key = roomId || groupName || matchId || null;
      if (!key) {
        if (callback) callback({ success: false, error: 'No valid target for gift' });
        return;
      }

      const giftKey = `${socket.id}:${key}`;
      if (oneTimeGifts.has(giftKey)) {
        if (callback) callback({ success: false, error: 'Already gifted' });
        return;
      }

      // Mark as gifted
      oneTimeGifts.add(giftKey);
      const prev = starCounts.get(key) || 0;
      const next = prev + 1;
      starCounts.set(key, next);

      // Notify recipient(s)
      if (matchId && pairing && pairing.peerId) {
        const peerId = pairing.peerId;
        io.to(peerId).emit('star_gifted', {
          from: socketMetadata.get(socket.id),
          to: socketMetadata.get(peerId),
          matchId,
          totalStars: next,
          timestamp: Date.now(),
        });
        // also notify sender with confirmation
        io.to(socket.id).emit('star_gifted_confirm', { totalStars: next, key, timestamp: Date.now() });
      } else if (roomId || groupName) {
        // Broadcast to room members (match by roomId or groupName)
        const room = Array.from(rooms.values()).find(r => (roomId && (r.roomId === roomId || r.roomId === String(roomId))) || (groupName && r.roomName === groupName));
        if (room) {
          for (const memberId of room.memberIds) {
            const memberSocketId = userSockets.get(memberId);
            if (memberSocketId) {
              io.to(memberSocketId).emit('star_gifted', {
                from: socketMetadata.get(socket.id),
                roomId: room.roomId,
                totalStars: next,
                timestamp: Date.now(),
              });
            }
          }
        }
        io.to(socket.id).emit('star_gifted_confirm', { totalStars: next, key, timestamp: Date.now() });
      }

      if (callback) callback({ success: true, totalStars: next });
    } catch (err) {
      Logger.error('gift_star', 'Error processing star gift', err && err.message);
      if (callback) callback({ success: false, error: 'Failed to gift star' });
    }
  });

  // ========== TYPING INDICATORS ==========
  // ✅ NEW: Send typing indicator when user types in direct message
  socket.on('send_typing', (data) => {
    try {
      const { recipientId, isTyping } = data;
      const senderMeta = socketMetadata.get(socket.id) || {};
      const senderId = senderMeta.userId;
      
      if (!senderId || !recipientId) {
        Logger.warn('send_typing', 'Missing senderId or recipientId', { senderId, recipientId });
        return;
      }

      const recipientSocketId = userSockets.get(recipientId);
      if (!recipientSocketId) {
        Logger.debug('send_typing', 'Recipient not online, skipping typing indicator', { senderId, recipientId });
        return;
      }

      // Send typing indicator to recipient
      io.to(recipientSocketId).emit('user_typing', {
        senderId,
        senderName: senderMeta.userName || 'Unknown',
        isTyping,
        timestamp: Date.now(),
      });
    } catch (err) {
      Logger.error('send_typing', 'Error sending typing indicator', err && err.message);
    }
  });

  // ========== PROFILE UPDATE BROADCASTS ==========
  // ✅ NEW: Broadcast profile updates to all connected peers
  socket.on('profile_updated', (data) => {
    try {
      const senderMeta = socketMetadata.get(socket.id) || {};
      const userId = senderMeta.userId;
      
      if (!userId) {
        Logger.warn('profile_updated', 'User not registered', { socketId: socket.id });
        return;
      }

      // Extract updated fields
      const profileUpdate = {
        userId,
        userName: data.userName || senderMeta.userName,
        avatarColor: data.avatarColor || senderMeta.avatarColor,
        avatarLetter: data.avatarLetter || senderMeta.avatarLetter,
        gender: data.gender || null,
        country: data.country || null,
        profileImagePath: data.profileImagePath ?? senderMeta.profileImagePath ?? null,
        profileImageUrl: data.profileImageUrl ?? senderMeta.profileImageUrl ?? null,
        timestamp: Date.now(),
      };

      // Update socket metadata with new profile data, including profileImageUrl
      socketMetadata.set(socket.id, {
        ...senderMeta,
        userName: profileUpdate.userName,
        avatarColor: profileUpdate.avatarColor,
        avatarLetter: profileUpdate.avatarLetter,
        profileImagePath: profileUpdate.profileImagePath || senderMeta.profileImagePath,
        profileImageUrl: profileUpdate.profileImageUrl || senderMeta.profileImageUrl,
      });

      // Broadcast update to all connected clients
      io.emit('profile_update', profileUpdate);

      Logger.info('profile_updated', 'Profile update broadcasted', {
        userId,
        fields: Object.keys(profileUpdate).join(', '),
      });
    } catch (err) {
      Logger.error('profile_updated', 'Error broadcasting profile update', err && err.message);
    }
  });

  // ========== DIRECT MESSAGE EVENTS ==========
  // ✅ NEW: Handle direct messages with proper routing and offline storage
  socket.on('send_direct_message', async (data) => {
    try {
      const { recipientId, content, message, text, messageId } = data;
      const senderMeta = socketMetadata.get(socket.id) || {};
      const senderId = senderMeta.userId;
      const messageText = content || message || text || '';
      const mediaUrl = data.mediaUrl || data.gifUrl || data.media || data.image || data.media_url || null;
      const mediaType = data.mediaType || data.type || data.gifType || data.media_type || null;
      const finalMessageId = messageId || `msg_${Date.now()}`;
      
      if (!senderId || !recipientId) {
        Logger.warn('send_direct_message', 'Missing senderId or recipientId', { senderId, recipientId });
        return;
      }

      const mediaFallback = mediaUrl
        ? (mediaType === 'gif'
            ? 'GIF'
            : mediaType === 'image'
                ? 'Image'
                : mediaType === 'video'
                    ? 'Video'
                    : 'Media')
        : '';

      // Build message payload
      // ✅ NEW: Fetch fresh sender profile from MongoDB for latest profileImageUrl
      const senderFreshProfile = senderId ? await getFreshUserProfile(senderId) : null;
      
      const messagePayload = {
        id: finalMessageId,
        messageId: finalMessageId,
        senderId,
        senderName: (senderFreshProfile?.userName || senderMeta.userName || 'Unknown'),
        recipientId,
        message: messageText,
        content: messageText || mediaFallback,
        text: messageText || mediaFallback,
        mediaUrl,
        mediaType,
        replyTo: data.replyTo || null,
        profileImagePath: senderMeta.profileImagePath,
        profileImageUrl: senderFreshProfile?.profileImageUrl || null,
        senderProfileImagePath: senderMeta.profileImagePath,
        avatarColor: (senderFreshProfile?.avatarColor || senderMeta.avatarColor || '#128C7E'),
        avatarLetter: senderMeta.avatarLetter || 'U',
        timestamp: new Date().toISOString(),
      };

      const recipientSocketId = userSockets.get(recipientId);
      
      if (recipientSocketId) {
        // ✅ IMPORTANT: Recipient is online - send message immediately
        io.to(recipientSocketId).emit('direct_message', messagePayload);
        Logger.info('send_direct_message', 'Message sent to online recipient', {
          senderId,
          recipientId,
          recipientSocketId,
        });
      } else {
        // ✅ NEW: Recipient is offline - store message for later delivery
        Logger.info('send_direct_message', 'Recipient offline, storing message for later', {
          senderId,
          recipientId,
        });
        
        // Store in offlineMessages map for delivery when recipient comes online
        if (!offlineMessages) {
          offlineMessages = new Map();
        }
        if (!offlineMessages.has(recipientId)) {
          offlineMessages.set(recipientId, []);
        }
        offlineMessages.get(recipientId).push({ payload: messagePayload, ts: Date.now() });
      }
    } catch (err) {
      Logger.error('send_direct_message', 'Error sending direct message', err && err.message);
    }
  });

  // ✅ NEW: Handle message seen/read receipt - Notify sender that their message was read
  socket.on('message_seen', (data) => {
    try {
      const { senderId, recipientId, senderName, timestamp } = data;
      const senderSocketId = userSockets.get(senderId);

      if (senderSocketId) {
        // ✅ Send read receipt confirmation back to sender
        io.to(senderSocketId).emit('message_read_receipt', {
          senderId: recipientId,
          senderName: senderName || 'User',
          timestamp: timestamp || new Date().toISOString(),
        });
        Logger.info('message_seen', 'Read receipt sent to sender', {
          senderId,
          recipientId,
          senderName,
        });
      } else {
        Logger.info('message_seen', 'Sender offline, skipping read receipt', {
          senderId,
          recipientId,
        });
      }
    } catch (err) {
      Logger.error('message_seen', 'Error processing read receipt', err && err.message);
    }
  });

  // Disconnect
  socket.on('disconnect', (reason) => {
    try {
      Logger.info('disconnect', `Client disconnected: ${reason}`, { socketId: socket.id });

      // Decompose pairings
      if (videoPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'video');
      } else if (chatPairings.has(socket.id)) {
        decomposeRoom(socket.id, 'chat');
      }

      // Remove from queues
      const videoIdx = videoQueue.findIndex((item) => item.socketId === socket.id);
      if (videoIdx !== -1) videoQueue.splice(videoIdx, 1);

      const chatIdx = chatQueue.findIndex((item) => item.socketId === socket.id);
      if (chatIdx !== -1) chatQueue.splice(chatIdx, 1);

      // Clean metadata
      const userData = socketMetadata.get(socket.id);
      if (userData) {
        userSockets.delete(userData.userId);
        // ✅ NEW: Clean gender preference on disconnect
        userGenderPreferences.delete(userData.userId);
      }
      socketMetadata.delete(socket.id);
      // ✅ FIX: Remove this socket from any groupChatRooms to avoid memory leaks
      try {
        for (const [groupName, roomSet] of groupChatRooms.entries()) {
          if (roomSet && roomSet.has && roomSet.has(socket.id)) {
            roomSet.delete(socket.id);
            try { socket.leave(`group_${groupName}`); } catch (e) {}
            if (roomSet.size === 0) {
              groupChatRooms.delete(groupName);
              messageIdCache.delete(groupName);
              Logger.info('disconnect', 'Cleaned empty group room after disconnect', { groupName });
            }
          }
        }
      } catch (e) {
        Logger.warn('disconnect', 'Error cleaning groupChatRooms for socket', { socketId: socket.id, err: e && e.message });
      }
      socketQueues.delete(socket.id);
      health.updateSocketConnections(io.of('/').sockets.size);

      broadcastStats();
    } catch (error) {
      Logger.error('disconnect', 'Error during disconnect cleanup', error.message);
    }
  });

  // ========== GROUP CHAT EVENTS ==========
  
  // Message deduplication uses the shared global cache
  
  // ✅ NEW: Get group members list (for members dialog)
  socket.on('get_group_members', (data, callback) => {
    try {
      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet) {
        if (callback) callback({ success: false, members: [], memberCount: 0 });
        return;
      }

      // ✅ Get all members with complete profile data for animations
      const members = [];
      for (const memberSocketId of roomSet) {
        const memberMeta = socketMetadata.get(memberSocketId) || {};
        members.push({
          socketId: memberSocketId,
          userId: memberMeta.userId || '',
          userName: memberMeta.userName || 'Unknown User',
          avatarColor: memberMeta.avatarColor || '#128C7E',
          avatarLetter: (memberMeta.avatarLetter || (memberMeta.userName ? memberMeta.userName.charAt(0).toUpperCase() : 'U')).substring(0, 1),
          profileImagePath: memberMeta.profileImagePath || null,
          senderProfileImagePath: memberMeta.profileImagePath || null,
        });
      }

      Logger.info('get_group_members', 'Fetched group members', {
        groupName,
        memberCount: members.length,
      });

      if (callback) {
        callback({
          success: true,
          groupName,
          members,
          memberCount: members.length,
        });
      }
    } catch (error) {
      Logger.error('get_group_members', 'Error getting group members', error.message);
      if (callback) callback({ success: false, error: 'Failed to get members' });
    }
  });

  // User joins a group
  socket.on('join_group', async (data, callback) => {
    try {
      let groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        Logger.warn('join_group', 'Invalid group name', { socketId: socket.id });
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      // ✅ NEW: Room replica system - if room is at capacity, find or create a replica
      const baseGroupName = data && data.groupName ? String(data.groupName).trim() : groupName;
      let replicaIndex = 0;
      let actualRoomName = baseGroupName;
      let isReplica = false;
      
      // Find the first available room (base or replica) with space
      while (groupChatRooms.has(actualRoomName)) {
        const currentSet = groupChatRooms.get(actualRoomName);
        if (currentSet.size < CONFIG.GROUP_ROOM_CAPACITY) {
          // Found a room with space
          groupName = actualRoomName;
          isReplica = replicaIndex > 0;
          break;
        }
        // Room is full, try next replica
        replicaIndex++;
        actualRoomName = `${baseGroupName}_replica${replicaIndex}`;
      }

      // If no existing room has space, use the next available room name
      if (groupName === data.groupName) {
        groupName = actualRoomName;
        isReplica = replicaIndex > 0;
      }

      // Get or create room (main or replica)
      if (!groupChatRooms.has(groupName)) {
        groupChatRooms.set(groupName, new Set());
      }

      const roomSet = groupChatRooms.get(groupName);
      const wasAlreadyMember = roomSet.has(socket.id);

      // Add user to room
      roomSet.add(socket.id);
      socket.join(`group_${groupName}`);

      // Persist any profile image provided by the client when joining so the server
      // can use it for later group messages (helps when clients send data: URIs).
      try {
        const meta = socketMetadata.get(socket.id) || {};
        const incomingProfile = data?.profileImagePath || data?.senderProfileImagePath || data?.profile_image_path || data?.profileImage || data?.profile_pic || data?.photo || data?.avatarUrl || data?.img || null;
        if (incomingProfile) {
          meta.profileImagePath = incomingProfile;
          socketMetadata.set(socket.id, meta);
          Logger.info('join_group', 'Persisted incoming profileImagePath from join_group', { socketId: socket.id, preview: String(incomingProfile).substring(0, 64) });
        }
      } catch (err) {
        Logger.warn('join_group', 'Failed to persist incoming profile image to socketMetadata', { socketId: socket.id, err: err && err.message });
      }

      const memberCount = roomSet.size;

      Logger.info('join_group', 'User joined group', {
        socketId: socket.id,
        userName: data?.userName,
        groupName,
        memberCount,
        isReplica,
        wasAlreadyMember,
      });

      // ✅ FIXED: Send complete member list to new joiner (for animations)
      // ✅ NEW: Enrich members with fresh profiles from MongoDB for latest profileImageUrl
      const allMembers = [];
      for (const memberSocketId of roomSet) {
        const memberMeta = socketMetadata.get(memberSocketId) || {};
        
        // Fetch fresh profile from MongoDB if we have a userId
        const freshProfile = memberMeta.userId ? await getFreshUserProfile(memberMeta.userId) : null;
        
        const memberData = {
          socketId: memberSocketId,
          userId: memberMeta.userId || '',
          userName: (freshProfile?.userName || memberMeta.userName || 'Unknown User'),
          avatarColor: (freshProfile?.avatarColor || memberMeta.avatarColor || '#128C7E'),
          avatarLetter: memberMeta.avatarLetter || 'U',
          profileImagePath: memberMeta.profileImagePath || null,
          profileImageUrl: freshProfile?.profileImageUrl || null,
          senderProfileImagePath: memberMeta.profileImagePath || null,
        };
        allMembers.push(memberData);
      }

      const requestedGroupName = baseGroupName;

      // Send joiner the full member list
      socket.emit('group_members_list', {
        groupName,
        requestedGroupName,
        members: allMembers,
        memberCount,
        timestamp: new Date().toISOString(),
      });

      // Notify all users in group (including the new joiner) of new member with full data
      // ✅ NEW: Fetch fresh profile for the joiner to ensure latest profileImageUrl
      const joinerFreshProfile = data?.userId ? await getFreshUserProfile(data.userId) : null;
      
      io.to(`group_${groupName}`).emit('user_joined_group', {
        groupName,
        requestedGroupName,
        groupIcon: data?.groupIcon || '💬',
        groupId: data?.groupId || null,
        senderSocketId: socket.id,
        userId: data?.userId,
        userName: (joinerFreshProfile?.userName || data?.userName || 'Unknown User'),
        profileImagePath: data?.profileImagePath || data?.senderProfileImagePath || null,
        profileImageUrl: joinerFreshProfile?.profileImageUrl || null,
        senderProfileImagePath: data?.senderProfileImagePath || data?.profileImagePath || null,
        avatarColor: (joinerFreshProfile?.avatarColor || data?.avatarColor || '#128C7E'),
        avatarLetter: data?.avatarLetter || 'U',
        memberCount,
        capacity: CONFIG.GROUP_ROOM_CAPACITY || 10,
        roomName: groupName,
        allMembers: allMembers,
        timestamp: new Date().toISOString(),
      });

      if (callback) {
        // ✅ FIXED: Send complete member list in callback response
        callback({
          success: true,
          groupName,
          requestedGroupName,
          memberCount,
          capacity: CONFIG.GROUP_ROOM_CAPACITY || 10,
          roomName: groupName,
          allMembers: allMembers,
          message: `Joined ${groupName}. Total members: ${memberCount}`,
        });
      }
    } catch (error) {
      Logger.error('join_group', 'Error joining group', error.message);
      if (callback) callback({ success: false, error: 'Failed to join group' });
    }
  });

  // User sends message to group
  socket.on('send_group_message', (data, callback) => {
    try {
      // ✅ NEW: Rate limiting for message sending (prevent spam)
      if (!checkRateLimit(socket.id)) {
        Logger.warn('send_group_message', 'Rate limit exceeded for user', { socketId: socket.id });
        if (callback) {
          callback({
            success: false,
            error: 'Too many messages. Please slow down.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: 60,
          });
        }
        return;
      }

      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      const message = data && data.message ? String(data.message).trim() : null;
      const clientMessageId = data && data.messageId ? String(data.messageId).trim() : null;
      const mediaUrl = data && data.mediaUrl ? String(data.mediaUrl).trim() : null;
      const mediaType = data && data.mediaType ? String(data.mediaType).trim() : null;

      // ✅ FIXED: Allow message if groupName exists AND (text OR media) is present
      if (!groupName || (!message && !mediaUrl)) {
        Logger.warn('send_group_message', 'Invalid message data', {
          socketId: socket.id,
          hasGroupName: !!groupName,
          hasMessage: !!message,
          hasMedia: !!mediaUrl,
          mediaType: mediaType || 'none',
        });
        if (callback) callback({ success: false, error: 'Invalid message data' });
        return;
      }

      // Validate user is in group
      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet || !roomSet.has(socket.id)) {
        Logger.warn('send_group_message', 'User not in group', {
          socketId: socket.id,
          groupName,
        });
        if (callback) callback({ success: false, error: 'Not in this group' });
        return;
      }

      // Use client messageId if provided (helps with deduplication), otherwise generate
      const serverMessageId = clientMessageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Initialize dedup cache for this group if needed
      if (!messageIdCache.has(groupName)) {
        messageIdCache.set(groupName, { ids: new Set(), timestamp: Date.now() });
      }
      
      const cache = messageIdCache.get(groupName);
      
      // Check if this message was already broadcast (deduplication)
      if (cache.ids.has(serverMessageId)) {
        Logger.warn('send_group_message', 'Duplicate message detected and skipped', {
          socketId: socket.id,
          groupName,
          messageId: serverMessageId,
        });
        if (callback) callback({ success: true, duplicate: true, messageId: serverMessageId });
        return;
      }
      
      // Add to dedup cache
      cache.ids.add(serverMessageId);
      cache.timestamp = Date.now();

      // ✅ CRITICAL FIX: Get sender's ACTUAL profile from server (not trusting client data)
      const senderMeta = socketMetadata.get(socket.id) || {};

      const messageData = {
        userId: senderMeta.userId || data?.userId || '',
        userName: (senderMeta.userName || data?.userName || 'Unknown User').substring(0, 50),
        message: message ? message.substring(0, 1000) : null,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        senderProfileImagePath: senderMeta.profileImagePath || data?.senderProfileImagePath || data?.profileImagePath || data?.profile_image_path || null,
        profileImagePath: senderMeta.profileImagePath || data?.profileImagePath || data?.senderProfileImagePath || data?.profile_image_path || null,
        avatarColor: senderMeta.avatarColor || data?.avatarColor || '#128C7E',
        avatarLetter: (senderMeta.avatarLetter || data?.avatarLetter || (senderMeta.userName ? senderMeta.userName.charAt(0).toUpperCase() : 'U')).substring(0, 1),
        timestamp: Date.now(),
        messageId: serverMessageId,
      };

      // If the client included reply metadata, preserve and forward it (including media)
      if (data.replyTo && typeof data.replyTo === 'object') {
        const replyUserName = (data.replyTo.userName || data.replyTo.senderName || '').trim();
        const finalReplyUserName = replyUserName || data.replyTo.userId || 'Unknown User';
        
        messageData.replyTo = {
          messageId: data.replyTo.messageId || null,
          userName: finalReplyUserName.substring(0, 50),
          message: data.replyTo.message || null,
          timestamp: data.replyTo.timestamp || null,
          mediaUrl: data.replyTo.mediaUrl || data.replyTo.media || data.replyTo.media_url || null,
          mediaType: data.replyTo.mediaType || null,
          senderProfileImagePath: data.replyTo.senderProfileImagePath || data.replyTo.profileImagePath || data.replyTo.profile_image_path || null,
          avatarColor: data.replyTo.avatarColor || '#128C7E',
          avatarLetter: ((data.replyTo.avatarLetter || finalReplyUserName.charAt(0).toUpperCase() || 'U').substring(0, 1)),
          replyTo: data.replyTo.replyTo && typeof data.replyTo.replyTo === 'object'
            ? _sanitizeNestedReply(data.replyTo.replyTo)
            : null,
        };
      }

      Logger.info('send_group_message', 'Broadcasting message to others (not sender)', {
        socketId: socket.id,
        groupName,
        userName: messageData.userName,
        messageId: serverMessageId,
        roomSize: roomSet.size,
      });

      // Broadcast to OTHER users in the group (NOT including sender - they use optimistic update)
      socket.to(`group_${groupName}`).emit('group_message', messageData);

      if (callback) {
        callback({
          success: true,
          messageId: serverMessageId,
          timestamp: messageData.timestamp,
          data: messageData,
        });
      }
    } catch (error) {
      Logger.error('send_group_message', 'Error sending message', error.message);
      if (callback) callback({ success: false, error: 'Failed to send message' });
    }
  });

  // User leaves group
  socket.on('leave_group', (data, callback) => {
    try {
      const groupName = data && data.groupName ? String(data.groupName).trim() : null;
      if (!groupName) {
        if (callback) callback({ success: false, error: 'Invalid group name' });
        return;
      }

      const roomSet = groupChatRooms.get(groupName);
      if (!roomSet) {
        if (callback) callback({ success: false, error: 'Group not found' });
        return;
      }

      const wasInGroup = roomSet.has(socket.id);
      roomSet.delete(socket.id);
      socket.leave(`group_${groupName}`);

      const memberCount = roomSet.size;

      Logger.info('leave_group', 'User left group', {
        socketId: socket.id,
        userName: (data?.userName || 'Unknown User').substring(0, 50),
        groupName,
        memberCount,
        wasInGroup,
      });

      // Notify remaining users in group
      if (memberCount > 0) {
        // Build updated member list for remaining users
        const remainingMembers = [];
        for (const memberSocketId of roomSet) {
          const memberMeta = socketMetadata.get(memberSocketId) || {};
          remainingMembers.push({
            socketId: memberSocketId,
            userId: memberMeta.userId || '',
            userName: memberMeta.userName || 'Unknown User',
            avatarColor: memberMeta.avatarColor || '#128C7E',
            avatarLetter: memberMeta.avatarLetter || 'U',
            profileImagePath: memberMeta.profileImagePath || null,
            senderProfileImagePath: memberMeta.profileImagePath || null,
          });
        }

        io.to(`group_${groupName}`).emit('user_left_group', {
          groupName,
          userId: data?.userId || '',
          userName: (data?.userName || 'Unknown User').substring(0, 50),
          memberCount,
          capacity: CONFIG.GROUP_ROOM_CAPACITY || 10,
          roomName: groupName,
          allMembers: remainingMembers,
          timestamp: Date.now(),
        });
      } else {
        // Clean up empty room and its dedup cache
        groupChatRooms.delete(groupName);
        messageIdCache.delete(groupName); // Clean up dedup cache for empty group
        Logger.info('leave_group', 'Removed empty group room and cleaned cache', { groupName });
      }

      if (callback) {
        callback({
          success: true,
          groupName,
          memberCount,
          message: `Left ${groupName}`,
        });
      }
    } catch (error) {
      Logger.error('leave_group', 'Error leaving group', error.message);
      if (callback) callback({ success: false, error: 'Failed to leave group' });
    }
  });

});

// ========== CLEANUP & MAINTENANCE ==========
setInterval(() => {
  try {
    const now = Date.now();

    // Clean video queue - with timeout notifications
    for (let i = videoQueue.length - 1; i >= 0; i--) {
      if (now - videoQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
        const stalUser = videoQueue.splice(i, 1)[0];
        const waitedMs = now - stalUser.joinedAt;
        
        // Notify user of timeout
        if (io.sockets.sockets.get(stalUser.socketId)) {
          io.to(stalUser.socketId).emit('queue_timeout', {
            type: 'video',
            reason: 'No partner found - waited too long',
            waitedSeconds: Math.floor(waitedMs / 1000),
            maxWaitSeconds: Math.floor(CONFIG.STALE_TIMEOUT / 1000),
          });
        }
        
        socketQueues.delete(stalUser.socketId);
        Logger.info('cleanup', 'Removed stale video user', {
          socketId: stalUser.socketId,
          waitedSeconds: Math.floor(waitedMs / 1000),
        });
      }
    }

    // Clean chat queue - with timeout notifications
    for (let i = chatQueue.length - 1; i >= 0; i--) {
      if (now - chatQueue[i].joinedAt > CONFIG.STALE_TIMEOUT) {
        const stalUser = chatQueue.splice(i, 1)[0];
        const waitedMs = now - stalUser.joinedAt;
        
        // Notify user of timeout
        if (io.sockets.sockets.get(stalUser.socketId)) {
          io.to(stalUser.socketId).emit('queue_timeout', {
            type: 'chat',
            reason: 'No chat partner found - waited too long',
            waitedSeconds: Math.floor(waitedMs / 1000),
            maxWaitSeconds: Math.floor(CONFIG.STALE_TIMEOUT / 1000),
          });
        }
        
        socketQueues.delete(stalUser.socketId);
        Logger.info('cleanup', 'Removed stale chat user', {
          socketId: stalUser.socketId,
          waitedSeconds: Math.floor(waitedMs / 1000),
        });
      }
    }

    // Clean stale group message ID caches
    for (const [groupName, cache] of messageIdCache.entries()) {
      if (cache.timestamp && now - cache.timestamp > MESSAGE_CACHE_TIMEOUT) {
        messageIdCache.delete(groupName);
      }
    }
    // ✅ FIX: Clean stale groupChatRooms entries (remove dead sockets and delete empty rooms)
    try {
      for (const [groupName, roomSet] of groupChatRooms.entries()) {
        for (const memberSocketId of Array.from(roomSet)) {
          // If socket no longer exists in Socket.IO or no metadata, remove it
          if (!io.sockets.sockets.has(memberSocketId) || !socketMetadata.has(memberSocketId)) {
            roomSet.delete(memberSocketId);
          }
        }
        if (roomSet.size === 0) {
          groupChatRooms.delete(groupName);
          messageIdCache.delete(groupName);
          Logger.info('cleanup', 'Removed stale empty group room during cleanup', { groupName });
        }
      }
    } catch (e) {
      Logger.warn('cleanup', 'Error cleaning stale groupChatRooms', { err: e && e.message });
    }
    
    broadcastStats();
  } catch (error) {
    Logger.error('cleanup', 'Error during cleanup', error.message);
  }
}, CONFIG.CLEANUP_INTERVAL);

// ✅ NEW: Periodic online count broadcast (every 5 seconds) - ensures clients always have current count
setInterval(() => {
  try {
    broadcastStats();
  } catch (err) {
    Logger.error('periodicBroadcast', 'Error broadcasting stats', err.message);
  }
}, 5000);

// ✅ Register 404 and error handlers (MUST be LAST)
app.use(notFoundHandler);
app.use(errorHandler);

// ========== SERVER STARTUP ==========
// The server starts automatically once MongoDB is connected.
// This prevents accepting requests before the database is available.

// ========== GRACEFUL SHUTDOWN ==========
// Handle graceful shutdown on SIGTERM/SIGINT (production standard signals)
let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    Logger.warn('shutdown', 'Shutdown already in progress, ignoring signal', { signal });
    return;
  }

  isShuttingDown = true;
  Logger.info('shutdown', `${signal} received, initiating graceful shutdown...`, {
    signal,
    timestamp: new Date().toISOString(),
    activeConnections: io.of('/').sockets.size,
  });

  try {
    // ✅ Step 1: Stop accepting new connections
    server.close(async () => {
      Logger.info('shutdown', 'HTTP server closed, no new connections accepted');
    });

    // ✅ Step 2: Disconnect all Socket.IO clients gracefully
    Logger.info('shutdown', 'Disconnecting Socket.IO clients...', {
      activeConnections: io.of('/').sockets.size,
    });
    
    const sockets = io.of('/').sockets;
    for (const [socketId, socket] of sockets) {
      try {
        socket.disconnect(true); // Force disconnect with reconnection disabled
      } catch (err) {
        Logger.warn('shutdown', 'Error disconnecting socket', {
          socketId,
          error: err.message,
        });
      }
    }
    Logger.info('shutdown', 'Socket.IO clients disconnected');

    // ✅ Step 3: Stop health monitoring
    if (health && health.stopMonitoring) {
      try {
        health.stopMonitoring();
        Logger.info('shutdown', 'Health monitoring stopped');
      } catch (err) {
        Logger.warn('shutdown', 'Error stopping health monitoring', { error: err.message });
      }
    }

    // ✅ Step 4: Close MongoDB connection gracefully
    Logger.info('shutdown', 'Closing MongoDB connection...');
    if (mongoose.connection && mongoose.connection.db) {
      try {
        await mongoose.connection.close();
        Logger.info('shutdown', 'MongoDB connection closed gracefully');
      } catch (err) {
        Logger.warn('shutdown', 'Error closing MongoDB', { error: err.message });
      }
    }

    // ✅ Step 5: Clear in-memory state
    Logger.info('shutdown', 'Clearing in-memory state...', {
      videoPairings: videoPairings.size,
      chatPairings: chatPairings.size,
      videoQueue: videoQueue.length,
      chatQueue: chatQueue.length,
      groupRooms: groupChatRooms.size,
      socketMetadata: socketMetadata.size,
    });
    
    videoPairings.clear();
    chatPairings.clear();
    videoQueue.length = 0;
    chatQueue.length = 0;
    rooms.clear();
    groupChatRooms.clear();
    socketMetadata.clear();
    userSockets.clear();
    socketQueues.clear();
    rateLimitMap.clear();
    userGenderPreferences.clear();

    Logger.info('shutdown', '✅ Graceful shutdown completed successfully', {
      signal,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });

    process.exit(0);
  } catch (err) {
    Logger.error('shutdown', 'Error during graceful shutdown', {
      signal,
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
};

// Handle SIGTERM (production termination signal)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle SIGINT (Ctrl+C in development)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ========== ERROR HANDLING ==========
process.on('uncaughtException', (error) => {
  Logger.error('uncaughtException', 'Uncaught exception', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('unhandledRejection', 'Unhandled rejection', String(reason));
});
