import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Button,
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
import {
  Room, RoomMemberEvent,
} from "../utils/types";
import { saveRoom, removeRoom, isRoomSaved, getSavedRooms } from "../utils/storage";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppHeader } from "../components/AppHeader";
import { SettingsView } from "../components/SettingsView";
import { ChatHeader } from "../components/ChatHeader";
import { RoomJoinModal } from "../components/RoomJoinModal";
import { BottomNav } from "../components/BottomNav";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

// Random display names follow the active app language.
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

const JA_ADJECTIVES = ["ふわふわ", "小さな", "やさしい", "元気な", "きらきら", "楽しい", "のんびり", "かわいい", "陽気な", "まるい"];
const JA_NOUNS = [
  "うさぎ",
  "こねこ",
  "こいぬ",
  "パンダ",
  "クッキー",
  "星",
  "きつね",
  "あひる",
  "花",
  "くじら",
  "蝶",
];

const KO_ADJECTIVES = ["포근한", "작은", "달콤한", "발랄한", "반짝이는", "즐거운", "느긋한", "귀여운", "상냥한", "동그란"];
const KO_NOUNS = [
  "토끼",
  "고양이",
  "강아지",
  "판다",
  "쿠키",
  "별",
  "여우",
  "오리",
  "꽃",
  "고래",
  "나비",
];

