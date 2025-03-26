#!/bin/bash

# 这是一个用于启动消息系统服务端和客户端的脚本。
# 脚本会先启动服务端，再启动客户端，并在按下 Ctrl+C 时优雅地停止所有服务。

# 设置默认环境变量
export NODE_ENV=${NODE_ENV:-development}
export SERVER_PORT=${SERVER_PORT:-3012}
export CLIENT_PORT=${CLIENT_PORT:-3011}

echo "启动消息系统 - 环境: $NODE_ENV"
echo "服务端端口: $SERVER_PORT, 客户端端口: $CLIENT_PORT"

# 定义清理函数，在脚本退出时关闭所有后台进程
cleanup() {
    echo "正在停止所有服务..."
    if [ -n "$CLIENT_PID" ]; then
        kill $CLIENT_PID 2>/dev/null
        wait $CLIENT_PID 2>/dev/null
    fi
    if [ -n "$SERVER_PID" ]; then
        kill $SERVER_PID 2>/dev/null
        wait $SERVER_PID 2>/dev/null
    fi
    echo "所有服务已停止"
    exit 0
}

# 捕捉 Ctrl+C 和终止信号
trap cleanup SIGINT SIGTERM

# 启动服务端
echo "启动服务端..."
cd server || { echo "无法进入 server 目录"; exit 1; }
NODE_ENV=$NODE_ENV PORT=$SERVER_PORT npm start &
SERVER_PID=$!
echo "等待服务端启动..."
sleep 2
echo "服务端已启动 (PID: $SERVER_PID)"

# 切换到客户端目录
cd ../client-heroui || { echo "无法进入 client 目录"; exit 1; }

# 启动客户端开发服务器
echo "启动客户端开发服务器..."
npm run dev -- --port $CLIENT_PORT &
CLIENT_PID=$!
echo "客户端已启动 (PID: $CLIENT_PID)"
echo "前端访问地址: http://localhost:$CLIENT_PORT"
echo "后端API地址: http://localhost:$SERVER_PORT"

# 等待用户中断（Ctrl+C）
echo "按 Ctrl+C 停止所有服务..."
wait
