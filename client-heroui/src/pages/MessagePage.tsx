import React, { useState, useEffect, useRef } from "react";
import {
  Button,
  Tabs,
  Tab,
  Tooltip,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTheme } from "@heroui/use-theme";
import { MessageList } from "../components/MessageList";
import { MessageInput } from "../components/MessageInput";
import { RoomList } from "../components/RoomList";
import { SavedRoomList } from "../components/SavedRoomList";
import {
  socket,
  joinRoom,
  leaveRoom,
  getRoomById,
  clientId,
  getRoomMemberCount,
  onRoomMemberChange,
  reconnectSocket,
} from "../utils/socket";
import { Room, RoomMemberEvent } from "../utils/types";
import { saveRoom, removeRoom, isRoomSaved, getSavedRooms } from "../utils/storage";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppHeader } from "../components/AppHeader";
import { SettingsView } from "../components/SettingsView";
import { ChatHeader } from "../components/ChatHeader";
import { RoomJoinModal } from "../components/RoomJoinModal";
import { BottomNav } from "../components/BottomNav";
import { StatusMessage } from "../components/StatusMessage";

// 修改随机名字库 - 为印地语添加新的形容词和名词
const CN_ADJECTIVES = ["可爱", "萌萌", "温柔", "活泼", "聪明", "快乐", "甜蜜", "淘气", "软软", "闪亮", "乖巧", "迷你"];
const CN_NOUNS = [
  "小猫",
  "小熊",
  "小兔",
  "小鹿",
  "小狐",
  "小鸭",
  "小狗",
  "小象",
  "小猪",
  "小鸟",
  "花朵",
  "星星",
  "气球",
];

const EN_ADJECTIVES = ["Fluffy", "Tiny", "Sweet", "Bubbly", "Cuddly", "Sparkly", "Happy", "Cozy", "Rosy", "Playful"];
const EN_NOUNS = [
  "Bunny",
  "Kitten",
  "Puppy",
  "Panda",
  "Cookie",
  "Muffin",
  "Star",
  "Fox",
  "Duckling",
  "Unicorn",
  "Whale",
];

// Hindi adjectives and nouns for random name generation
const HI_ADJECTIVES = ["प्यारा", "छोटा", "मीठा", "चंचल", "सुंदर", "उज्ज्वल", "खुश", "आरामदायक", "रंगीन", "खेलपूर्ण"];
const HI_NOUNS = [
  "खरगोश",
  "बिल्ली",
  "कुत्ता",
  "पांडा",
  "कुकी",
  "तारा",
  "लोमड़ी",
  "बतख",
  "हाथी",
  "तितली",
  "फूल",
];

// 生成随机名字 - 根据i18n语言设置决定生成中文、英文或印地语名字
const generateRandomName = (language: string): string => {
  // 如果语言设置为中文，或者开头为zh（如zh-CN），则生成中文名字
  if (language === "zh" || language.startsWith("zh-")) {
    const adj = CN_ADJECTIVES[Math.floor(Math.random() * CN_ADJECTIVES.length)];
    const noun = CN_NOUNS[Math.floor(Math.random() * CN_NOUNS.length)];
    return adj + noun;
  } else if (language === "hi") {
    // 生成印地语名字
    const adj = HI_ADJECTIVES[Math.floor(Math.random() * HI_ADJECTIVES.length)];
    const noun = HI_NOUNS[Math.floor(Math.random() * HI_NOUNS.length)];
    return adj + " " + noun;
  } else {
    // 否则生成英文名字
    const adj = EN_ADJECTIVES[Math.floor(Math.random() * EN_ADJECTIVES.length)];
    const noun = EN_NOUNS[Math.floor(Math.random() * EN_NOUNS.length)];
    return adj + noun;
  }
};

// 从名字获取显示字符（首字母或首汉字）
export const getAvatarText = (name: string): string => {
  if (!name) return "?";
  // 检查是否是汉字（Unicode范围）
  const firstChar = name.charAt(0);
  if (/[\u4e00-\u9fa5]/.test(firstChar)) {
    return firstChar;
  }
  // 英文则返回大写首字母
  return firstChar.toUpperCase();
};

