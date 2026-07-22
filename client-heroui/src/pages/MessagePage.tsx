import React, { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "@iconify/react";
import { useTheme } from "@heroui/use-theme";
import { RoomList } from "../components/RoomList";
import { SavedRoomList } from "../components/SavedRoomList";
import {
  socket,
  roomSessionController,
  leaveRoom,
  getRoomById,
  clientId,
  getRoomMemberCount,
  onRoomMemberChange,
  onUsernameAdopted,
  setUsername as emitUsername,
  renameRoom,
  saveRoomToServer,
  unsaveRoomFromServer,
  getRoomsFromServer,
  getSavedRoomsFromServer,
  getRoomPermissions,
  clearRoomMessages as clearRoomMessagesFromServer,
  type RoomJoinResult,
} from "../utils/socket";
import { doesRoomSessionErrorInvalidateRetainedAccess, getRoomSessionErrorCode, RoomSessionSupersededError, type RoomSessionSource } from "../utils/roomSessionController";
import {
  Room, RoomMemberEvent, RoomPermissions,
} from "../utils/types";
import { generateRandomName } from "../utils/userProfile";
import { getStoredRoom, getStoredRoomPermissions, getStoredUsername, getStoredView, saveCurrentRoom, saveCurrentRoomPermissions, saveCurrentView, saveUsername, AppView } from "../utils/appPersistence";
import { buildRoomShareUrl, getRoomMemberUpdate, isNewerRoom, pickNewerRoom, sortRoomsByLastActivityDesc, upsertRoom } from "../utils/roomState";
import { getNextPostingBoundaryDelayMs } from "../utils/postingSchedule";
import { FALLBACK_FEATURE_FLAGS, fetchFeatureFlags, FeatureFlags } from "../utils/features";
import { getCodeAgentAvailableModes, getCodeAgentBackend, getCodeAgentDefaultMode } from "../utils/codeAgent";
import { reactivateCachedRoomMessageWindow } from "../utils/messageHistoryCache";
import { invalidatePersistentRoomCache } from "../utils/persistentCacheLifecycle";
import { logRoomSessionDiagnostic } from "../utils/roomDiagnostics";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SettingsView } from "../components/SettingsView";
import { RoomJoinModal } from "../components/RoomJoinModal";
import { BottomNav } from "../components/BottomNav";
import { DesktopSidebar } from "../components/DesktopSidebar";
import { WelcomeView } from "../components/WelcomeView";
import { ChatRoomView } from "../components/ChatRoomView";
import { CodeAgentRoomView } from "../components/CodeAgentRoomView";
import { StatusMessage } from "../components/StatusMessage";
import { useRoomSession } from "../hooks/useRoomSession";

const isDesktopLayout = () => (
  typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
);

type RoomRestoreSource = RoomSessionSource;
const VISIBLE_RESTORE_SOURCES = new Set<RoomRestoreSource>(["storage", "manual", "url"]);
// 后台 rejoin 超过这个时长仍未完成才显示"重连中"转圈:
// 健康连接下的 rejoin 是毫秒级的,立即显示会在每次切前台时闪一下(回归 #6)
const RECONNECT_INDICATOR_DELAY_MS = 400;
const ERROR_AUTO_DISMISS_MS = 8000;

const applyOwnedRoomDelta = (rooms: Room[], incomingRoom: Room): Room[] => {
  if (incomingRoom.creatorId !== clientId) {
    return rooms.filter(room => room.id !== incomingRoom.id);
  }
  const existing = rooms.find(room => room.id === incomingRoom.id);
  if (existing && !isNewerRoom(incomingRoom, existing)) {
    return rooms;
  }
  return sortRoomsByLastActivityDesc(upsertRoom(rooms, incomingRoom));
};

const applySavedRoomMetadataDelta = (rooms: Room[], incomingRoom: Room): Room[] => {
  const existing = rooms.find(room => room.id === incomingRoom.id);
  if (!existing || !isNewerRoom(incomingRoom, existing)) {
    return rooms;
  }
  return sortRoomsByLastActivityDesc(rooms.map(room => (
    room.id === incomingRoom.id ? incomingRoom : room
  )));
};

const applySavedRoomAddedDelta = (rooms: Room[], incomingRoom: Room): Room[] => {
  const existing = rooms.find(room => room.id === incomingRoom.id);
  if (existing && !isNewerRoom(incomingRoom, existing)) {
    return rooms;
  }
  return sortRoomsByLastActivityDesc(upsertRoom(rooms, incomingRoom));
};

type RoomListDelta =
  | { sequence: number; kind: 'room-updated'; room: Room }
  | { sequence: number; kind: 'saved-room-added'; room: Room }
  | { sequence: number; kind: 'room-removed'; roomId: string }
  | { sequence: number; kind: 'saved-room-removed'; roomId: string };
type RoomListDeltaInput =
  | { kind: 'room-updated'; room: Room }
  | { kind: 'saved-room-added'; room: Room }
  | { kind: 'room-removed'; roomId: string }
  | { kind: 'saved-room-removed'; roomId: string };

const replayOwnedRoomDeltas = (snapshot: Room[], deltas: RoomListDelta[]): Room[] => deltas.reduce((rooms, delta) => {
  if (delta.kind === 'room-updated') return applyOwnedRoomDelta(rooms, delta.room);
  if (delta.kind === 'room-removed') return rooms.filter(room => room.id !== delta.roomId);
  return rooms;
}, sortRoomsByLastActivityDesc(snapshot));

const replaySavedRoomDeltas = (snapshot: Room[], deltas: RoomListDelta[]): Room[] => deltas.reduce((rooms, delta) => {
  if (delta.kind === 'room-updated') return applySavedRoomMetadataDelta(rooms, delta.room);
  if (delta.kind === 'saved-room-added') return applySavedRoomAddedDelta(rooms, delta.room);
  if (delta.kind === 'room-removed' || delta.kind === 'saved-room-removed') {
    return rooms.filter(room => room.id !== delta.roomId);
  }
  return rooms;
}, sortRoomsByLastActivityDesc(snapshot));


