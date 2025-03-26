import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// 翻译资源
const resources = {
  en: {
    translation: {
      // 通用
      "chatRooms": "Chat Rooms",
      "room": "Room",
      "rooms": "Rooms",
      "save": "Save Room",
      "unsave": "Unsave",
      "share": "Share",
      "leave": "Leave Room",
      "create": "Create Room",
      "cancel": "Cancel",
      "close": "Close",
      "copied": "Copied!",
      "shareSuccess": "Room link copied to clipboard!",
      "send": "Send",
      "yourUserId": "Your User ID",
      
      // 房间列表
      "yourRooms": "Your Rooms",
      "savedRooms": "Saved Rooms",
      "noRoomsAvailable": "No Rooms Available",
      "noRoomsDescription": "You haven't created any rooms yet. Create your first room to get started.",
      "noSavedRooms": "No Saved Rooms",
      "noSavedRoomsDescription": "You haven't saved any rooms yet. Join a room and click \"Save Room\" to access it quickly later.",
      "quickAccess": "Quickly access rooms you've saved",
      "welcomeMessage": "Welcome to RoomTalk",
      "welcomeDescription": "Select a room to join or create a new one to get started.",
      
      // 房间详情
      "roomName": "Room Name",
      "roomID": "Room ID",
      "status": "Status",
      "created": "Created",
      "description": "Description",
      "optional": "Optional",
      "enterRoomName": "Enter room name",
      "describeRoom": "Describe this room",
      "createdBy": "Your Room",
      "joined": "Joined (not owned)",
      
      // 创建房间
      "createNewRoom": "Create New Room",
      
      // 加载和错误
      "loading": "Loading room...",
      "loadingDescription": "Please wait while we load the requested room.",
      "errorRoomNotFound": "Could not find room with ID: {{roomId}}. It may have been deleted or does not exist.",
      "errorLoading": "Error loading room. Please try again later.",
      "pleaseSelectRoom": "Please select a room first",
      "confirmJoinTitle": "Join Room?",
      "confirmJoinDescription": "Would you like to join the room \"{{roomName}}\"?",
      "join": "Join",
      
      // 删除确认
      "confirmDelete": "Confirm Delete",
      "confirmDeleteDescription": "Are you sure you want to remove this room from your saved list? This won't delete the room itself, just remove it from your saved list.",
      "delete": "Delete",

      // 消息列表
      "noMessages": "No messages in this room yet",
      "beFirstToMessage": "Be the first to start the conversation",
      "newMessages": "New messages",
      "typeMessage": "Type your message..."
    }
  },
  zh: {
    translation: {
      // 通用
      "chatRooms": "聊天房间",
      "room": "房间",
      "rooms": "房间",
      "save": "保存房间",
      "unsave": "取消保存",
      "share": "分享",
      "leave": "退出房间",
      "create": "创建房间",
      "cancel": "取消",
      "close": "关闭",
      "copied": "已复制!",
      "shareSuccess": "房间链接已复制到剪贴板！",
      "send": "发送",
      "yourUserId": "你的用户ID",
      
      // 房间列表
      "yourRooms": "你的房间",
      "savedRooms": "已保存的房间",
      "noRoomsAvailable": "没有可用的房间",
      "noRoomsDescription": "你还没有创建任何房间。创建你的第一个房间开始使用。",
      "noSavedRooms": "没有已保存的房间",
      "noSavedRoomsDescription": "你还没有保存任何房间。加入一个房间并点击\"保存房间\"以便以后快速访问。",
      "quickAccess": "快速访问你保存的房间",
      "welcomeMessage": "欢迎使用 RoomTalk",
      "welcomeDescription": "选择一个房间加入或创建一个新的房间开始使用。",
      
      // 房间详情
      "roomName": "房间名称",
      "roomID": "房间ID",
      "status": "状态",
      "created": "创建时间",
      "description": "描述",
      "optional": "可选",
      "enterRoomName": "输入房间名称",
      "describeRoom": "描述这个房间",
      "createdBy": "你创建的",
      "joined": "已加入 (非创建者)",
      
      // 创建房间
      "createNewRoom": "创建新房间",
      
      // 加载和错误
      "loading": "正在加载房间...",
      "loadingDescription": "请稍候，我们正在加载请求的房间。",
      "errorRoomNotFound": "无法找到ID为 {{roomId}} 的房间。可能该房间已被删除或不存在。",
      "errorLoading": "加载房间时出错，请稍后再试。",
      "pleaseSelectRoom": "请先选择一个房间",
      "confirmJoinTitle": "加入房间？",
      "confirmJoinDescription": "您想加入房间 \"{{roomName}}\" 吗？",
      "join": "加入",
      
      // 删除确认
      "confirmDelete": "确认删除",
      "confirmDeleteDescription": "您确定要从保存的房间中删除此房间吗？这不会删除房间本身，只会从您的保存列表中移除。",
      "delete": "删除",

      // 消息列表
      "noMessages": "房间里还没有消息",
      "beFirstToMessage": "来发送第一条消息吧",
      "newMessages": "新消息",
      "typeMessage": "输入消息..."
    }
  }
};

// 初始化i18n
i18n
  .use(LanguageDetector) // 自动检测用户语言
  .use(initReactI18next) // 传递i18n到react-i18next
  .init({
    resources,
    fallbackLng: 'en', // 如果检测失败，使用英语
    interpolation: {
      escapeValue: false // 不转义HTML
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage']
    }
  });

export default i18n; 