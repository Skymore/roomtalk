# RoomTalk

[中文版](./README.zh.md)

A lightweight WebSocket-based real-time messaging system with Redis storage. Useful as a foundation for chat apps, internal tools, or collaborative platforms.

---

## 🚀 Tech Stack

### Client

- React + TypeScript
- Tailwind CSS
- React Router
- Socket.io Client
- i18next (Internationalization)

### Server

- Node.js + Express
- Socket.io
- Redis (as storage engine)
- UUID-based identity

---

## 🌟 Features

- ✅ Real-time message sending/receiving
- ✅ Join or create rooms
- ✅ Local saved rooms
- ✅ Persistent room/message storage via Redis
- ✅ Dark/light mode toggle
- ✅ Responsive UI
- ✅ Multi-language (English & Chinese)

---

## 🧪 Quick Start

### Requirements

- Node.js installed
- Redis installed and running locally (default on `localhost:6379`)

### Install Dependencies

```bash
# Server
cd server
npm install

# Client
cd ../client
npm install
```

### Start the System

Use the provided script:

```bash
./start.sh
```

Or start manually:

```bash
cd server
npm start

cd ../client
npm run dev
```

---

## 🧭 Usage

1. Visit [http://localhost:3011](http://localhost:3011)
2. A unique `clientId` will be assigned and saved in `localStorage`
3. Create or join a room and chat in real time

---

## 🔌 API Overview

### HTTP Endpoints

| Path                                        | Method | Description                                                       |
|---------------------------------------------|--------|-------------------------------------------------------------------|
| `/api/rooms/:roomId/messages`               | `GET`  | Get messages for the specified room                               |
| `/api/clients/:clientId/rooms`              | `GET`  | Get rooms created by the specified client                         |
| `/api/clients/:clientId/rooms`              | `POST` | Create a new room for the specified client                        |
| `/api/clients/:clientId/rooms/:roomId`        | `GET`  | Get specific room details (only if owned by the client)             |
| `/api/rooms/:roomId/messages`               | `POST` | Send a message to the specified room                              |

### WebSocket Events

| Event             | Direction       | Description                                               |
|-------------------|-----------------|-----------------------------------------------------------|
| `register`        | Client → Server | Register user with clientId                               |
| `get_rooms`       | Client → Server | Request rooms created by the user                         |
| `create_room`     | Client → Server | Create a new room                                         |
| `join_room`       | Client → Server | Join an existing room                                     |
| `leave_room`      | Client → Server | Leave a room                                              |
| `send_message`    | Client → Server | Send a message to a room                                  |
| `get_room_by_id`  | Client → Server | Request room details via room ID                          |
| `message_history` | Server → Client | Deliver room message history                              |
| `new_room`        | Server → Client | Notify user of a new room created (scoped to client)      |
| `new_message`     | Server → Client | Broadcast new message to room participants                |

---

## ⚙️ Configuration

### Server `.env`

| Variable    | Default                   | Description   |
|-------------|---------------------------|---------------|
| `PORT`      | 3012                      | Server port   |
| `CLIENT_URL`| http://localhost:3011     | CORS origin   |

### Client `.env`

**.env.development:**

| Variable         | Default              | Description                  |
|------------------|----------------------|------------------------------|
| `VITE_SOCKET_URL`| http://localhost:3012| WebSocket base URL           |

**.env.production:**

| Variable         | Default | Description                                        |
|------------------|---------|----------------------------------------------------|
| `VITE_SOCKET_URL`| `/`     | Use relative path for same-origin deployment       |

---

## 📦 Redis Persistence

The system uses **RDB snapshot** persistence by default. You may enable **AOF** or adjust save policies via `redis.conf`.

---

## 📄 License

MIT License

Copyright (c) 2024 RoomTalk

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
