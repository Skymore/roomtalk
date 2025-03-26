import React, { useState, useEffect } from 'react';
import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  Button,
  Tabs,
  Tab,
  Tooltip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Chip
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTheme } from '@heroui/use-theme';
import { MessageList } from '../components/MessageList';
import { MessageInput } from '../components/MessageInput';
import { RoomList } from '../components/RoomList';
import { SavedRoomList } from '../components/SavedRoomList';
import { socket, joinRoom, leaveRoom, getRoomById, clientId } from '../utils/socket';
import { Room } from '../utils/types';
import { saveRoom, removeRoom, isRoomSaved, getSavedRooms } from '../utils/storage';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

export const MessagePage: React.FC = () => {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";

  // 状态简化：不再单独存储 roomId 和 joined 状态
  const [rooms, setRooms] = useState<Room[]>([]);
  const [savedRooms, setSavedRooms] = useState<Room[]>([]);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [view, setView] = useState<'chat' | 'rooms' | 'saved'>('rooms');
  const [error, setError] = useState<string | null>(null);
  const [isLoadingRoom, setIsLoadingRoom] = useState(false);
  // 当 URL 参数包含房间时，先保存待确认的房间信息
  const [roomToJoin, setRoomToJoin] = useState<{ id: string; name: string } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [searchParams] = useSearchParams();

  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  // 工具函数：清除 URL 中的 room 参数
  const clearRoomUrlParam = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url);
  };

  // 初次加载时加载已保存房间
  useEffect(() => {
    setSavedRooms(getSavedRooms());
  }, []);

  // 当组件加载或 URL 参数变化时，如果 URL 包含 room 参数，则先加载房间信息并要求确认
  useEffect(() => {
    const roomIdFromUrl = searchParams.get('room');
    if (roomIdFromUrl && !currentRoom) {
      setIsLoadingRoom(true);
      getRoomById(roomIdFromUrl)
        .then(roomInfo => {
          setIsLoadingRoom(false);
          if (roomInfo) {
            // 始终要求用户确认后进入房间
            setRoomToJoin({ id: roomIdFromUrl, name: roomInfo.name });
          } else {
            setError(t('errorRoomNotFound', { roomId: roomIdFromUrl }));
          }
        })
        .catch(() => {
          setIsLoadingRoom(false);
          setError(t('errorLoading'));
        });
    }
  }, [searchParams, currentRoom, t]);

  // 监听服务器返回的房间列表和新增房间
  useEffect(() => {
    socket.on('room_list', (roomList: Room[]) => setRooms(roomList));
    socket.emit('get_rooms');
    socket.on('new_room', (room: Room) => setRooms(prev => [...prev, room]));
    return () => {
      socket.off('room_list');
      socket.off('new_room');
    };
  }, []);

  // 直接加入房间：点击房间卡片或确认弹窗后调用
  const handleRoomSelect = async (roomId: string) => {
    // 如果已经在其他房间，则先离开
    if (currentRoom && currentRoom.id !== roomId) {
      leaveRoom(currentRoom.id);
    }
    const roomInfo = await getRoomById(roomId);
    if (!roomInfo) {
      setError(t('errorRoomNotFound', { roomId }));
      return;
    }
    joinRoom(roomId);
    setCurrentRoom(roomInfo);
    // 进入房间时切换到聊天视图
    setView('chat');
    clearRoomUrlParam();
  };

  // URL 加载的房间确认操作
  const handleConfirmJoin = (confirmed: boolean) => {
    if (!confirmed || !roomToJoin) {
      setRoomToJoin(null);
      clearRoomUrlParam();
      return;
    }
    handleRoomSelect(roomToJoin.id);
    setRoomToJoin(null);
  };

  // 离开当前房间
  const handleLeaveRoom = () => {
    if (currentRoom) {
      leaveRoom(currentRoom.id);
      setCurrentRoom(null);
      // 离开房间后保持当前视图（例如 rooms 或 saved），也可以根据需要切换视图
    }
  };

  // 分享当前房间链接
  const handleShareRoom = () => {
    if (!currentRoom) return;
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('room', currentRoom.id);
    navigator.clipboard.writeText(url.toString())
      .then(() => {
        setError(null);
        setSuccess(t('shareSuccess'));
        setTimeout(() => setSuccess(null), 2000);
      })
      .catch(err => console.error('Could not copy URL:', err));
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

  return (
      <div className="flex flex-col h-screen">
        <Navbar isBordered maxWidth="full">
          <div className="w-full max-w-[1400px] mx-auto px-2 sm:px-8 flex justify-between items-center">
            <NavbarBrand>
              <img 
                src="/roomtalk-logo.svg" 
                alt="RoomTalk Logo" 
                className="w-10 h-10"
              />
              <p className="font-bold text-inherit ml-2">RoomTalk</p>
            </NavbarBrand>
            <NavbarContent justify="end">
              <div className="flex items-center gap-2">
                <Tooltip content={t('yourUserId')}>
                  <Chip
                    variant="flat"
                    color="primary"
                    size="sm"
                    className="sm:flex"
                  >
                    ID: {clientId.slice(0, 8)}
                  </Chip>
                </Tooltip>
                <LanguageSwitcher />
                <Button
                  isIconOnly
                  variant="light"
                  onPress={toggleTheme}
                  aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
                >
                  <Icon icon={isDark ? "lucide:sun" : "lucide:moon"} />
                </Button>
              </div>
            </NavbarContent>
          </div>
        </Navbar>

      {error && (
        <div className="bg-danger-100 p-3 text-danger">
          <div className="max-w-[1400px] mx-auto px-4 flex items-center gap-2">
            <Icon icon="lucide:alert-circle" />
            <p>{error}</p>
            <Button 
              size="sm" 
              variant="flat" 
              color="danger" 
              className="ml-auto"
              onPress={() => setError(null)}
            >
              {t('close')}
            </Button>
          </div>
        </div>
      )}

      {success && (
        <div className="bg-success-100 p-3 text-success">
          <div className="max-w-[1400px] mx-auto px-4 flex items-center gap-2">
            <Icon icon="lucide:check-circle" />
            <p>{success}</p>
          </div>
        </div>
      )}

      {/* Tab 切换：点击 rooms/saved 按钮仅切换视图，不影响已进入的房间 */}
      <div className="bg-default-100 border-b border-divider">
        <div className="max-w-[1400px] mx-auto px-4">
          <Tabs 
            selectedKey={view} 
            onSelectionChange={(key) => setView(key as 'chat' | 'rooms' | 'saved')}
            className="p-2"
          >
            <Tab key="rooms" title={t('yourRooms')} />
            <Tab key="saved" title={t('savedRooms')} />
            {currentRoom && (
              <Tab key="chat" title={
                <div className="flex items-center gap-2">
                  {currentRoom.name || t('room')}
                  <span>
                    <Icon icon="lucide:log-in" className="text-xs" />
                  </span>
                </div>
              } />
            )}
          </Tabs>
        </div>
      </div>

      <main className="flex-1 overflow-hidden bg-content1">
        <div className="max-w-[1400px] h-full mx-auto px-4">
          <div className="h-full bg-content1 rounded-lg flex flex-col">
            {isLoadingRoom ? (
              <div className="flex flex-col items-center justify-center h-full p-4">
                <Icon icon="lucide:loader" className="w-16 h-16 mb-4 text-primary animate-spin" />
                <h2 className="text-xl font-semibold mb-2">{t('loading')}</h2>
                <p className="text-default-500 text-center">{t('loadingDescription')}</p>
              </div>
            ) : view === 'rooms' ? (
              <RoomList rooms={rooms} onRoomSelect={handleRoomSelect} />
            ) : view === 'saved' ? (
              <SavedRoomList 
                rooms={savedRooms} 
                onRoomSelect={handleRoomSelect} 
                onRoomsChange={setSavedRooms}
              />
            ) : (
              // Chat 视图
              currentRoom ? (
                <div className="flex flex-col h-full">
                  <div className="p-4">
                    <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
                      {/* 房间信息卡片 */}
                      <div className="flex-1">
                        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-default-600">
                          <div className="flex items-center gap-1">
                            <Icon icon="lucide:hash" className="text-xs" />
                            <Chip size="sm" color="primary" variant="flat">{currentRoom.id}</Chip>
                          </div>
                          <div className="flex items-center gap-1">
                            <Icon icon="lucide:user" className="text-xs" />
                            {currentRoom.creatorId === clientId ? (
                              <Chip size="sm" color="success" variant="flat">{t('createdBy')}</Chip>
                            ) : (
                              <Chip size="sm" color="success" variant="flat">{t('joined')}</Chip>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      {/* 操作按钮组 */}
                      <div className="flex gap-2">
                        <Button 
                          size="sm" 
                          color="secondary" 
                          variant="flat"
                          onPress={handleShareRoom}
                          startContent={<Icon icon="lucide:share" />}
                        >
                          {t('share')}
                        </Button>
                        <Button 
                          size="sm" 
                          color={isRoomSaved(currentRoom.id) ? "warning" : "primary"} 
                          variant="flat"
                          onPress={handleToggleSave}
                          startContent={<Icon icon={isRoomSaved(currentRoom.id) ? "lucide:bookmark-minus" : "lucide:bookmark-plus"} />}
                        >
                          {isRoomSaved(currentRoom.id) ? t('unsave') : t('save')}
                        </Button>
                        <Button 
                          size="sm" 
                          color="danger" 
                          variant="flat"
                          onPress={handleLeaveRoom}
                          startContent={<Icon icon="lucide:log-out" />}
                        >
                          {t('leave')}
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <MessageList roomId={currentRoom.id} />
                  </div>
                </div>
              ) : (
                // 欢迎页面
                <div className="flex flex-col items-center justify-center h-full p-4">
                  <Icon icon="lucide:message-circle" className="w-16 h-16 mb-4 text-default-400" />
                  <h2 className="text-xl font-semibold mb-2">{t('welcomeMessage')}</h2>
                  <p className="text-default-500 mb-6 text-center">{t('welcomeDescription')}</p>
                  <Button 
                    color="primary" 
                    onPress={() => setView('rooms')}
                    startContent={<Icon icon="lucide:users" />}
                  >
                    {t('yourRooms')}
                  </Button>
                </div>
              )
            )}
          </div>
        </div>
      </main>

      <footer className="bg-content1 border-t border-divider">
        <div className="max-w-[1400px] mx-auto px-4">
          {currentRoom && view === 'chat' && <MessageInput roomId={currentRoom.id} />}
        </div>
      </footer>

      {/* URL 加载房间时的确认弹窗 */}
      {roomToJoin && (
        <Modal isOpen={!!roomToJoin} onClose={() => handleConfirmJoin(false)}>
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">{t('confirmJoinTitle')}</ModalHeader>
            <ModalBody>
              <p>{t('confirmJoinDescription', { roomName: roomToJoin.name })}</p>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={() => handleConfirmJoin(false)}>
                {t('cancel')}
              </Button>
              <Button color="primary" onPress={() => handleConfirmJoin(true)}>
                {t('join')}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </div>
  );
};
