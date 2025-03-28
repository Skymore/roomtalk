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
      "yourUserId": "Click to copy your full User ID",
      "like": "Like",
      "dislike": "Dislike",
      "refresh": "Refresh",
      "edit": "Edit",
      "copy": "Copy",
      
      // 设置页面
      "settings": "Settings",
      "profile": "Profile",
      "username": "Username",
      "userId": "User ID",
      "editUsername": "Edit Username",
      "enterUsername": "Enter your username",
      "usernameUpdated": "Username updated successfully!",
      "errorEmptyUsername": "Username cannot be empty",
      "appearance": "Appearance",
      "language": "Language",
      "lightMode": "Light Mode",
      "darkMode": "Dark Mode",
      "clickToCopy": "Click to copy",
      "previewAvatar": "Your avatar preview",
      
      // 房间列表
      "yourRooms": "Owned",
      "savedRooms": "Saved",
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
      "errorRoomNoLongerExists": "The previously joined room no longer exists.",
      "errorRestoringRoom": "Failed to reconnect to the previously joined room.",
      
      // 删除确认
      "confirmDelete": "Confirm Delete",
      "confirmDeleteDescription": "Are you sure you want to remove this room from your saved list? This won't delete the room itself, just remove it from your saved list.",
      "delete": "Delete",

      // 消息列表
      "noMessages": "No messages in this room yet",
      "beFirstToMessage": "Be the first to start the conversation",
      "newMessages": "New messages",
      "typeMessage": "Type your message...",
      "clickToCopyRoomId": "Click to copy Room ID",
      "copySuccess": "Copied to clipboard!",
      
      // 图片消息
      "uploadImage": "Upload Image",
      "onlyImagesAllowed": "Only image files are allowed",
      "imageTooLarge": "Image too large (max 5MB)",
      "errorReadingImage": "Error reading image file",
      "replaceExistingImage": "Replace existing image?",
      "maxImagesReached": "Maximum {{max}} images allowed",
      "images": "images",
      
      // 房间成员
      "roomMembers": "Room Members",
      "members": "members",
      "userJoined": "User joined",
      "userLeft": "User left"
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
      "yourUserId": "点击复制您的完整用户ID",
      "like": "点赞",
      "dislike": "踩",
      "refresh": "刷新",
      "edit": "编辑",
      "copy": "复制",
      
      // 设置页面
      "settings": "设置",
      "profile": "个人资料",
      "username": "用户名",
      "userId": "用户ID",
      "editUsername": "编辑用户名",
      "enterUsername": "输入您的用户名",
      "usernameUpdated": "用户名更新成功！",
      "errorEmptyUsername": "用户名不能为空",
      "appearance": "外观",
      "language": "语言",
      "lightMode": "浅色模式",
      "darkMode": "深色模式",
      "clickToCopy": "点击复制",
      "previewAvatar": "头像预览",
      
      // 房间列表
      "yourRooms": "你创建的",
      "savedRooms": "已保存的",
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
      "errorRoomNoLongerExists": "之前加入的房间已不存在。",
      "errorRestoringRoom": "重新连接到之前的房间失败。",
      
      // 删除确认
      "confirmDelete": "确认删除",
      "confirmDeleteDescription": "您确定要从保存的房间中删除此房间吗？这不会删除房间本身，只会从您的保存列表中移除。",
      "delete": "删除",

      // 消息列表
      "noMessages": "房间里还没有消息",
      "beFirstToMessage": "来发送第一条消息吧",
      "newMessages": "新消息",
      "typeMessage": "输入消息...",
      "clickToCopyRoomId": "点击复制房间ID",
      "copySuccess": "已复制到剪贴板！",
      
      // 图片消息
      "uploadImage": "上传图片",
      "onlyImagesAllowed": "只允许上传图片文件",
      "imageTooLarge": "图片太大（最大5MB）",
      "errorReadingImage": "读取图片文件出错",
      "replaceExistingImage": "替换已有图片？",
      "maxImagesReached": "最多允许{{max}}张图片",
      "images": "张图片",
      
      // 房间成员
      "roomMembers": "房间成员",
      "members": "成员",
      "userJoined": "用户加入",
      "userLeft": "用户离开"
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