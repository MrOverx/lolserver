# 🎯 Frontend Integration Example

## Socket.IO Connection Setup

### 1. Basic Connection (Flutter/Dart)
```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

class WebSocketService {
  late IO.Socket socket;
  
  void connectToServer() {
    // Connect to your backend server
    socket = IO.io('http://YOUR_BACKEND_IP:8080', 
      IO.OptionBuilder()
        .setTransports(['websocket', 'polling'])
        .enableForceNew()
        .build()
    );

    socket.onConnect((_) {
      print('✅ Connected to server');
      
      // Register user after connection
      socket.emit('register_user', {
        'userId': 'user123',
        'userName': 'John Doe',
        'gender': 'male',
        'country': 'USA',
        'avatarColor': '#128C7E',
      }, (response) {
        print('Registration response: $response');
      });
    });

    socket.onDisconnect((_) {
      print('❌ Disconnected from server');
    });

    socket.onError((error) {
      print('Socket error: $error');
    });
  }

  void findVideoPartner() {
    socket.emit('find_partner', {
      'roomType': 'video',
      'genderPreference': 'all',
    }, (response) {
      if (response['success']) {
        print('Partner found: ${response['partnerId']}');
      }
    });
  }

  void findChatPartner() {
    socket.emit('find_partner', {
      'roomType': 'chat',
      'genderPreference': 'all',
    }, (response) {
      if (response['success']) {
        print('Chat partner found');
      }
    });
  }

  void reportUser(String reportedUserId, String reason) {
    socket.emit('report_user', {
      'reportedUserId': reportedUserId,
      'reason': reason,
    }, (response) {
      print('Report submitted: ${response['message']}');
    });
  }

  void sendMessage(String message) {
    socket.emit('message', {
      'text': message,
      'timestamp': DateTime.now().toIso8601String(),
    });
  }

  void disconnect() {
    socket.disconnect();
  }
}
```

### 2. User Registration & Login

```dart
// Register new user
Future<void> registerUser({
  required String userId,
  required String userName,
  required String email,
  required String password,
  String gender = 'other',
  String country = '',
  String avatarColor = '#128C7E',
}) async {
  final response = await http.post(
    Uri.parse('http://YOUR_BACKEND_IP:8080/auth/register'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({
      'userId': userId,
      'userName': userName,
      'email': email,
      'password': password,
      'gender': gender,
      'country': country,
      'avatarColor': avatarColor,
    }),
  );

  if (response.statusCode == 200) {
    final data = jsonDecode(response.body);
    print('✅ User registered: ${data['user']['userId']}');
  } else {
    print('❌ Registration failed: ${response.body}');
  }
}

// Login user
Future<void> loginUser({
  required String userId,
  required String email,
  required String password,
}) async {
  final response = await http.post(
    Uri.parse('http://YOUR_BACKEND_IP:8080/auth/login'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({
      'userId': userId,
      'email': email,
      'password': password,
    }),
  );

  if (response.statusCode == 200) {
    final data = jsonDecode(response.body);
    print('✅ Login successful');
    print('User profile: ${data['user']}');
  } else {
    print('❌ Login failed: ${response.body}');
  }
}

// Google OAuth token validation
Future<void> validateGoogleToken({
  required String idToken,
  required Map<String, dynamic> googleUserData,
}) async {
  final response = await http.post(
    Uri.parse('http://YOUR_BACKEND_IP:8080/auth/validate-token'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({
      'idToken': idToken,
      'googleUserData': googleUserData,
    }),
  );

  if (response.statusCode == 200) {
    final data = jsonDecode(response.body);
    print('✅ Token valid: ${data['user']['email']}');
  } else {
    print('❌ Token invalid: ${response.body}');
  }
}
```

### 3. Room Management

```dart
// Create a room
void createRoom({
  required String roomName,
  String roomType = 'public',
  String description = '',
}) {
  socket.emit('create_room', {
    'roomName': roomName,
    'roomType': roomType,
    'description': description,
  }, (response) {
    if (response['success']) {
      print('✅ Room created: ${response['room']['roomId']}');
      print('Invite code: ${response['room']['inviteCode']}');
      print('Invite link: ${response['room']['inviteLink']}');
    } else {
      print('❌ Failed to create room: ${response['error']}');
    }
  });
}

// Join a room
void joinRoom({
  required String inviteCode,
}) {
  socket.emit('join_room', {
    'inviteCode': inviteCode,
  }, (response) {
    if (response['success']) {
      print('✅ Joined room: ${response['room']['roomId']}');
      print('Members: ${response['room']['memberIds']}');
    } else {
      print('❌ Failed to join: ${response['error']}');
    }
  });
}

// List public rooms
void listPublicRooms() {
  socket.emit('list_public_rooms', {}, (response) {
    if (response['success']) {
      List<dynamic> rooms = response['rooms'];
      print('✅ Found ${rooms.length} public rooms');
      for (var room in rooms) {
        print('  - ${room['roomName']} (${room['memberIds'].length}/${room['maxMembers']})');
      }
    }
  });
}
```

### 4. Video & Chat Events