// 生成随机名字 - 根据i18n语言设置决定生成对应语言名字
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
  } else if (language === "ja" || language.startsWith("ja-")) {
    const adj = JA_ADJECTIVES[Math.floor(Math.random() * JA_ADJECTIVES.length)];
    const noun = JA_NOUNS[Math.floor(Math.random() * JA_NOUNS.length)];
    return adj + noun;
  } else if (language === "ko" || language.startsWith("ko-")) {
    const adj = KO_ADJECTIVES[Math.floor(Math.random() * KO_ADJECTIVES.length)];
    const noun = KO_NOUNS[Math.floor(Math.random() * KO_NOUNS.length)];
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
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto p-6 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e8e6dc] text-[#c96442] shadow-[0_0_0_1px_rgba(194,192,182,0.75)] dark:bg-[#30302e] dark:text-[#d97757]">
        <Icon icon="lucide:message-circle" className="h-8 w-8" />
      </div>
      <h2 className="mb-2 font-serif text-2xl font-medium leading-tight text-[#141413] dark:text-[#faf9f5]">{t("welcomeMessage")}</h2>
      <p className="mb-6 max-w-md text-sm leading-6 text-[#5e5d59] dark:text-[#b0aea5]">{t("welcomeDescription")}</p>
      <Button
        color="secondary"
        onPress={onEnterRooms}
        startContent={<Icon icon="lucide:users" />}
        className="bg-[#c96442] text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
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
  // 页面高度由 App shell 的 visual viewport 变量控制
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
  const [_error, setError] = useState<string | null>(null);
  const [_success, setSuccess] = useState<string | null>(null);

  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  // 当 URL 参数包含房间时，先保存待确认的房间信息
  const [roomToJoin, setRoomToJoin] = useState<{ id: string; name: string } | null>(null);
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

  // --- 添加清空聊天记录的处理函数 (Stays the same) ---
  const handleClearChatMessages = useCallback(() => {
    if (currentRoom) {
      console.log(`Emitting clear_room_messages for room ${currentRoom.id}`);
      socket.emit('clear_room_messages', currentRoom.id);
    } else {
      console.warn("Attempted to clear messages but no current room.");
    }
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

  // 新增：处理实际删除房间的函数 (与服务器交互)
  const handleDeleteRoom = useCallback((roomId: string) => {
    // Check if user is the creator before sending? Optional, server validates.
    console.log('Requesting PERMANENT delete room:', roomId);
    socket.emit('delete_room', roomId, (response: { success: boolean; message?: string }) => {
      if (response.success) {
        console.log('Server confirmed PERMANENT room deletion:', roomId);
        // No need to update savedRooms here, that's handled by unsave.
        // The room list (`rooms` state) will be updated automatically
        // when the server sends the new 'room_list' event.

        // If currently in the deleted room, navigate away
        if (currentRoom && currentRoom.id === roomId) {
          setCurrentRoom(null);
          setView('rooms');
          saveCurrentRoom(null);
          clearRoomUrlParam();
        }
        setSuccess(t('roomDeletedSuccess')); // Use a new key? e.g., roomDeletedPermanentlySuccess
        setTimeout(() => setSuccess(null), 3000);
      } else {
        console.error('Server failed to PERMANENTLY delete room:', response.message);
        setError(response.message || t('errorDeletingRoom')); // Use a new key? e.g., errorDeletingRoomPermanently
      }
    });
  }, [currentRoom, setView, t]); // Dependencies

  // 分离聊天视图的渲染逻辑
  const renderChatView = () => {
    if (!currentRoom) {
        return <WelcomeView onEnterRooms={() => setView("rooms")} />;
    }

    return (
        // Use PanelGroup for horizontal resizing
        <PanelGroup direction="horizontal" className="flex h-full min-h-0 w-full flex-1">
            <PanelResizeHandle className="w-px cursor-col-resize bg-[#dedbd0] transition-colors hover:bg-[#c2c0b6] data-[resize-handle-active]:bg-[#c96442] dark:bg-[#30302e] dark:hover:bg-[#4d4c48] dark:data-[resize-handle-active]:bg-[#d97757]"/>
            {/* --- Right Panel: Chat Interface --- */}
            <Panel defaultSize={50} minSize={30}>
                <div className="flex h-full min-h-0 flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]"> { /* Keep the right side as flex column */}
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
                        handleClearChatMessages={handleClearChatMessages}
                        handleDeleteRoom={handleDeleteRoom}
                        clientId={clientId}
                     />

                     <div className="min-h-0 w-full flex-1 overflow-hidden"> {/* 消息列表区域 */}
                         <MessageList roomId={currentRoom.id} />
                     </div>

                     <div className="flex-shrink-0 border-t border-[#dedbd0] bg-[#faf9f5]/92 p-2 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/92"> {/* 输入框区域 */}
                         <MessageInput
                             roomId={currentRoom.id}
                             username={username}
                             avatarText={getAvatarText(username)}
                             avatarColor={getAvatarColor(username)}
                         />
                     </div>
                </div>
            </Panel>
        </PanelGroup>
    );

  }

  // Render content based on current view
  const renderContent = () => {
    if (isLoadingRoom) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-4"> {/* 保持全屏居中 */}
          <Icon icon="lucide:loader" className="mb-4 h-16 w-16 animate-spin text-[#c96442]" />
          <h2 className="mb-2 font-serif text-xl font-medium text-[#141413] dark:text-[#faf9f5]">{t("loading")}</h2>
          <p className="text-center text-[#5e5d59] dark:text-[#b0aea5]">{t("loadingDescription")}</p>
        </div>
      );
    }

    switch (view) {
      case "rooms":
        return (
          <div className="h-full overflow-y-auto"> {/* 占据全部可用空间 */}
            <RoomList
              rooms={rooms}
              onRoomSelect={handleRoomSelect}
              handleDeleteRoom={handleDeleteRoom}
              clientId={clientId}
              username={username}
            />
          </div>
        );
      case "saved":
        return (
          <div className="h-full overflow-y-auto"> {/* 占据全部可用空间 */}
            <SavedRoomList
              rooms={savedRooms}
              onRoomSelect={handleRoomSelect}
              onRoomsChange={setSavedRooms}
            />
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
        // 委托给新的渲染函数
        return renderChatView();
      default:
        return <WelcomeView onEnterRooms={() => setView("rooms")} />;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f5f4ed] text-[#141413] dark:bg-[#141413] dark:text-[#faf9f5]"> {/* 确保根容器是 flex 列且占满屏幕高度 */}
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

      {/* 错误和成功消息 - 暂时移除直接调用，依赖其他组件处理 */}
      {/* {error && <SomeErrorComponent message={error} />} */}
      {/* {success && <SomeSuccessComponent message={success} />} */}

      {/* 主内容区域， flex-1 使其填充剩余空间，overflow-hidden 避免双重滚动条 */}
      <main className="min-h-0 flex-1 overflow-hidden">
        {renderContent()} {/* 渲染当前视图 */}
      </main>

      {/* 底部导航栏 - 移除 view !== "settings" 条件 */}
      <BottomNav view={view} setView={setView} currentRoom={currentRoom} />

      {/* 加入房间确认弹窗 - 恢复之前的属性传递 */}
      {roomToJoin && (
          <RoomJoinModal
            roomToJoin={roomToJoin} // 传递整个对象
            handleConfirmJoin={handleConfirmJoin} // 传递处理函数
          />
      )}
    </div>
  );
};
