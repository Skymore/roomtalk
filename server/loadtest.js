import http from 'k6/http';
import { check, sleep, group } from 'k6';
import ws from 'k6/ws';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

export let options = {
  stages: [
    { duration: '5m', target: 10000 }, // 在5分钟内增加到10000个用户
    { duration: '10m', target: 10000 }, // 在10分钟内保持10000个用户
    { duration: '5m', target: 0 },  // 在5分钟内减少到0个用户
  ],
};

export default function () {
  const clientId = randomString(8); // 生成8位随机字符串作为客户端ID

  group('HTTP API Test', function () {
    // 获取客户端创建的房间列表
    let roomsRes = http.get(`http://localhost:3012/api/clients/:clientId/rooms`, {
      tags: { name: 'get_client_rooms' }
    });
    check(roomsRes, {
      'rooms status is 200': (r) => r.status === 200,
      'rooms response time is less than 200ms': (r) => r.timings.duration < 200,
    });

    // 创建新房间
    let createRoomRes = http.post(`http://localhost:3012/api/clients/:clientId/rooms`, {
      name: 'Test Room',
      description: 'This is a test room',
    }, {
      tags: { name: 'create_room' }
    });
    check(createRoomRes, {
      'create room status is 201': (r) => r.status === 201,
      'create room response time is less than 300ms': (r) => r.timings.duration < 300,
    });

    const roomId = createRoomRes.json('id');

    // 获取房间消息历史
    let messagesRes = http.get(`http://localhost:3012/api/rooms/:roomId/messages`, {
      tags: { name: 'get_room_messages' }
    });
    check(messagesRes, {
      'messages status is 200': (r) => r.status === 200,
      'messages response time is less than 200ms': (r) => r.timings.duration < 200,
    });

    // 发送消息到房间
    let sendMessageRes = http.post(`http://localhost:3012/api/rooms/:roomId/messages`, {
      clientId: clientId,
      content: 'Hello, this is a test message',
      messageType: 'text',
    }, {
      tags: { name: 'send_message' }
    });
    check(sendMessageRes, {
      'send message status is 201': (r) => r.status === 201,
      'send message response time is less than 200ms': (r) => r.timings.duration < 200,
    });

    sleep(1);
  });

  group('WebSocket Test', function () {
    const url = 'ws://localhost:3012/ws';
    const params = { tags: { my_tag: 'hello' } };

    const response = ws.connect(url, params, function (socket) {
      socket.on('open', function () {
        console.log('Connected');
        // 注册客户端
        socket.send(JSON.stringify({ event: 'register', clientId: clientId }));
      });

      socket.on('message', function (message) {
        console.log(`Received message: ${message}`);
        const msg = JSON.parse(message);
        if (msg.event === 'room_list') {
          // 创建房间
          socket.send(JSON.stringify({ event: 'create_room', roomData: { name: 'Test Room' } }));
        } else if (msg.event === 'new_room') {
          // 加入新创建的房间
          socket.send(JSON.stringify({ event: 'join_room', roomId: msg.room.id }));
        } else if (msg.event === 'room_member_change') {
          // 处理房间成员变化事件
          console.log(`Room member change: ${msg.action}, count: ${msg.count}`);
        } else if (msg.event === 'message_history') {
          // 处理消息历史事件
          console.log(`Message history received: ${msg.messages.length} messages`);
        } else if (msg.event === 'new_message') {
          // 处理新消息事件
          console.log(`New message: ${msg.content}`);
        } else if (msg.event === 'room_member_count') {
          // 处理房间成员数事件
          console.log(`Room member count: ${msg.count}`);
        }
      });

      // 发送消息到房间
      socket.on('join_room', function (roomId) {
        console.log(`Joined room: ${roomId}`);
        // 发送消息到房间
        socket.send(JSON.stringify({ event: 'send_message', messageData: { roomId: roomId, content: 'Hello, this is a test message' } }));
      });

      // 离开房间
      socket.on('leave_room', function (roomId) {
        console.log(`Left room: ${roomId}`);
        socket.send(JSON.stringify({ event: 'leave_room', roomId: roomId }));
      });

      socket.on('close', function () {
        console.log('Disconnected');
      });

      socket.on('error', function (e) {
        if (e.error() !== 'websocket: close sent') {
          console.log('An unexpected error occurred: ', e.error());
        }
      });

      sleep(1);
    });

    check(response, { 'status is 101': (r) => r && r.status === 101 });
  });

  sleep(1);
}