// 从用户名生成固定颜色
export const getAvatarColor = (name: string): string => {
  if (!name) return "primary";
  // 简单哈希算法，根据名字生成固定颜色
  const colors = ["primary", "secondary", "success", "warning", "danger"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
};

// 保存用户名到本地存储
const saveUsername = (name: string) => {
  localStorage.setItem("roomtalk_username", name);
  return name;
};

// 从本地存储获取用户名
const getStoredUsername = (): string => {
  return localStorage.getItem("roomtalk_username") || "";
};

// 保存当前视图状态到本地存储
const saveCurrentView = (view: string) => {
  localStorage.setItem("roomtalk_current_view", view);
};

// 从本地存储获取视图状态
const getStoredView = (): string => {
  return localStorage.getItem("roomtalk_current_view") || "rooms";
};

// 保存当前房间信息到本地存储
const saveCurrentRoom = (room: Room | null) => {
  if (room) {
    console.log("saveCurrentRoom: save room to storage", room)
    localStorage.setItem("roomtalk_current_room", JSON.stringify(room));
  } else {
    localStorage.removeItem("roomtalk_current_room");
  }
};

// 从本地存储获取房间信息
const getStoredRoom = (): Room | null => {
  const roomJson = localStorage.getItem("roomtalk_current_room");
  console.log("Stored room JSON:", roomJson);
  if (roomJson) {
    try {
      return JSON.parse(roomJson) as Room;
    } catch (e) {
      console.error("Failed to parse stored room:", e);
      localStorage.removeItem("roomtalk_current_room");
    }
  }
  return null;
};

// Welcome component for empty state
interface WelcomeViewProps {
  onEnterRooms: () => void;
}

const WelcomeView = ({ onEnterRooms }: WelcomeViewProps) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full p-4 overflow-y-auto">
      <Icon icon="lucide:message-circle" className="w-16 h-16 mb-4 text-violet-500" />
      <h2 className="text-xl font-semibold mb-2">{t("welcomeMessage")}</h2>
      <p className="text-default-500 mb-6 text-center">{t("welcomeDescription")}</p>
      <Button 
        color="secondary" 
        onPress={onEnterRooms} 
        startContent={<Icon icon="lucide:users" />}
        className="bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white"
      >
        {t("home")}
      </Button>
    </div>
  );
};

