# MongoDB Integration Setup

## Backend Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure MongoDB

#### Option A: Local MongoDB
```bash
# Install MongoDB Community Edition
# MacOS: brew install mongodb-community
# Linux: Follow MongoDB docs
# Windows: Download installer from mongodb.com

# Start MongoDB
mongod
```

#### Option B: MongoDB Atlas (Cloud)
1. Go to https://www.mongodb.com/cloud/atlas
2. Create a free account
3. Create a new cluster
4. Get your connection string
5. Add it to `.env` file

### 3. Create .env File
```bash
cp .env.example .env
```

Edit `.env` with your MongoDB URI:
```
MONGODB_URI=mongodb://localhost:27017/omeglelol
```

### 4. Start the Server
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

---

## Database Schema

### Users Collection
```
{
  userId: string (unique),
  userName: string,
  email: string (unique),
  authType: 'GOOGLE_OAUTH' | 'LOCAL' | 'GUEST',
  isGuest: boolean,
  gender: 'male' | 'female' | 'other',
  country: string,
  birthDate: Date,
  avatarColor: string (hex),
  avatarLetter: string,
  profileImageUrl: string (URL only),
  useColorProfile: boolean,
  pictureName: string,
  likeCount: number,
  likedUserIds: [string],
  starCount: number,
  isActive: boolean,
  createdAt: Date,
  updatedAt: Date,
  lastLogin: Date
}
```

### BlockedUsers Collection
```
{
  userId: string,
  blockedByUserId: string,
  reason: string,
  blockType: 'report' | 'manual',
  blockDuration: number (ms),
  blockedUntil: Date,
  reportCount: number,
  reporters: [string],
  createdAt: Date
}
```

### Reports Collection
```
{
  reportedUserId: string (indexed),
  reporterId: string,
  reason: string,
  createdAt: Date (auto-expires after 24 hours)
}
```

---

## API Endpoints

### Authentication
- **POST /auth/validate-token**
  - Validate Google OAuth token and save user
  - Body: `{ idToken, googleUserData }`

- **POST /auth/register**
  - Register new local user
  - Body: `{ userId, userName, email, password, gender, country }`

- **POST /auth/login**
  - Login existing user
  - Body: `{ userId or email, password }`

### User Profile
- **GET /user/:userId**
  - Fetch user profile by ID

- **POST /user/:userId/update**
  - Update user profile
  - Body: `{ userName, gender, country, avatarColor, profileImageUrl, pictureName }`

### Health Check
- **GET /health**
  - Server status and queue info

### Room Lookup
- **GET /room/by-invite/:code**
  - Find room by invite code

---

## Frontend Integration

The Flutter frontend automatically:
1. Saves Google OAuth tokens to MongoDB via `/auth/validate-token`
2. Fetches user profile from DB when needed
3. Updates profile changes to both local storage and MongoDB
4. Checks blocking status before joining chat/video

No additional frontend configuration needed - just use the updated `AuthService` class.

---

## Blocking System

### Progressive Blocking Rules
- **1 report** → 10 minute block
- **3 reports** → 3 hour block
- **5 reports** → 24 hour block

### Auto-expiry
Blocks automatically expire after duration. Reports older than 24 hours are automatically deleted.

---

## Environment Variables

```env
# MongoDB Connection (required)
MONGODB_URI=mongodb://localhost:27017/omeglelol

# Server Config
PORT=8080 (default)
SERVER_IP=127.0.0.1 (visible IP)
SERVER_BIND=0.0.0.0 (bind all interfaces)

# Optional: TURN Server for WebRTC
TURN_URL=turn:turn-server.com:3478
TURN_USERNAME=username
TURN_CREDENTIAL=password
```

---

## Troubleshooting

### MongoDB Connection Error
- Ensure MongoDB is running: `mongod` (local) or check Atlas connection
- Check connection string in `.env`
- Verify network access if using Atlas

### User Not Saved to DB
- Check that `/auth/validate-token` is being called
- Verify MongoDB is accessible
- Check server logs for errors

### Blocking Not Working
- Ensure user is reported from same browser/device
- Check that blocking times haven't expired yet
- Reports auto-delete after 24 hours

---

## API Usage Example (cURL)

```bash
# Validate Google token and save user
curl -X POST http://localhost:8080/auth/validate-token \
  -H "Content-Type: application/json" \
  -d '{
    "idToken": "google_token_here",
    "googleUserData": {
      "displayName": "John Doe",
      "email": "john@example.com",
      "photoUrl": "https://..."
    }
  }'

# Fetch user profile  
curl http://localhost:8080/user/google-user-id

# Update user profile
curl -X POST http://localhost:8080/user/google-user-id/update \
  -H "Content-Type: application/json" \
  -d '{
    "gender": "male",
    "country": "USA",
    "avatarColor": "#FF6B35"
  }'
```

---

## Support

For issues with:
- **MongoDB**: Check MongoDB documentation
- **Socket.IO**: See Socket.IO docs
- **Frontend**: Update AuthService in Flutter app
