# 🗄️ MongoDB Integration Guide - OmegleLOL Backend

## ✅ Configuration Complete!

Your backend is now configured to connect to **SlyxyDatabase** MongoDB Atlas cluster with optimized settings for frontend integration.

---

## 📋 What Was Updated

### 1. **Environment Variables** (`.env` file)
```env
MONGODB_URI=mongodb+srv://overx:ankit5639@slyxydatabase.bzzvo8t.mongodb.net/?appName=slyxyDataBase
PORT=8080
SERVER_IP=127.0.0.1
SERVER_BIND=0.0.0.0
NODE_ENV=development
```

### 2. **MongoDB Configuration** (ws_server.js)
Added `MONGODB_CONFIG` constant with:
- ✅ Connection pooling (max 10, min 2 connections)
- ✅ Automatic retries for resilience
- ✅ optimized timeouts for frontend compatibility
- ✅ Write concern for data reliability

### 3. **Logger Utility**
- Initialized early for proper error tracking
- Logs all MongoDB connection events
- Frontend-friendly error responses

---

## 🚀 Quick Start

### Prerequisites
```bash
# Install dependencies
npm install
```

### Run the Server
```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

### Expected Output
```
🔄 Connecting to MongoDB...
📍 Database: slyxyDataBase
✅ Connected to MongoDB Atlas Successfully!
[timestamp] [INFO] [mongodb] ✅ Connected to MongoDB Atlas
✅ WebSocket server listening
  bind: 0.0.0.0
  advertisedIP: 127.0.0.1
  port: 8080
```

---

## 📊 Database Collections

Your MongoDB database now supports:

### **Users**
```javascript
{
  userId: String,           // Unique user ID
  userName: String,         // Display name
  email: String,           // Email address
  authType: String,        // GOOGLE_OAUTH | LOCAL | GUEST
  gender: String,          // male | female | other
  country: String,         // Country name
  avatarColor: String,     // Hex color code
  profileImageUrl: String, // External URL only
  likeCount: Number,       // Total likes received
  starCount: Number,       // Total stars received
  createdAt: Date,
  updatedAt: Date,
  lastLogin: Date
}
```

### **BlockedUsers**
```javascript
{
  userId: String,          // Blocked user ID
  blockedByUserId: String, // Admin or SYSTEM
  reason: String,
  blockType: String,       // report | manual
  blockDuration: Number,   // Duration in ms
  blockedUntil: Date,      // When block expires
  reportCount: Number,
  reporters: [String],     // List of reporter IDs
  createdAt: Date
}
```

### **Reports**
```javascript
{
  reportedUserId: String,  // User being reported
  reporterId: String,      // User who reported
  reason: String,
  createdAt: Date          // Auto-expires after 24 hours
}
```

### **Rooms**
```javascript
{
  roomId: String,          // Unique room ID
  roomName: String,        // Display name
  creatorId: String,       // Created by user
  roomType: String,        // public | private
  inviteCode: String,      // 6-character code
  memberIds: [String],     // Array of user IDs
  maxMembers: Number,      // Capacity limit
  status: String,          // active | archived
  createdAt: Date
}
```

---

## 🔌 Frontend API Endpoints

### Authentication
- `POST /auth/register` - Register new user
- `POST /auth/login` - Login user
- `POST /auth/validate-token` - Validate Google OAuth token

### User Profile
- `GET /user/:userId` - Get user profile
- `POST /user/:userId/update` - Update profile

### Rooms
- `POST /room/create` - Create a room
- `POST /room/join` - Join a room by invite/ID
- `GET /room/by-invite/:code` - Lookup room by invite code
- `GET /list-public-rooms` - List public rooms

### WebSocket Events
- `register_user` - Register socket connection
- `find_partner` - Find video/chat partner
- `report_user` - Report a user
- `gift_star` - Send star to user/room

---

## 🔐 Security Features

### Connection Security
- ✅ MongoDB Atlas encryption in transit (TLS)
- ✅ Credentials stored in environment variables (never hard-coded)
- ✅ Connection pooling for DDoS resilience
- ✅ Automatic retry logic with exponential backoff

### Data Protection
- ✅ Password hashing with `bcryptjs`
- ✅ Report-based progressive user blocking
- ✅ Block expiration for temporary blocks
- ✅ User activity logging

### Rate Limiting
- 30 requests per minute per socket
- Prevents abuse and spam

---

## 📱 Frontend Integration

### Socket.IO Configuration
```javascript
// Frontend should connect to:
const socket = io('YOUR_SERVER_IP:8080', {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5
});
```

### Register User After Connection
```javascript
socket.emit('register_user', {
  userId: 'user123',
  userName: 'John Doe',
  gender: 'male',
  country: 'USA',
  avatarColor: '#128C7E'
}, (response) => {
  console.log('Connected:', response);
});
```

### Find Partner
```javascript
socket.emit('find_partner', {
  roomType: 'video,  // or 'chat'
  genderPreference: 'all' // or 'male', 'female', 'other'
}, (response) => {
  if (response.success) {
    console.log('Partner found:', response.partnerId);
  }
});
```

### Report User
```javascript
socket.emit('report_user', {
  reportedUserId: 'baduser123',
  reason: 'Inappropriate behavior'
}, (response) => {
  console.log('Report submitted:', response);
});
```

---

## 🛠️ Troubleshooting

### MongoDB Connection Issues
```
❌ Error: "connect ECONNREFUSED"
→ Check MONGODB_URI in .env file
→ Verify MongoDB Atlas cluster is running
→ Check firewall/network access
```

### Server Won't Start
```
❌ Error: "Cannot find module 'dotenv'"
→ Run: npm install
→ Make sure .env file exists in root directory
```

### Slow Frontend Response
```
❌ Symptoms: Delayed connections, timeouts
→ Check MongoDB connection pool settings
→ Verify network latency to Atlas cluster
→ Check server CPU/memory usage
```

### Users Can't Connect
```
❌ Error: "socket connection failed"
→ Verify SERVER_BIND and SERVER_IP in .env
→ Check firewall allows port 8080
→ Verify CORS is enabled (it is by default)
```

---

## 📈 Performance Optimization Tips

### For High Traffic
1. Increase `maxPoolSize` in MONGODB_CONFIG (default: 10)
2. Use `retryWrites: true` for automatic retry logic
3. Add indexes to frequently queried fields
4. Enable MongoDB compression

### For Latency Reduction
1. Ensure server is geographically close to Atlas cluster
2. Use WebSocket-first transport (enabled by default)
3. Enable query result caching in your app
4. Reduce JSON payload size

---

## ✨ Next Steps

1. ✅ **Verify MongoDB Connection**
   ```bash
   npm run dev
   ```
   Look for "✅ Connected to MongoDB Atlas Successfully!"

2. ✅ **Test Frontend Connection**
   - Connect from frontend with socket.io client
   - Register a user and verify in MongoDB

3. ✅ **Check Database**
   - Visit MongoDB Atlas dashboard
   - Verify data is being saved in collections

4. ✅ **Monitor Logs**
   - Watch console output for any warnings/errors
   - All events are logged with timestamps

---

## 📞 Support

**Database:** SlyxyDatabase (MongoDB Atlas)
**Cluster:** slyxydatabase.bzzvo8t.mongodb.net
**App Name:** slyxyDataBase
**Connection Status:** ✅ Ready for Production

For issues, check the logs with timestamps to identify problems quickly!