export const MessagePage: React.FC = () => {
  // 不操作 html/body 滚动，页面固定高度由容器本身管理
  // 添加初始化标志，防止初始渲染时清除存储的房间
  const isInitialMount = useRef(true);
  // 用 CSS h-screen 来撑满视口，无需 JS 计算高度
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";

  // 状态简化：不再单独存储 roomId 和 joined 状态
  const [rooms, setRooms] = useState<Room[]>([]);
  const [savedRooms, setSavedRooms] = useState<Room[]>([]);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  // 初始化视图状态，默认从localStorage读取
  const [view, setView] = useState<"chat" | "rooms" | "saved" | "settings">(() => {
    const storedView = getStoredView();
    return (storedView as "chat" | "rooms" | "saved" | "settings") || "rooms";
  });
  const [error, setError] = useState<string | null>(null);
  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  // 当 URL 参数包含房间时，先保存待确认的房间信息
  const [roomToJoin, setRoomToJoin] = useState<{ id: string; name: string } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // 添加房间成员数量状态
  const [memberCount, setMemberCount] = useState<number>(0);
  // 添加最近加入/离开消息状态
  const [memberEvent, setMemberEvent] = useState<{ type: "join" | "leave"; userId: string } | null>(null);
  // 添加用户名状态
  const [username, setUsername] = useState<string>("");
  // 是否显示修改用户名弹窗
  const [showEditUsername, setShowEditUsername] = useState<boolean>(false);

  // 修改处：同时获取 setSearchParams 方法
  const [searchParams, setSearchParams] = useSearchParams();

  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  // 切换语言方法修改为支持多语言
  const changeLanguage = (language: string) => {
    i18n.changeLanguage(language);
    // 如果用户名是自动生成的，可以更新为新语言的随机名
    if (!getStoredUsername()) {
      const newName = generateRandomName(language);
      setUsername(newName);
      saveUsername(newName);
    }
  };

  // 修改处：使用 setSearchParams 更新 URL 参数
  const clearRoomUrlParam = () => {
    const newParams = new URLSearchParams(searchParams);
    newParams.delete("room");
    setSearchParams(newParams);
  };

  // 初次加载时加载已保存房间和用户名
  useEffect(() => {
    setSavedRooms(getSavedRooms());

    // 加载或生成用户名
    let storedName = getStoredUsername();
    if (!storedName) {
      // 使用当前i18n语言设置生成随机名字
      storedName = saveUsername(generateRandomName(i18n.language));
    }
    setUsername(storedName);
  }, [i18n.language]);

  // 用户名变更时通知socket服务
  useEffect(() => {
    if (username) {
      socket.emit("set_username", username);
    }
  }, [username]);

  // 视图变化时保存到localStorage
  useEffect(() => {
    if (view) {
      saveCurrentView(view);
    }
  }, [view]);

  // 当前房间变化时保存到localStorage
  useEffect(() => {
    // 跳过组件首次渲染时的保存操作，避免清除已存储的房间
    if (isInitialMount.current) {
      console.log("Initial mount - skip saving room to storage");
      isInitialMount.current = false;
      return;
    }
    
    console.log("Room changed - save current room state:", currentRoom ? currentRoom.id : "null");
    saveCurrentRoom(currentRoom);
  }, [currentRoom]);

  // 恢复保存的房间状态
  useEffect(() => {
    // 首先检查是否从URL加载房间
    console.log("Attempting to restore room from storage");
    const roomIdFromUrl = searchParams.get("room");
    
    if (roomIdFromUrl) {
      console.log("URL contains room ID, prioritize URL parameter:", roomIdFromUrl);
      // URL参数优先，这个逻辑不变
      return;
    }

    // 如果没有URL房间参数，且当前没有活跃房间，尝试从localStorage恢复
    if (!currentRoom && !isLoadingRoom) {
      const storedRoom = getStoredRoom();
      
      if (storedRoom) {
        setIsLoadingRoom(true);
        console.log("Found stored room, attempting to restore:", storedRoom.id);
        
        // 验证房间是否仍然存在
        getRoomById(storedRoom.id)
          .then((roomInfo) => {
            setIsLoadingRoom(false);
            if (roomInfo) {
              console.log("Successfully restored room:", roomInfo.name);
              joinRoom(storedRoom.id);
              setCurrentRoom(roomInfo);
              setMemberCount(getRoomMemberCount(storedRoom.id));
              
              // 根据保存的视图状态决定是否切换到chat视图
              const savedView = getStoredView();
              console.log("Restored room with saved view:", savedView);
              
              // 只有当保存的视图是chat时，才切换到chat视图
              if (savedView === "chat" && view !== "chat") {
                console.log("Switching to chat view based on saved view state");
                setView("chat");
              } else {
                console.log("Keeping current view:", view);
              }
            } else {
              console.log("Stored room no longer exists");
              // 房间不存在，清除存储
              saveCurrentRoom(null);
              setError(t("errorRoomNoLongerExists"));
            }
          })
          .catch((err) => {
            console.error("Error restoring room:", err);
            setIsLoadingRoom(false);
            saveCurrentRoom(null);
            setError(t("errorRestoringRoom"));
          });
      } else {
        console.log("No stored room found");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // 仅在组件挂载时执行一次

  // 当组件加载或 URL 参数变化时，如果 URL 包含 room 参数，则先加载房间信息并要求确认
  useEffect(() => {
    const roomIdFromUrl = searchParams.get("room");
    if (roomIdFromUrl && !currentRoom) {
      setIsLoadingRoom(true);
      getRoomById(roomIdFromUrl)
        .then((roomInfo) => {
          setIsLoadingRoom(false);
          if (roomInfo) {
            // 始终要求用户确认后进入房间
            setRoomToJoin({ id: roomIdFromUrl, name: roomInfo.name });
          } else {
            setError(t("errorRoomNotFound", { roomId: roomIdFromUrl }));
          }
        })
        .catch(() => {
          setIsLoadingRoom(false);
          setError(t("errorLoading"));
        });
    }
  }, [searchParams, currentRoom, t]);

  // 监听服务器返回的房间列表和新增房间
  useEffect(() => {
    socket.on("room_list", (roomList: Room[]) => setRooms(roomList));
    socket.emit("get_rooms");
    socket.on("new_room", (room: Room) => setRooms((prev) => [...prev, room]));

    // 取消注册回调的清理函数
    const unsubscribe = onRoomMemberChange((event: RoomMemberEvent) => {
      if (currentRoom && event.roomId === currentRoom.id) {
        setMemberCount(event.count);
        setMemberEvent({ type: event.action, userId: event.user.id });

        // 5秒后清除成员事件显示
        setTimeout(() => {
          setMemberEvent(null);
        }, 5000);
      }
    });

    return () => {
      socket.off("room_list");
      socket.off("new_room");
      unsubscribe();
    };
  }, [currentRoom]);

  // 添加页面可见性变化处理
  useEffect(() => {
    // 处理页面可见性变化
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log("Page is visible, checking connection status...");
        // 尝试重新连接socket
        reconnectSocket();

        // 如果在房间中，刷新消息
        if (currentRoom) {
          console.log("Refreshing messages for current room:", currentRoom.id);
          socket.emit("get_room_messages", currentRoom.id);
        }
      }
    };

    // 注册页面可见性变化事件
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentRoom]);

  // 直接加入房间：点击房间卡片或确认弹窗后调用
  const handleRoomSelect = async (roomId: string) => {
    // 如果已经在其他房间，则先离开
    if (currentRoom && currentRoom.id !== roomId) {
      leaveRoom(currentRoom.id);
    }
    const roomInfo = await getRoomById(roomId);
    if (!roomInfo) {
      setError(t("errorRoomNotFound", { roomId }));
      return;
    }
    joinRoom(roomId);
    setCurrentRoom(roomInfo);
    // 更新成员数量
    setMemberCount(getRoomMemberCount(roomId));
    // 进入房间时切换到聊天视图
    setView("chat");
    clearRoomUrlParam();
  };

  // URL 加载的房间确认操作
  const handleConfirmJoin = (confirmed: boolean) => {
    if (!confirmed || !roomToJoin) {
      setRoomToJoin(null);
      clearRoomUrlParam();
      return;
    }
    // 确保进入房间后切换到聊天视图，这样不会使用设置页(max-w-md)布局
    setView("chat");
    handleRoomSelect(roomToJoin.id);
    setRoomToJoin(null);
  };

  // 离开当前房间
  const handleLeaveRoom = () => {
    if (currentRoom) {
      leaveRoom(currentRoom.id);
      setCurrentRoom(null);
      // 修复BUG：离开房间时清除 URL 中的 room 参数，防止重复弹出加入房间确认弹窗
      clearRoomUrlParam();
      // 明确清除localStorage中的房间信息
      saveCurrentRoom(null);
    }
  };

  // 分享当前房间链接
  const handleShareRoom = () => {
    if (!currentRoom) return;
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set("room", currentRoom.id);
    navigator.clipboard
      .writeText(url.toString())
      .then(() => {
        setError(null);
        setSuccess(t("shareSuccess"));
        setTimeout(() => setSuccess(null), 2000);
      })
      .catch((err) => console.error("Could not copy URL:", err));
  };

  // 切换保存/取消保存房间
  const handleToggleSave = () => {
    if (!currentRoom) return;
    if (isRoomSaved(currentRoom.id)) {
      setSavedRooms(removeRoom(currentRoom.id));
    } else {
      setSavedRooms(saveRoom(currentRoom));
    }
  };

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setError(null);
        setSuccess(t("copySuccess"));
        setTimeout(() => setSuccess(null), 2000);
      })
      .catch((err) => console.error("Could not copy text:", err));
  };

  // 保存用户名
  const handleSaveUsername = () => {
    const trimmedName = username.trim();
    if (!trimmedName) {
      setError(t("errorEmptyUsername"));
      return;
    }
    saveUsername(trimmedName);
    setShowEditUsername(false);
    setSuccess(t("usernameUpdated"));
    setTimeout(() => setSuccess(null), 2000);
  };

  // Render content based on current view
  const renderContent = () => {
    if (isLoadingRoom) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-4">
          <Icon icon="lucide:loader" className="w-16 h-16 mb-4 text-violet-500 animate-spin" />
          <h2 className="text-xl font-semibold mb-2">{t("loading")}</h2>
          <p className="text-default-500 text-center">{t("loadingDescription")}</p>
        </div>
      );
    }

    switch (view) {
      case "rooms":
        return (
          <div className="h-full overflow-y-auto">
            <RoomList rooms={rooms} onRoomSelect={handleRoomSelect} />
          </div>
        );
      case "saved":
        return (
          <div className="h-full overflow-y-auto">
            <SavedRoomList rooms={savedRooms} onRoomSelect={handleRoomSelect} onRoomsChange={setSavedRooms} />
          </div>
        );
      case "settings":
        return (
          <SettingsView 
            username={username}
            setUsername={setUsername}
            showEditUsername={showEditUsername}
            setShowEditUsername={setShowEditUsername}
            handleSaveUsername={handleSaveUsername}
            handleCopyToClipboard={handleCopyToClipboard}
            isDark={isDark}
            setTheme={setTheme}
            i18n={i18n}
            changeLanguage={changeLanguage}
          />
        );
      case "chat":
        if (currentRoom) {
          return (
            <div className="flex flex-col flex-1 w-full min-h-0">
              <ChatHeader
                currentRoom={currentRoom}
                memberCount={memberCount}
                memberEvent={memberEvent}
                handleCopyToClipboard={handleCopyToClipboard}
                handleShareRoom={handleShareRoom}
                handleToggleSave={handleToggleSave}
                handleLeaveRoom={handleLeaveRoom}
                isRoomSaved={isRoomSaved}
                setView={setView}
                clearRoomUrlParam={clearRoomUrlParam}
              />

              <div className="flex-1 w-full overflow-y-auto">
                <MessageList roomId={currentRoom.id} />
              </div>

              <div className="border-t p-1 flex-shrink-0 border-violet-100 dark:border-gray-800">
                <MessageInput
                  roomId={currentRoom.id}
                  username={username}
                  avatarText={getAvatarText(username)}
                  avatarColor={getAvatarColor(username)}
                />
              </div>
            </div>
          );
        }
        return <WelcomeView onEnterRooms={() => setView("rooms")} />;
      default:
        return <WelcomeView onEnterRooms={() => setView("rooms")} />;
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden bg-white/60 dark:bg-gray-900/60 backdrop-blur-md">
      <AppHeader 
        clientId={clientId}
        username={username}
        setView={setView}
        view={view}
        currentRoom={currentRoom}
        i18n={i18n}
        changeLanguage={changeLanguage}
        toggleTheme={toggleTheme}
        isDark={isDark}
        handleCopyToClipboard={handleCopyToClipboard}
      />

      <StatusMessage error={error} setError={setError} success={success} />

      {/* Tab 切换 - 桌面版 */}
      <div className="bg-white/60 dark:bg-gray-900/60 backdrop-blur-sm border-b border-violet-200 dark:border-gray-800 hidden md:block">
        <div className="max-w-[1400px] mx-auto px-4">
          <Tabs
            selectedKey={view}
            onSelectionChange={(key) => setView(key as "chat" | "rooms" | "saved" | "settings")}
            className="p-2"
            variant="light"
            color="secondary"
            classNames={{
              tabList: "gap-2",
              tab: "data-[selected=true]:bg-gradient-to-r data-[selected=true]:from-violet-500 data-[selected=true]:to-fuchsia-500 data-[selected=true]:text-white",
              cursor: "",
            }}
          >
            <Tab
              key="rooms"
              aria-label={t("home")}
              title={
                <Tooltip content={t("home")}>
                  <div className="flex items-center gap-1">
                    <Icon icon="lucide:home" className="text-lg" />
                  </div>
                </Tooltip>
              }
            />
            <Tab
              key="saved"
              aria-label={t("savedRooms")}
              title={
                <Tooltip content={t("savedRooms")}>
                  <div className="flex items-center gap-1">
                    <Icon icon="lucide:bookmark" className="text-lg" />
                  </div>
                </Tooltip>
              }
            />
            <Tab
              key="settings"
              aria-label={t("settings")}
              title={
                <Tooltip content={t("settings")}>
                  <div className="flex items-center gap-1">
                    <Icon icon="lucide:settings" className="text-lg" />
                  </div>
                </Tooltip>
              }
            />
            {currentRoom && (
              <Tab
                key="chat"
                aria-label={currentRoom.name}
                title={
                  <Tooltip content={currentRoom.name}>
                    <div className="flex items-center gap-1">
                      <Icon icon="lucide:message-circle" className="text-lg" />
                    </div>
                  </Tooltip>
                }
              />
            )}
          </Tabs>
        </div>
      </div>

      {/* 主要内容区 */}
      <main className="flex flex-col flex-1 min-h-0 pb-12 md:pb-0">
        <div className="flex flex-1 min-h-0 w-full max-w-[1400px] mx-auto px-4">
          <div className="flex-1 flex flex-col min-h-0">
            {renderContent()}
          </div>
        </div>
      </main>

      {/* URL 加载房间时的确认弹窗 */}
      <RoomJoinModal 
        roomToJoin={roomToJoin}
        handleConfirmJoin={handleConfirmJoin}
      />

      {/* 底部导航 - 移动端 */}
      <BottomNav 
        view={view}
        setView={setView}
        currentRoom={currentRoom}
      />
    </div>
  );
};