export const MessagePage: React.FC = () => {
  // 不操作 html/body 滚动，页面固定高度由容器本身管理
  // 添加初始化标志，防止初始渲染时清除存储的房间
  const isInitialMount = useRef(true);
  // 页面高度由 App shell 的 visual viewport 变量控制
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme(
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const isDark = theme === "dark";

  // 状态简化：不再单独存储 roomId 和 joined 状态
  const [rooms, setRooms] = useState<Room[]>([]);
  const [savedRooms, setSavedRooms] = useState<Room[]>([]);
  const [isLoadingRooms, setIsLoadingRooms] = useState(true);
  const [isLoadingSavedRooms, setIsLoadingSavedRooms] = useState(true);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const currentRoomRef = useRef<Room | null>(null);
  const roomSession = useRoomSession();
  // Room metadata lookups are their own intent stream. A late response from an
  // older URL/manual lookup must never reopen its modal or start a stale join.
  const roomLookupGenerationRef = useRef(0);
  const [roomPermissions, setRoomPermissions] = useState<RoomPermissions | null>(() => {
    const storedRoom = getStoredRoom();
    return storedRoom ? getStoredRoomPermissions(storedRoom.id, clientId) : null;
  });
  const commitRoomPermissions = useCallback((permissions: RoomPermissions | null) => {
    saveCurrentRoomPermissions(permissions);
    setRoomPermissions(permissions);
  }, []);
  const roomPermissionsRequestGenerationRef = useRef(0);
  // 初始化视图状态，默认从localStorage读取
  const [view, setView] = useState<AppView>(() => {
    const storedView = getStoredView();
    return storedView === "saved" && isDesktopLayout() ? "rooms" : storedView;
  });
  const viewRef = useRef<AppView>(view);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const reconnectIndicatorTimerRef = useRef<number | null>(null);
  const appliedRoomSessionResultRef = useRef<{ roomId: string; result: RoomJoinResult } | null>(null);
  const handledUnavailableErrorRef = useRef<Error | null>(null);
  const foregroundRoomSessionCountsRef = useRef<Map<string, number>>(new Map());

  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  // 当 URL 参数包含房间时，先保存待确认的房间信息
  const [roomToJoin, setRoomToJoin] = useState<Room | null>(null);
  // 添加房间成员数量状态
  const [memberCount, setMemberCount] = useState<number | null>(null);
  // 添加用户名状态
  const [username, setUsername] = useState<string>("");
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>(FALLBACK_FEATURE_FLAGS);
  // 是否显示修改用户名弹窗
  const [showEditUsername, setShowEditUsername] = useState<boolean>(false);

  // 修改处：同时获取 setSearchParams 方法
  const [searchParams, setSearchParams] = useSearchParams();
  const roomIdFromUrl = searchParams.get("room");
  const currentRoomId = currentRoom?.id ?? null;
  const translationRef = useRef(t);
  translationRef.current = t;

  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  const showSuccess = useCallback((message: string, durationMs = 2000) => {
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
    }

    setError(null);
    setSuccess(message);
    successTimerRef.current = setTimeout(() => {
      setSuccess(null);
      successTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    if (!error) {
      return;
    }

    const timer = window.setTimeout(() => {
      setError((current) => current === error ? null : current);
    }, ERROR_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
      }
      if (reconnectIndicatorTimerRef.current !== null) {
        window.clearTimeout(reconnectIndicatorTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const retryDelaysMs = [0, 1000, 3000];

    const loadFeatureFlags = (attempt = 0) => {
      fetchFeatureFlags(clientId)
        .then((flags) => {
          if (!cancelled) {
            setFeatureFlags(flags);
          }
        })
        .catch((error) => {
          if (cancelled) return;
          const nextDelay = retryDelaysMs[attempt + 1];
          if (nextDelay !== undefined) {
            retryTimer = setTimeout(() => loadFeatureFlags(attempt + 1), nextDelay);
            return;
          }

          console.error("Failed to load feature flags:", error);
          setFeatureFlags(FALLBACK_FEATURE_FLAGS);
        });
    };

    loadFeatureFlags();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, []);

  useEffect(() => {
    const shouldDelayReconnectIndicator = Boolean(
      currentRoom
      && roomSession.roomId === currentRoom.id
      && roomSession.result
      && (roomSession.phase === "retrying" || roomSession.phase === "registering" || roomSession.phase === "joining")
    );
    if (!shouldDelayReconnectIndicator) {
      if (reconnectIndicatorTimerRef.current !== null) {
        window.clearTimeout(reconnectIndicatorTimerRef.current);
        reconnectIndicatorTimerRef.current = null;
      }
      setIsReconnecting(false);
      return;
    }

    reconnectIndicatorTimerRef.current = window.setTimeout(() => {
      reconnectIndicatorTimerRef.current = null;
      setIsReconnecting(true);
    }, RECONNECT_INDICATOR_DELAY_MS);
    return () => {
      if (reconnectIndicatorTimerRef.current !== null) {
        window.clearTimeout(reconnectIndicatorTimerRef.current);
        reconnectIndicatorTimerRef.current = null;
      }
    };
  }, [currentRoom, roomSession.phase, roomSession.result, roomSession.roomId]);

  // 服务端返回的房间对象是完整真值(room_updated 广播、join/settings/rename ack)。
  // 必须整体替换而不能 spread 合并:被清除的字段(关闭排期后的 postingSchedule、
  // 清除密码后的 hasPassword)在新对象里是"键不存在",spread 永远删不掉它们。
  // currentRoom 的唯一提交入口:先同步推进 currentRoomRef(broadcast 与 ack 两条
  // 路径靠它互相看见,React commit 前的同批次旧载荷才不会回踩),再做收敛式入队
  // (functional update 带守卫,入队顺序不影响最终结果)。
  const commitNewerCurrentRoom = useCallback((incomingRoom: Room) => {
    if (currentRoomRef.current?.id === incomingRoom.id && isNewerRoom(incomingRoom, currentRoomRef.current)) {
      currentRoomRef.current = incomingRoom;
    }
    setCurrentRoom((current) => (
      current?.id === incomingRoom.id && isNewerRoom(incomingRoom, current) ? incomingRoom : current
    ));
  }, []);

  const applyServerRoom = useCallback((updatedRoom: Room) => {
    setRooms((prev) => applyOwnedRoomDelta(prev, updatedRoom));
    commitNewerCurrentRoom(updatedRoom);
    setSavedRooms((prev) => applySavedRoomMetadataDelta(prev, updatedRoom));
  }, [commitNewerCurrentRoom]);

  const refreshRoomPermissions = useCallback((roomId: string) => {
    const requestGeneration = roomPermissionsRequestGenerationRef.current + 1;
    roomPermissionsRequestGenerationRef.current = requestGeneration;
    getRoomPermissions(roomId)
      .then((permissions) => {
        if (
          roomPermissionsRequestGenerationRef.current === requestGeneration
          && currentRoomRef.current?.id === roomId
          && permissions.roomId === roomId
        ) {
          commitRoomPermissions(permissions);
        }
      })
      .catch((error) => {
        console.error("Failed to load room permissions:", error);
        // A failed refresh does not revoke the last acknowledged permission
        // snapshot. Every protected operation is still authorized by the
        // server, and a later invalidation/rejoin can replace this snapshot.
      });
  }, [commitRoomPermissions]);

  useEffect(() => {
    currentRoomRef.current = currentRoom;
  }, [currentRoom]);

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

  const applyRoomSessionResult = useCallback((
    roomId: string,
    result: RoomJoinResult,
    fallbackRoom?: Room | null,
  ) => {
    const previousRoomId = currentRoomRef.current?.id ?? null;
    const joinedRoom = result.room || fallbackRoom || currentRoomRef.current;
    if (!joinedRoom || joinedRoom.id !== roomId) {
      return null;
    }

    const baseline = currentRoomRef.current?.id === roomId ? currentRoomRef.current : null;
    const roomToApply = pickNewerRoom(joinedRoom, baseline);
    currentRoomRef.current = roomToApply;
    setCurrentRoom((current) => (
      current?.id === roomId ? pickNewerRoom(roomToApply, current) : roomToApply
    ));

    roomPermissionsRequestGenerationRef.current += 1;
    if (result.permissions) {
      commitRoomPermissions(result.permissions);
    } else {
      if (previousRoomId !== roomId) {
        commitRoomPermissions(null);
      }
      refreshRoomPermissions(roomId);
    }

    const resolvedMemberCount = typeof result.memberCount === "number"
      ? result.memberCount
      : getRoomMemberCount(roomId);
    if (typeof resolvedMemberCount === "number") {
      setMemberCount(resolvedMemberCount);
    } else if (previousRoomId !== roomId) {
      setMemberCount(null);
    }
    return joinedRoom;
  }, [commitRoomPermissions, refreshRoomPermissions]);

  // Foreground joins, lifecycle resumes, and socket replacement all converge on
  // the controller snapshot. A result object represents one acknowledged join
  // and must update the page shell/cache window exactly once, regardless of
  // which caller observes it first.
  const consumeRoomSessionResult = useCallback((
    roomId: string,
    result: RoomJoinResult,
    fallbackRoom?: Room | null,
  ) => {
    const applied = appliedRoomSessionResultRef.current;
    if (applied?.roomId === roomId && applied.result === result) {
      return currentRoomRef.current?.id === roomId
        ? currentRoomRef.current
        : result.room || fallbackRoom || null;
    }

    const joinedRoom = applyRoomSessionResult(roomId, result, fallbackRoom);
    if (!joinedRoom) return null;

    appliedRoomSessionResultRef.current = { roomId, result };
    handledUnavailableErrorRef.current = null;
    reactivateCachedRoomMessageWindow(roomId);
    setError(null);
    return currentRoomRef.current?.id === roomId ? currentRoomRef.current : joinedRoom;
  }, [applyRoomSessionResult]);

  const runActiveRoomSession = useCallback(async (options: {
    roomId: string;
    password?: string;
    fallbackRoom?: Room | null;
    source: RoomRestoreSource;
  }) => {
    const { roomId, password, fallbackRoom, source } = options;
    const previousRoomId = currentRoomRef.current?.id ?? null;
    const previousRoom = currentRoomRef.current;
    const showRestoreIndicator = VISIBLE_RESTORE_SOURCES.has(source);
    logRoomSessionDiagnostic("join-start", {
      roomId,
      source,
      sessionEpoch: roomSessionController.getSnapshot().sessionEpoch,
      previousRoomId,
      previousStatus: roomSessionController.getSnapshot().phase,
      socketId: socket.id ?? null,
      socketConnected: socket.connected,
    });
    if (showRestoreIndicator) {
      setError(null);
    }

    const isSwitchingRoom = Boolean(previousRoom && previousRoom.id !== roomId);
    if (fallbackRoom && !isSwitchingRoom) {
      currentRoomRef.current = fallbackRoom;
      setCurrentRoom(fallbackRoom);
    }

    const cachedMemberCount = getRoomMemberCount(roomId);
    if (!isSwitchingRoom && typeof cachedMemberCount === "number") {
      setMemberCount(cachedMemberCount);
    } else if (previousRoomId !== roomId && !isSwitchingRoom) {
      setMemberCount(null);
    }

    const foregroundCounts = foregroundRoomSessionCountsRef.current;
    foregroundCounts.set(roomId, (foregroundCounts.get(roomId) ?? 0) + 1);
    try {
      const result = await roomSessionController.selectRoom({ roomId, password, source });
      const settledSession = roomSessionController.getSnapshot();
      if (settledSession.roomId !== roomId || settledSession.phase !== "ready") return null;

      const joinedRoom = consumeRoomSessionResult(roomId, result, fallbackRoom);
      if (joinedRoom) {
        logRoomSessionDiagnostic("join-ready", {
          roomId,
          source,
          sessionEpoch: settledSession.sessionEpoch,
          messageSyncRequestId: settledSession.messageSyncRequestId,
          memberCount: result.memberCount ?? null,
          socketId: socket.id ?? null,
          socketConnected: socket.connected,
        });
      }
      return joinedRoom;
    } catch (error) {
      if (error instanceof RoomSessionSupersededError || (error instanceof Error && error.name === "RoomSessionSupersededError")) {
        return null;
      }

      const failedSession = roomSessionController.getSnapshot();
      if (
        error instanceof Error
        && failedSession.phase === "unavailable"
        && failedSession.roomId === roomId
        && failedSession.error === error
      ) {
        if (handledUnavailableErrorRef.current === error) return null;
        handledUnavailableErrorRef.current = error;
      }

      const message = error instanceof Error ? error.message : translationRef.current("errorLoading");
      const errorCode = getRoomSessionErrorCode(error);
      const retainedAccessInvalidated = doesRoomSessionErrorInvalidateRetainedAccess(error);
      logRoomSessionDiagnostic("join-failed", {
        roomId,
        source,
        sessionEpoch: roomSessionController.getSnapshot().sessionEpoch,
        error: message,
        socketId: socket.id ?? null,
        socketConnected: socket.connected,
      });
      console.error(`Failed to ensure active room session from ${source}:`, error);

      const definitiveRemoval = errorCode === "ROOM_NOT_FOUND" || errorCode === "ROOM_ACCESS_REMOVED";
      if (!isSwitchingRoom && retainedAccessInvalidated) {
        commitRoomPermissions(null);
      }
      if (definitiveRemoval) {
        setRooms((previous) => previous.filter(room => room.id !== roomId));
        setSavedRooms((previous) => previous.filter(room => room.id !== roomId));
        void invalidatePersistentRoomCache(roomId);
      }

      if (isSwitchingRoom && previousRoom) {
        try {
          const rollbackResult = await roomSessionController.selectRoom({
            roomId: previousRoom.id,
            source: "retry",
          });
          consumeRoomSessionResult(previousRoom.id, rollbackResult, previousRoom);
        } catch (rollbackError) {
          console.error("Failed to restore the previous room after a rejected room switch:", rollbackError);
        }
        if (errorCode === "ROOM_PASSWORD_REQUIRED_OR_INCORRECT" && fallbackRoom) {
          setRoomToJoin(fallbackRoom);
        }
        clearRoomUrlParam();
        setError(message);
        return null;
      }

      if (definitiveRemoval) {
        leaveRoom(roomId);
        currentRoomRef.current = null;
        setCurrentRoom(null);
        commitRoomPermissions(null);
        setMemberCount(null);
        setView("rooms");
        saveCurrentRoom(null);
        clearRoomUrlParam();
        setError(translationRef.current("errorRoomNoLongerExists"));
      } else if (showRestoreIndicator) {
        setError(source === "storage" ? translationRef.current("errorRestoringRoom") : message);
      }

      return null;
    } finally {
      const remaining = (foregroundCounts.get(roomId) ?? 1) - 1;
      if (remaining > 0) {
        foregroundCounts.set(roomId, remaining);
      } else {
        foregroundCounts.delete(roomId);
      }
    }
  }, [clearRoomUrlParam, commitRoomPermissions, consumeRoomSessionResult]);

  const ensureActiveRoomSession = useCallback((options: {
    roomId: string;
    password?: string;
    fallbackRoom?: Room | null;
    source: RoomRestoreSource;
  }): Promise<Room | null> => runActiveRoomSession(options), [runActiveRoomSession]);

  const scheduleRoomRestore = useCallback((source: "visibility" | "pageshow" | "online") => {
    const activeRoom = currentRoomRef.current;
    if (!activeRoom) {
      logRoomSessionDiagnostic("restore-skipped-no-room", {
        source,
        sessionEpoch: roomSessionController.getSnapshot().sessionEpoch,
        socketId: socket.id ?? null,
        socketConnected: socket.connected,
      });
      return null;
    }
    logRoomSessionDiagnostic("restore-scheduled", {
      roomId: activeRoom.id,
      source,
      sessionEpoch: roomSessionController.getSnapshot().sessionEpoch,
      socketId: socket.id ?? null,
      socketConnected: socket.connected,
    });
    return roomSessionController.resume(source)
      .then((result) => result?.room || activeRoom)
      .catch((error) => {
        if (!(error instanceof RoomSessionSupersededError) && (!(error instanceof Error) || error.name !== "RoomSessionSupersededError")) {
          console.error(`Scheduled room restore failed from ${source}:`, error);
        }
        return null;
      });
  }, []);

  // Socket replacement is recovered inside the controller, so there may be no
  // page-level caller waiting on the new join acknowledgement. Consume each new
  // ready result once and project it into the room shell here.
  useEffect(() => {
    if (
      roomSession.phase !== "ready"
      || !roomSession.roomId
      || !roomSession.result
      || (
        appliedRoomSessionResultRef.current?.roomId === roomSession.roomId
        && appliedRoomSessionResultRef.current.result === roomSession.result
      )
    ) {
      return;
    }

    const fallbackRoom = currentRoomRef.current?.id === roomSession.roomId
      ? currentRoomRef.current
      : null;
    consumeRoomSessionResult(roomSession.roomId, roomSession.result, fallbackRoom);
  }, [consumeRoomSessionResult, roomSession.phase, roomSession.result, roomSession.roomId]);

  // A background reconnect has no awaiting page promise either. Surface its
  // terminal failure from the same controller snapshot and clean up only when
  // the room itself is definitively gone or access was revoked.
  useEffect(() => {
    if (
      roomSession.phase !== "unavailable"
      || !roomSession.roomId
      || !roomSession.error
      || (foregroundRoomSessionCountsRef.current.get(roomSession.roomId) ?? 0) > 0
      || handledUnavailableErrorRef.current === roomSession.error
      || currentRoomRef.current?.id !== roomSession.roomId
    ) {
      return;
    }

    handledUnavailableErrorRef.current = roomSession.error;
    const errorCode = getRoomSessionErrorCode(roomSession.error);
    const definitiveRemoval = errorCode === "ROOM_NOT_FOUND" || errorCode === "ROOM_ACCESS_REMOVED";
    if (doesRoomSessionErrorInvalidateRetainedAccess(roomSession.error)) {
      commitRoomPermissions(null);
    }
    if (!definitiveRemoval) {
      setError(translationRef.current("errorRestoringRoom"));
      return;
    }

    const removedRoomId = roomSession.roomId;
    leaveRoom(removedRoomId);
    commitRoomPermissions(null);
    setRooms((previous) => previous.filter(room => room.id !== removedRoomId));
    setSavedRooms((previous) => previous.filter(room => room.id !== removedRoomId));
    void invalidatePersistentRoomCache(removedRoomId);
    currentRoomRef.current = null;
    setCurrentRoom(null);
    setMemberCount(null);
    setView("rooms");
    saveCurrentRoom(null);
    clearRoomUrlParam();
    setError(translationRef.current("errorRoomNoLongerExists"));
  }, [clearRoomUrlParam, commitRoomPermissions, roomSession.error, roomSession.phase, roomSession.roomId]);

  // 初次加载时加载已保存房间和用户名
  useEffect(() => {
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
      emitUsername(username);
    }
  }, [username]);

  useEffect(() => onUsernameAdopted((adopted) => setUsername(adopted)), []);

  // 视图变化时保存到localStorage
  useEffect(() => {
    viewRef.current = view;
    if (view) {
      saveCurrentView(view);
    }
  }, [view]);

  const handleViewChange = useCallback((nextView: AppView) => {
    setError(null);
    setView(nextView);
  }, []);

  const clearStatusForTask = useCallback(() => {
    setError(null);
    setSuccess(null);
  }, []);

  useEffect(() => {
    const handleHistoryBack = () => {
      if (viewRef.current === "chat" && currentRoomRef.current) {
        setError(null);
        setView("rooms");
      }
    };

    window.addEventListener("popstate", handleHistoryBack);
    return () => window.removeEventListener("popstate", handleHistoryBack);
  }, []);

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
    if (!currentRoom) {
      const storedRoom = getStoredRoom();

      if (storedRoom) {
        console.log("Found stored room, attempting to restore:", storedRoom.id);
        const savedView = getStoredView();
        const storedPermissions = getStoredRoomPermissions(storedRoom.id, clientId);
        console.log("Restored stored room shell with saved view:", savedView);
        if (storedPermissions) {
          commitRoomPermissions(storedPermissions);
          logRoomSessionDiagnostic("retained-access-restored", {
            roomId: storedRoom.id,
            clientId,
            role: storedPermissions.role,
            canPost: storedPermissions.canPost,
          });
        }

        if (savedView === "chat" && view !== "chat") {
          setView("chat");
        }

        void ensureActiveRoomSession({
          roomId: storedRoom.id,
          fallbackRoom: storedRoom,
          source: "storage",
        }).then((roomInfo) => {
          if (roomInfo) {
            console.log("Successfully restored room:", roomInfo.name);
          }
        });
      } else {
        console.log("No stored room found");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // 仅在组件挂载时执行一次

  // 当组件加载或 URL 参数变化时，如果 URL 包含 room 参数，则先加载房间信息并要求确认
  useEffect(() => {
    const generation = roomLookupGenerationRef.current + 1;
    roomLookupGenerationRef.current = generation;
    let cancelled = false;

    if (!roomIdFromUrl || currentRoomId === roomIdFromUrl) {
      setIsLoadingRoom(false);
      return () => {
        cancelled = true;
      };
    }

    setRoomToJoin(null);
    setIsLoadingRoom(true);
    getRoomById(roomIdFromUrl)
      .then((roomInfo) => {
        if (cancelled || roomLookupGenerationRef.current !== generation) return;
        setIsLoadingRoom(false);
        if (roomInfo) {
          // 始终要求用户确认后进入房间
          setRoomToJoin(roomInfo);
        } else {
          setError(translationRef.current("errorRoomNotFound", { roomId: roomIdFromUrl }));
        }
      })
      .catch(() => {
        if (cancelled || roomLookupGenerationRef.current !== generation) return;
        setIsLoadingRoom(false);
        setError(translationRef.current("errorLoading"));
      });

    return () => {
      cancelled = true;
    };
  }, [currentRoomId, roomIdFromUrl]);

  const handleRoomPermissionsInvalidated = useCallback((roomId: string) => {
    if (currentRoomRef.current?.id === roomId) {
      refreshRoomPermissions(roomId);
    }
  }, [refreshRoomPermissions]);

  const applyRoomRemoval = useCallback((roomId: string) => {
    setRooms((previous) => previous.filter(room => room.id !== roomId));
    setSavedRooms((previous) => previous.filter(room => room.id !== roomId));
    void invalidatePersistentRoomCache(roomId);

    const currentRoomAtRemoval = currentRoomRef.current;
    const removedPendingTarget = roomSessionController.getSnapshot().roomId === roomId;
    if (currentRoomAtRemoval?.id !== roomId && !removedPendingTarget) {
      return;
    }

    leaveRoom(roomId);
    commitRoomPermissions(null);
    clearRoomUrlParam();
    setError(translationRef.current("roomAccessRemoved"));

    if (removedPendingTarget && currentRoomAtRemoval && currentRoomAtRemoval.id !== roomId) {
      // The controller owns the canonical target. Selecting the previous room
      // makes that rollback the final serialized membership mutation.
      void ensureActiveRoomSession({
        roomId: currentRoomAtRemoval.id,
        fallbackRoom: currentRoomAtRemoval,
        source: "online",
      }).then((restoredRoom) => {
        if (restoredRoom?.id === currentRoomAtRemoval.id && currentRoomRef.current?.id === currentRoomAtRemoval.id) {
          setError(translationRef.current("roomAccessRemoved"));
        }
      });
      return;
    }

    currentRoomRef.current = null;
    setCurrentRoom(null);
    setMemberCount(null);
    setView("rooms");
    saveCurrentRoom(null);
  }, [clearRoomUrlParam, commitRoomPermissions, ensureActiveRoomSession]);

  // 列表请求返回初始快照，之后靠增量事件维护。快照在途时仍可能收到
  // broadcast，所以记录并重放请求开始后的 delta，避免迟到快照覆盖新状态。
  useEffect(() => {
    let cancelled = false;
    let deltaSequence = 0;
    let deltas: RoomListDelta[] = [];
    let refreshInFlight: Promise<void> | null = null;
    const recordDelta = (delta: RoomListDeltaInput) => {
      deltaSequence += 1;
      deltas.push({ ...delta, sequence: deltaSequence } as RoomListDelta);
    };
    const handleSavedRoomAdded = (room: Room) => {
      recordDelta({ kind: 'saved-room-added', room });
      setSavedRooms((previous) => applySavedRoomAddedDelta(previous, room));
      setIsLoadingSavedRooms(false);
    };
    const handleSavedRoomRemoved = (roomId: string) => {
      recordDelta({ kind: 'saved-room-removed', roomId });
      setSavedRooms((previous) => previous.filter(room => room.id !== roomId));
      setIsLoadingSavedRooms(false);
    };
    const handleRoomUpdate = (room: Room) => {
      recordDelta({ kind: 'room-updated', room });
      applyServerRoom(room);
      setIsLoadingRooms(false);
    };
    const handleRoomPermissions = (permissions: RoomPermissions) => {
      if (currentRoomRef.current?.id === permissions.roomId) {
        roomPermissionsRequestGenerationRef.current += 1;
        commitRoomPermissions(permissions);
      }
    };
    const handleRoomRemoved = (roomId: string) => {
      recordDelta({ kind: 'room-removed', roomId });
      applyRoomRemoval(roomId);
    };

    const refreshRoomLists = () => {
      if (refreshInFlight) return refreshInFlight;
      const requestStartSequence = deltaSequence;
      const ownedRoomsRequest = getRoomsFromServer()
        .then(roomList => {
          if (cancelled) return;
          const laterDeltas = deltas.filter(delta => delta.sequence > requestStartSequence);
          setRooms(replayOwnedRoomDeltas(roomList, laterDeltas));
          setIsLoadingRooms(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error("Failed to load rooms:", error);
          setIsLoadingRooms(false);
        });
      const savedRoomsRequest = getSavedRoomsFromServer()
        .then(roomList => {
          if (cancelled) return;
          const laterDeltas = deltas.filter(delta => delta.sequence > requestStartSequence);
          setSavedRooms(replaySavedRoomDeltas(roomList, laterDeltas));
          setIsLoadingSavedRooms(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error("Failed to load saved rooms:", error);
          setIsLoadingSavedRooms(false);
        });
      const request = Promise.all([ownedRoomsRequest, savedRoomsRequest]).then(() => undefined);
      const trackedRequest = request.finally(() => {
        if (refreshInFlight === trackedRequest) {
          refreshInFlight = null;
          deltas = [];
        }
      });
      refreshInFlight = trackedRequest;
      return refreshInFlight;
    };
    const handleSocketConnect = () => {
      void refreshRoomLists();
    };

    socket.on("new_room", handleRoomUpdate);
    socket.on("room_updated", handleRoomUpdate);
    socket.on("saved_room_added", handleSavedRoomAdded);
    socket.on("saved_room_removed", handleSavedRoomRemoved);
    socket.on("room_permissions", handleRoomPermissions);
    socket.on("room_permissions_invalidated", handleRoomPermissionsInvalidated);
    socket.on("room_removed", handleRoomRemoved);
    socket.on("connect", handleSocketConnect);
    void refreshRoomLists();

    // 取消注册回调的清理函数
    const unsubscribe = onRoomMemberChange((event: RoomMemberEvent) => {
      const memberUpdate = getRoomMemberUpdate(currentRoomRef.current, event);
      if (memberUpdate) {
        setMemberCount(memberUpdate.count);
      }
    });

    return () => {
      cancelled = true;
      socket.off("new_room", handleRoomUpdate);
      socket.off("room_updated", handleRoomUpdate);
      socket.off("saved_room_added", handleSavedRoomAdded);
      socket.off("saved_room_removed", handleSavedRoomRemoved);
      socket.off("room_permissions", handleRoomPermissions);
      socket.off("room_permissions_invalidated", handleRoomPermissionsInvalidated);
      socket.off("room_removed", handleRoomRemoved);
      socket.off("connect", handleSocketConnect);
      unsubscribe();
    };
  }, [applyRoomRemoval, applyServerRoom, commitRoomPermissions, handleRoomPermissionsInvalidated]);

  // 添加页面可见性、BFCache 和网络恢复处理
  useEffect(() => {
    const restoreCurrentRoom = (source: "visibility" | "pageshow" | "online") => {
      void scheduleRoomRestore(source);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log("Page is visible, checking connection status...");
        restoreCurrentRoom("visibility");
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      console.log("Page restored from BFCache, refreshing active room session...");
      restoreCurrentRoom("pageshow");
    };
    const handleOnline = () => restoreCurrentRoom("online");

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
    };
  }, [scheduleRoomRestore]);

  // posting 窗口跨越边界时,本地排期数据足以算出边界时刻;到点后向服务端
  // 重新拉取权限快照,让输入框的 canPost 状态自动翻转(真值仍由服务端判定)。
  useEffect(() => {
    const roomId = currentRoom?.id;
    if (!roomId) {
      return;
    }

    let timeoutId: number | undefined;
    const MAX_BOUNDARY_TIMER_MS = 12 * 60 * 60 * 1000;
    const armNextBoundary = () => {
      const delay = getNextPostingBoundaryDelayMs(currentRoomRef.current?.postingSchedule);
      if (delay === null) {
        return;
      }
      // 边界太远时只分段计时;不到真实边界不发权限请求
      const reachesBoundary = delay <= MAX_BOUNDARY_TIMER_MS;
      timeoutId = window.setTimeout(() => {
        if (reachesBoundary) {
          refreshRoomPermissions(roomId);
        }
        armNextBoundary();
      }, Math.min(delay, MAX_BOUNDARY_TIMER_MS));
    };
    armNextBoundary();

    return () => window.clearTimeout(timeoutId);
  }, [currentRoom, refreshRoomPermissions]);

  // --- 添加清空聊天记录的处理函数 (Stays the same) ---
  const handleClearChatMessages = useCallback(async (confirmation: string) => {
    if (currentRoom) {
      if (!roomSessionController.isReady(currentRoom.id)) {
        const message = t('errorRestoringRoom');
        setError(message);
        throw new Error(message);
      }
      console.log(`Emitting clear_room_messages for room ${currentRoom.id}`);
      try {
        await clearRoomMessagesFromServer(currentRoom.id, confirmation);
        showSuccess(t('chatHistoryCleared'));
      } catch (error) {
        const message = error instanceof Error ? error.message : t('errorClearingChatHistory');
        setError(message);
        throw new Error(message);
      }
    } else {
      console.warn("Attempted to clear messages but no current room.");
      throw new Error(t('errorClearingChatHistory'));
    }
  }, [currentRoom, showSuccess, t]);

  // 直接加入房间：点击房间卡片或确认弹窗后调用
  const handleRoomSelect = async (room: Room, password?: string) => {
    roomLookupGenerationRef.current += 1;
    setIsLoadingRoom(false);
    setRoomToJoin(null);
    setError(null);

    try {
      const joinedRoom = await ensureActiveRoomSession({
        roomId: room.id,
        password,
        fallbackRoom: room,
        source: searchParams.get("room") === room.id ? "url" : "manual",
      });
      if (joinedRoom) {
        setView("chat");
        clearRoomUrlParam();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t("errorLoading");
      setError(message);
    }
  };

  const handleRoomSelectById = async (roomId: string) => {
    const lookupGeneration = roomLookupGenerationRef.current + 1;
    roomLookupGenerationRef.current = lookupGeneration;
    setIsLoadingRoom(false);
    setRoomToJoin(null);
    setError(null);

    try {
      const roomInfo = await getRoomById(roomId);
      if (roomLookupGenerationRef.current !== lookupGeneration) return;
      if (!roomInfo) {
        setError(t("errorRoomNotFound", { roomId }));
        return;
      }

      if (roomInfo.hasPassword) {
        setRoomToJoin(roomInfo);
        return;
      }

      void handleRoomSelect(roomInfo);
    } catch (error) {
      if (roomLookupGenerationRef.current !== lookupGeneration) return;
      console.error("Error loading room by ID:", error);
      setError(t("errorLoading"));
    }
  };

  // URL 加载的房间确认操作
  const handleConfirmJoin = (confirmed: boolean, password?: string) => {
    if (!confirmed || !roomToJoin) {
      roomLookupGenerationRef.current += 1;
      setRoomToJoin(null);
      clearRoomUrlParam();
      return;
    }
    void handleRoomSelect(roomToJoin, password);
    setRoomToJoin(null);
  };

  // 离开当前房间
  const handleLeaveRoom = () => {
    setError(null);

    if (currentRoom) {
      leaveRoom(currentRoom.id);
      setCurrentRoom(null);
      currentRoomRef.current = null;
      commitRoomPermissions(null);
      setMemberCount(null);
      // 修复BUG：离开房间时清除 URL 中的 room 参数，防止重复弹出加入房间确认弹窗
      clearRoomUrlParam();
      // 明确清除localStorage中的房间信息
      saveCurrentRoom(null);
    }
  };

  const ensureRoomSessionReadyForOperation = useCallback(async (roomId: string) => {
    if (currentRoomRef.current?.id !== roomId) {
      throw new RoomSessionSupersededError();
    }
    if (!roomSessionController.isReady(roomId)) {
      await roomSessionController.ensureRoom(roomId, "operation");
    }
    if (currentRoomRef.current?.id !== roomId || !roomSessionController.isReady(roomId)) {
      throw new RoomSessionSupersededError();
    }
  }, []);

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

  const isRoomSavedById = useCallback((roomId: string) => {
    return savedRooms.some((room) => room.id === roomId);
  }, [savedRooms]);

  // 切换保存/取消保存房间
  const handleToggleSave = async () => {
    if (!currentRoom) return;
    const roomId = currentRoom.id;

    try {
      await ensureRoomSessionReadyForOperation(roomId);
      if (isRoomSavedById(roomId)) {
        await unsaveRoomFromServer(roomId);
        setSavedRooms((previous) => previous.filter(room => room.id !== roomId));
      } else {
        const savedRoom = await saveRoomToServer(roomId);
        setSavedRooms((prev) => [savedRoom, ...prev.filter((room) => room.id !== savedRoom.id)]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update saved room";
      setError(message);
    }
  };

  const handleUnsaveRoom = useCallback(async (roomId: string) => {
    try {
      await unsaveRoomFromServer(roomId);
      setSavedRooms((previous) => previous.filter(room => room.id !== roomId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove saved room";
      setError(message);
    }
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
        // A deleted room's cached shell is invalid regardless of which room is
        // active when the acknowledgement arrives.
        void invalidatePersistentRoomCache(roomId);
        setRooms((previous) => previous.filter(room => room.id !== roomId));
        setSavedRooms((previous) => previous.filter(room => room.id !== roomId));

        // If currently in the deleted room, navigate away
        if (currentRoomRef.current?.id === roomId) {
          leaveRoom(roomId);
          setCurrentRoom(null);
          currentRoomRef.current = null;
          setView('rooms');
          commitRoomPermissions(null);
          setMemberCount(null);
          saveCurrentRoom(null);
          clearRoomUrlParam();
        }
        showSuccess(t('roomDeletedSuccess'), 3000); // Use a new key? e.g., roomDeletedPermanentlySuccess
      } else {
        console.error('Server failed to PERMANENTLY delete room:', response.message);
        setError(response.message || t('errorDeletingRoom')); // Use a new key? e.g., errorDeletingRoomPermanently
      }
    });
  }, [setView, clearRoomUrlParam, commitRoomPermissions, showSuccess, t]); // Dependencies

  const handleRenameRoom = useCallback(async (roomId: string, name: string) => {
    if (currentRoomRef.current?.id === roomId && !roomSessionController.isReady(roomId)) {
      throw new Error(t('errorRestoringRoom'));
    }
    try {
      const updatedRoom = await renameRoom(roomId, name);
      applyServerRoom(updatedRoom);
      showSuccess(t('roomRenamedSuccess'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errorRenamingRoom');
      throw new Error(message);
    }
  }, [applyServerRoom, showSuccess, t]);

  const isCurrentRoomSessionReady = Boolean(
    currentRoom && roomSession.roomId === currentRoom.id && roomSession.phase === "ready"
  );
  const isCurrentRoomSessionUnavailable = Boolean(
    currentRoom && roomSession.roomId === currentRoom.id && roomSession.phase === "unavailable"
  );
  const hasCurrentRoomPermissionSnapshot = Boolean(
    currentRoom && roomPermissions?.roomId === currentRoom.id
  );
  const retainedRoomAccessInvalidated = Boolean(
    isCurrentRoomSessionUnavailable
    && doesRoomSessionErrorInvalidateRetainedAccess(roomSession.error)
  );
  const canUseRetainedRoomAccess = hasCurrentRoomPermissionSnapshot && !retainedRoomAccessInvalidated;
  const isCurrentRoomSessionRestoring = Boolean(
    currentRoom && !isCurrentRoomSessionReady && !isCurrentRoomSessionUnavailable
  );

  const handleRetryRoomSession = useCallback(() => {
    const room = currentRoomRef.current;
    if (!room) return;
    setError(null);
    void ensureActiveRoomSession({
      roomId: room.id,
      fallbackRoom: room,
      source: "manual",
    });
  }, [ensureActiveRoomSession]);

  const mainViewTitle = view === "rooms"
    ? t("chatRooms")
    : view === "saved"
      ? t("savedRooms")
      : view === "settings"
        ? t("settings")
        : currentRoom?.name || t("welcomeMessage");

  // Render content based on current view
  const renderContent = () => {
    if (isLoadingRoom) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center p-4"> {/* 保持全屏居中 */}
          <Icon icon="lucide:loader" className="mb-4 h-16 w-16 animate-spin text-[#c96442]" />
          <h2 className="mb-2 font-serif text-xl font-medium text-[#141413] dark:text-[#faf9f5]">{t("loading")}</h2>
          <p className="text-center text-[#5e5d59] dark:text-[#b0aea5]">{t("loadingDescription")}</p>
        </div>
      );
    }

    switch (view) {
      case "rooms":
        return (
          <div className="h-full w-full overflow-y-auto"> {/* 占据全部可用空间 */}
            <RoomList
              rooms={rooms}
              isLoading={isLoadingRooms}
              onRoomSelect={handleRoomSelect}
              onRoomSelectById={handleRoomSelectById}
              handleDeleteRoom={handleDeleteRoom}
              handleRenameRoom={handleRenameRoom}
              clientId={clientId}
              username={username}
              isCodeAgentEnabled={featureFlags.codeAgent.enabled}
              onModalTaskStart={clearStatusForTask}
            />
          </div>
        );
      case "saved":
        return (
          <div className="h-full w-full overflow-y-auto"> {/* 占据全部可用空间 */}
            <SavedRoomList
              rooms={savedRooms}
              isLoading={isLoadingSavedRooms}
              onRoomSelect={handleRoomSelect}
              onUnsaveRoom={handleUnsaveRoom}
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
            isCodexConnectionsEnabled={featureFlags.codex.connections.enabled}
            isGitHubConnectionsEnabled={featureFlags.github.connections.enabled}
          />
        );
      case "chat": {
        if (!currentRoom) {
          return <WelcomeView onEnterRooms={() => handleViewChange("rooms")} />;
        }

        const codeAgentBackend = getCodeAgentBackend(currentRoom);
        if (codeAgentBackend) {
          return (
            <CodeAgentRoomView
              currentRoom={currentRoom}
              memberCount={memberCount}
              isRestoringRoom={isCurrentRoomSessionRestoring}
              showRoomSessionSpinner={isCurrentRoomSessionRestoring && (!roomSession.result || isReconnecting)}
              isRoomSessionReady={isCurrentRoomSessionReady}
              canUseRetainedRoomAccess={canUseRetainedRoomAccess}
              ensureRoomSessionReady={ensureRoomSessionReadyForOperation}
              messageSyncRequestId={roomSession.messageSyncRequestId}
              onRetryRoomSession={handleRetryRoomSession}
              onRoomUpdated={applyServerRoom}
              username={username}
              clientId={clientId}
              backend={codeAgentBackend}
              availableModes={getCodeAgentAvailableModes(featureFlags)}
              defaultMode={getCodeAgentDefaultMode(featureFlags)}
              handleCopyToClipboard={handleCopyToClipboard}
              handleShareRoom={handleShareRoom}
              handleToggleSave={handleToggleSave}
              handleLeaveRoom={handleLeaveRoom}
              isRoomSaved={isRoomSavedById}
              setView={handleViewChange}
              clearRoomUrlParam={clearRoomUrlParam}
              handleClearChatMessages={handleClearChatMessages}
              handleDeleteRoom={handleDeleteRoom}
              handleRenameRoom={handleRenameRoom}
              roomPermissions={roomPermissions}
              onMembersChanged={handleRoomPermissionsInvalidated}
              onRoomDeleted={applyRoomRemoval}
              onRoomAccessDenied={applyRoomRemoval}
            />
          );
        }

        return (
          <ChatRoomView
            currentRoom={currentRoom}
            memberCount={memberCount}
            isRestoringRoom={isCurrentRoomSessionRestoring}
            showRoomSessionSpinner={isCurrentRoomSessionRestoring && (!roomSession.result || isReconnecting)}
            isRoomSessionReady={isCurrentRoomSessionReady}
            canUseRetainedRoomAccess={canUseRetainedRoomAccess}
            ensureRoomSessionReady={ensureRoomSessionReadyForOperation}
            messageSyncRequestId={roomSession.messageSyncRequestId}
            onRetryRoomSession={handleRetryRoomSession}
            onRoomUpdated={applyServerRoom}
            username={username}
            clientId={clientId}
            handleCopyToClipboard={handleCopyToClipboard}
            handleShareRoom={handleShareRoom}
            handleToggleSave={handleToggleSave}
            handleLeaveRoom={handleLeaveRoom}
            isRoomSaved={isRoomSavedById}
            setView={handleViewChange}
            clearRoomUrlParam={clearRoomUrlParam}
            handleClearChatMessages={handleClearChatMessages}
            handleDeleteRoom={handleDeleteRoom}
            handleRenameRoom={handleRenameRoom}
            roomPermissions={roomPermissions}
            onMembersChanged={handleRoomPermissionsInvalidated}
            onRoomDeleted={applyRoomRemoval}
            onRoomAccessDenied={applyRoomRemoval}
          />
        );
      }
      default:
        return <WelcomeView onEnterRooms={() => handleViewChange("rooms")} />;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f5f4ed] text-[#141413] dark:bg-[#141413] dark:text-[#faf9f5]"> {/* 确保根容器是 flex 列且占满屏幕高度 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <DesktopSidebar
          clientId={clientId}
          username={username}
          view={view}
          setView={handleViewChange}
          rooms={rooms}
          savedRooms={savedRooms}
          isLoadingRooms={isLoadingRooms}
          isLoadingSavedRooms={isLoadingSavedRooms}
          currentRoom={currentRoom}
          i18n={i18n}
          changeLanguage={changeLanguage}
          toggleTheme={toggleTheme}
          isDark={isDark}
          handleCopyToClipboard={handleCopyToClipboard}
          onRoomSelect={handleRoomSelect}
          onRoomSelectById={handleRoomSelectById}
          onDeleteRoom={handleDeleteRoom}
          onUnsaveRoom={handleUnsaveRoom}
          onRenameRoom={handleRenameRoom}
          isCodeAgentEnabled={featureFlags.codeAgent.enabled}
          onModalTaskStart={clearStatusForTask}
        />

        {/* 主内容区域， flex-1 使其填充剩余空间，overflow-hidden 避免双重滚动条 */}
        <main aria-labelledby="main-view-title" className="flex min-h-0 min-w-0 flex-1 overflow-hidden md:min-w-[480px]">
          <h1 id="main-view-title" className="sr-only">{mainViewTitle}</h1>
          {renderContent()} {/* 渲染当前视图 */}
        </main>
      </div>

      <StatusMessage error={error} success={success} setError={setError} />

      {/* 底部导航栏 - 移除 view !== "settings" 条件 */}
      <BottomNav view={view} setView={handleViewChange} currentRoom={currentRoom} />

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