```dart
// Listen for WebRTC offer
socket.on('offer', (data) {
  String peerId = data['peerId'];
  Map<String, dynamic> offer = data['offer'];
  
  print('📹 Received offer from $peerId');
  
  // Handle offer with your WebRTC implementation
  handleWebRTCOffer(offer);
});

// Listen for WebRTC answer
socket.on('answer', (data) {
  String peerId = data['peerId'];
  Map<String, dynamic> answer = data['answer'];
  
  print('📹 Received answer from $peerId');
  
  // Handle answer with your WebRTC implementation
  handleWebRTCAnswer(answer);
});

// Listen for ICE candidates
socket.on('IceCandidate', (data) {
  String peerId = data['peerId'];
  Map<String, dynamic> candidate = data['candidate'];
  
  print('🧊 Received ICE candidate from $peerId');
  
  // Add candidate to your peer connection
  addICECandidate(candidate);
});

// Listen for incoming messages
socket.on('message', (data) {
  String senderId = data['senderId'];
  String message = data['message'];
  String timestamp = data['timestamp'];
  
  print('💬 Message from $senderId: $message');
  
  // Display message in UI
  displayMessage(senderId, message, timestamp);
});

// Send WebRTC offer
void sendOffer(String peerId, Map<String, dynamic> offer) {
  socket.emit('offer', {
    'peerId': peerId,
    'offer': offer,
  });
}

// Send WebRTC answer
void sendAnswer(String peerId, Map<String, dynamic> answer) {
  socket.emit('answer', {
    'peerId': peerId,
    'answer': answer,
  });
}

// Send ICE candidate
void sendICECandidate(String peerId, Map<String, dynamic> candidate) {
  socket.emit('IceCandidate', {
    'peerId': peerId,
    'candidate': candidate,
  });
}
```

### 5. Star System

```dart
// Send a star to another user
void giftStar({
  required String recipientId,
  String recipientType = 'peer', // peer | room
}) {
  socket.emit('gift_star', {
    'recipientId': recipientId,
    'recipientType': recipientType,
  }, (response) {
    if (response['success']) {
      print('⭐ Star gifted! Total stars: ${response['totalStars']}');
    } else {
      print('❌ Failed to gift star: ${response['error']}');
    }
  });
}

// Listen for star gifts
socket.on('star_gifted', (data) {
  String gifterId = data['gifterId'];
  int totalStars = data['totalStars'];
  
  print('⭐ Received star from $gifterId! Total: $totalStars');
  
  // Trigger animation/notification
  showStarAnimation();
});
```

### 6. User Status Updates

```dart
// Update user status (camera/mic on/off)
void updateUserStatus({
  required bool cameraOn,
  required bool microphoneOn,
}) {
  socket.emit('update_user_status', {
    'cameraOn': cameraOn,
    'microphoneOn': microphoneOn,
  }, (response) {
    print('✅ Status updated');
  });
}

// Listen for peer status updates
socket.on('peer_status_updated', (data) {
  String peerId = data['peerId'];
  bool cameraOn = data['cameraOn'];
  bool microphoneOn = data['microphoneOn'];
  
  print('📹 Peer status - Camera: $cameraOn, Mic: $microphoneOn');
  
  // Update UI accordingly
  updatePeerStatusUI(peerId, cameraOn, microphoneOn);
});
```

## 🚀 Complete Initialization Example

```dart
class AppService {
  late WebSocketService socketService;
  
  Future<void> initialize() async {
    // 1. Connect to server
    socketService = WebSocketService();
    socketService.connectToServer();
    
    // 2. Get/load user credentials from local storage
    String? userId = await getStoredUserId();
    String? email = await getStoredEmail();
    
    if (userId == null) {
      // First time - show registration
      await showRegistrationScreen();
    } else {
      // Returning user - auto-login
      await loginUser(
        userId: userId,
        email: email!,
        password: await getStoredPassword(),
      );
    }
    
    // 3. Set up event listeners
    setupEventListeners();
    
    // 4. Ready for use
    print('✅ App fully initialized');
  }
  
  void setupEventListeners() {
    socketService.socket.on('connect_error', (error) {
      print('Connection error: $error');
      showErrorDialog('Connection failed. Retrying...');
    });
    
    socketService.socket.on('disconnect', (_) {
      print('Disconnected');
      showWarningDialog('Lost connection to server');
    });
  }
}
```

---

## 📊 Server Responses Reference

### Successful Response Format
```json
{
  "success": true,
  "message": "Operation completed",
  "data": {}
}
```

### Error Response Format
```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human readable error message"
}
```

### Common Error Codes
- `USER_NOT_FOUND` - User registration needed
- `UNAUTHORIZED` - Invalid credentials
- `USER_BLOCKED` - User is temporarily blocked
- `ROOM_FULL` - Room capacity reached
- `INVALID_INVITE_CODE` - Invitation code doesn't exist
- `RATE_LIMIT_EXCEEDED` - Too many requests
- `INTERNAL_ERROR` - Server error

---

**Server URL:** `http://YOUR_BACKEND_IP:8080`
**WebSocket URL:** `ws://YOUR_BACKEND_IP:8080`
**Database:** MongoDB Atlas (SlyxyDatabase)
