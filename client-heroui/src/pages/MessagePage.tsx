import React, { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "@iconify/react";
import { useTheme } from "@heroui/use-theme";
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
  renameRoom,
} from "../utils/socket";
import {
  Room, RoomMemberEvent,
} from "../utils/types";
import { saveRoom, removeRoom, isRoomSaved, getSavedRooms } from "../utils/storage";
import { generateRandomName } from "../utils/userProfile";
import { getStoredRoom, getStoredUsername, getStoredView, saveCurrentRoom, saveCurrentView, saveUsername, AppView } from "../utils/appPersistence";
import { buildRoomShareUrl, getRoomMemberUpdate, sortRoomsByLastActivityDesc, upsertRoom } from "../utils/roomState";
import { FALLBACK_FEATURE_FLAGS, fetchFeatureFlags, FeatureFlags } from "../utils/features";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppHeader } from "../components/AppHeader";
import { SettingsView } from "../components/SettingsView";
import { RoomJoinModal } from "../components/RoomJoinModal";
import { BottomNav } from "../components/BottomNav";
import { DesktopSidebar } from "../components/DesktopSidebar";
import { WelcomeView } from "../components/WelcomeView";
import { ChatRoomView } from "../components/ChatRoomView";

const isDesktopLayout = () => (
  typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
);

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
  const [view, setView] = useState<AppView>(() => {
    const storedView = getStoredView();
    return storedView === "saved" && isDesktopLayout() ? "rooms" : storedView;
  });
  const [_error, setError] = useState<string | null>(null);
  const [_success, setSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  // 当 URL 参数包含房间时，先保存待确认的房间信息
  const [roomToJoin, setRoomToJoin] = useState<{ id: string; name: string } | null>(null);
  // 添加房间成员数量状态
  const [memberCount, setMemberCount] = useState<number>(0);
  // 添加最近加入/离开消息状态
  const [memberEvent, setMemberEvent] = useState<{ type: "join" | "leave"; userId: string } | null>(null);
  // 添加用户名状态
  const [username, setUsername] = useState<string>("");
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>(FALLBACK_FEATURE_FLAGS);
  // 是否显示修改用户名弹窗
  const [showEditUsername, setShowEditUsername] = useState<boolean>(false);

  // 修改处：同时获取 setSearchParams 方法
  const [searchParams, setSearchParams] = useSearchParams();

  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  const showSuccess = useCallback((message: string, durationMs = 2000) => {
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
    }

    setSuccess(message);
    successTimerRef.current = setTimeout(() => {
      setSuccess(null);
      successTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchFeatureFlags(clientId)
      .then((flags) => {
        if (!cancelled) {
          setFeatureFlags(flags);
        }
      })
      .catch((error) => {
        console.error("Failed to load feature flags:", error);
        if (!cancelled) {
          setFeatureFlags(FALLBACK_FEATURE_FLAGS);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
  const clearRoomUrlParam = useCallback(() => {
    const newParams = new URLSearchParams(searchParams);
    newParams.delete("room");
    setSearchParams(newParams);
  }, [searchParams, setSearchParams]);

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

  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 768px)');
    const redirectDesktopSavedView = () => {
      if (mediaQuery.matches) {
        setView((currentView) => currentView === "saved" ? "rooms" : currentView);
      }
    };

    redirectDesktopSavedView();
    mediaQuery.addEventListener('change', redirectDesktopSavedView);
    return () => mediaQuery.removeEventListener('change', redirectDesktopSavedView);
  }, []);

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
    const handleRoomList = (roomList: Room[]) => setRooms(sortRoomsByLastActivityDesc(roomList));
    const handleRoomUpdate = (room: Room) => {
      setRooms((prev) => sortRoomsByLastActivityDesc(upsertRoom(prev, room)));
      setCurrentRoom((current) => current?.id === room.id ? { ...current, ...room } : current);
      setSavedRooms((prev) => prev.map((savedRoom) => savedRoom.id === room.id ? { ...savedRoom, ...room } : savedRoom));
    };
    let clearMemberEventTimer: ReturnType<typeof setTimeout> | undefined;

    socket.on("room_list", handleRoomList);
    socket.emit("get_rooms");
    socket.on("new_room", handleRoomUpdate);
    socket.on("room_updated", handleRoomUpdate);

    // 取消注册回调的清理函数
    const unsubscribe = onRoomMemberChange((event: RoomMemberEvent) => {
      const memberUpdate = getRoomMemberUpdate(currentRoom, event);
      if (memberUpdate) {
        setMemberCount(memberUpdate.count);
        setMemberEvent(memberUpdate.event);

        // 5秒后清除成员事件显示
        if (clearMemberEventTimer) {
          clearTimeout(clearMemberEventTimer);
        }
        clearMemberEventTimer = setTimeout(() => {
          setMemberEvent(null);
        }, 5000);
      }
    });

    return () => {
      if (clearMemberEventTimer) {
        clearTimeout(clearMemberEventTimer);
      }
      socket.off("room_list", handleRoomList);
      socket.off("new_room", handleRoomUpdate);
      socket.off("room_updated", handleRoomUpdate);
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
    const url = buildRoomShareUrl(window.location.origin, window.location.pathname, currentRoom.id);
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setError(null);
        showSuccess(t("shareSuccess"));
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

  const handleUnsaveRoom = useCallback((roomId: string) => {
    setSavedRooms(removeRoom(roomId));
  }, []);

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setError(null);
        showSuccess(t("copySuccess"));
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
    showSuccess(t("usernameUpdated"));
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
        showSuccess(t('roomDeletedSuccess'), 3000); // Use a new key? e.g., roomDeletedPermanentlySuccess
      } else {
        console.error('Server failed to PERMANENTLY delete room:', response.message);
        setError(response.message || t('errorDeletingRoom')); // Use a new key? e.g., errorDeletingRoomPermanently
      }
    });
  }, [currentRoom, setView, clearRoomUrlParam, showSuccess, t]); // Dependencies

  const handleRenameRoom = useCallback(async (roomId: string, name: string) => {
    try {
      const updatedRoom = await renameRoom(roomId, name);
      setRooms((prev) => sortRoomsByLastActivityDesc(upsertRoom(prev, updatedRoom)));
      setCurrentRoom((current) => current?.id === updatedRoom.id ? { ...current, ...updatedRoom } : current);
      setSavedRooms((prev) => prev.map((savedRoom) => savedRoom.id === updatedRoom.id ? { ...savedRoom, ...updatedRoom } : savedRoom));
      showSuccess(t('roomRenamedSuccess'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errorRenamingRoom');
      throw new Error(message);
    }
  }, [showSuccess, t]);

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
              handleRenameRoom={handleRenameRoom}
              clientId={clientId}
              username={username}
              isCocoEnabled={featureFlags.coco.enabled}
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
            clientId={clientId}
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
        return currentRoom ? (
          <ChatRoomView
            currentRoom={currentRoom}
            memberCount={memberCount}
            memberEvent={memberEvent}
            username={username}
            clientId={clientId}
            handleCopyToClipboard={handleCopyToClipboard}
            handleShareRoom={handleShareRoom}
            handleToggleSave={handleToggleSave}
            handleLeaveRoom={handleLeaveRoom}
            isRoomSaved={isRoomSaved}
            setView={setView}
            clearRoomUrlParam={clearRoomUrlParam}
            handleClearChatMessages={handleClearChatMessages}
            handleDeleteRoom={handleDeleteRoom}
            handleRenameRoom={handleRenameRoom}
          />
        ) : (
          <WelcomeView onEnterRooms={() => setView("rooms")} />
        );
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

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <DesktopSidebar
          clientId={clientId}
          username={username}
          view={view}
          setView={setView}
          rooms={rooms}
          savedRooms={savedRooms}
          currentRoom={currentRoom}
          i18n={i18n}
          changeLanguage={changeLanguage}
          toggleTheme={toggleTheme}
          isDark={isDark}
          handleCopyToClipboard={handleCopyToClipboard}
          onRoomSelect={handleRoomSelect}
          onDeleteRoom={handleDeleteRoom}
          onUnsaveRoom={handleUnsaveRoom}
          onRenameRoom={handleRenameRoom}
          isCocoEnabled={featureFlags.coco.enabled}
        />

        {/* 主内容区域， flex-1 使其填充剩余空间，overflow-hidden 避免双重滚动条 */}
        <main className="flex min-h-0 flex-1 overflow-hidden">
          {renderContent()} {/* 渲染当前视图 */}
        </main>
      </div>

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
