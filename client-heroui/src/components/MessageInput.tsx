import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Button,
  Card,
  useDisclosure,
} from "@heroui/react";
import { Icon } from '@iconify/react';
import { requestAIResponse, sendMessage, sendMessageAndAskAI } from '../utils/socket';
import { useTranslation } from 'react-i18next';
import imageCompression from 'browser-image-compression';
import {
  buildAIPrompt,
  buildOutgoingMessageItems,
  emptyMessageContent,
  hasMessageContent,
  MessageContentItem,
} from '../utils/messageInputState';
import {
  getAvailableImageSlots,
  getFirstClipboardImageFile,
  hasClipboardImageItem,
  ImageInputValidationError,
  MAX_MESSAGE_IMAGES,
  PASTE_RESET_IDLE_MS,
  shouldResetPasteCount,
  shouldThrottlePaste,
  validateImageFile,
} from '../utils/imageInput';
import { useAIRoles } from '../hooks/useAIRoles';
import { useAIModelSelection } from '../hooks/useAIModelSelection';
import { MessageInputAIControls, MessageInputAISettingsButton } from './MessageInputAIControls';
import {
  getKeyboardCompositionSnapshot,
  isConfirmingIMEComposition,
} from '../utils/keyboardComposition';
import { Message } from '../utils/types';

interface MessageInputProps {
  roomId: string;
  clientId: string;
  username: string;
  avatarText: string;
  avatarColor: string;
  replyToMessage: Message | null;
  onCancelReply: () => void;
  onOptimisticMessage?: (message: Message) => void;
  onOptimisticMessageSaved?: (clientMessageId: string, message: Message) => void;
  onOptimisticMessageFailed?: (clientMessageId: string, error?: string) => void;
}

// 使用WeakMap存储图片元素和对应的File对象
const imageFileMap = new WeakMap<HTMLImageElement, File>();

const createClientMessageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getErrorMessage = (error: unknown, fallback: string) => (
  error instanceof Error ? error.message : fallback
);

export const MessageInput: React.FC<MessageInputProps> = ({
  roomId,
  clientId,
  username,
  avatarText,
  avatarColor,
  replyToMessage,
  onCancelReply,
  onOptimisticMessage,
  onOptimisticMessageSaved,
  onOptimisticMessageFailed,
}) => {
  const { t } = useTranslation();
  const [_contentItems, setContentItems] = useState<MessageContentItem[]>(emptyMessageContent());
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [imageCount, setImageCount] = useState(0);
  const [currentInputText, setCurrentInputText] = useState('');
  const imageCountRef = useRef(0); // 用于实时跟踪图片数量，避免状态更新延迟
  const lastPasteTime = useRef(0); // 用于限制粘贴频率
  const pasteCountRef = useRef(0); // 用于跟踪连续粘贴次数
  const pasteResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const [isAiProcessing, setIsAiProcessing] = useState(false); // 新增: 跟踪 AI 处理状态

  // Voice recording state
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const MAX_RECORDING_SECONDS = 60;

  // 检测是否为移动设备
  const [_isMobile, setIsMobile] = useState(false);
  // 检测操作系统类型
  const [isMacOS, setIsMacOS] = useState(false);

  // 检测设备和操作系统类型
  useEffect(() => {
    // 检测移动设备
    const checkMobile = () => {
      const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
      return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent.toLowerCase());
    };

    // 检测 macOS
    const checkMacOS = () => {
      return navigator.platform.toLowerCase().includes('mac');
    };

    setIsMobile(checkMobile());
    setIsMacOS(checkMacOS());
  }, []);

  const {
    aiRoles,
    selectedRoleId,
    selectedRole,
    handleRoleChange,
    handleAddRole,
    handleUpdateRole,
    handleDeleteRole,
  } = useAIRoles();
  const {
    aiModels,
    defaultAIModel,
    selectedAIModel,
    handleModelChange,
  } = useAIModelSelection();

  // 新增角色设置模态框的状态
  const { isOpen: isAISettingsOpen, onOpen: onAISettingsOpen, onClose: onAISettingsClose } = useDisclosure();

  const buildReplyReference = useCallback((message: Message | null): Message['replyTo'] => {
    if (!message) return undefined;

    const preview = message.messageType === 'image'
      ? t('sharedImage')
      : message.content.replace(/\s+/g, ' ').trim().slice(0, 120) || '[Empty message]';

    return {
      messageId: message.id,
      username: message.username,
      messageType: message.messageType,
      preview,
    };
  }, [t]);

  const buildOptimisticTextMessage = useCallback((
    content: string,
    clientMessageId: string,
    avatar: { text: string; color: string },
    replyTo: Message | null,
  ): Message => ({
    id: `temp-${clientMessageId}`,
    clientMessageId,
    clientId,
    roomId,
    content,
    timestamp: new Date().toISOString(),
    messageType: 'text',
    username,
    avatar,
    replyTo: buildReplyReference(replyTo),
    deliveryStatus: 'pending',
  }), [buildReplyReference, clientId, roomId, username]);

  const clearEditorImmediately = useCallback((options: { blur?: boolean } = {}) => {
    if (editorRef.current) {
      const images = editorRef.current.querySelectorAll('img');
      images.forEach(img => {
        if (img.src.startsWith('blob:')) {
          URL.revokeObjectURL(img.src);
        }
      });
      editorRef.current.innerHTML = '';
      if (options.blur) {
        editorRef.current.blur();
      }
    }

    setContentItems(emptyMessageContent());
    setImageCount(0);
    imageCountRef.current = 0;
    setCurrentInputText('');
    setErrorMessage(null);
  }, []);

  // 将编辑器内容解析为ContentItem数组
  const parseEditorContent = useCallback((): MessageContentItem[] => {
    const editor = editorRef.current;
    if (!editor) return emptyMessageContent();

    // 暂存解析结果
    const newItems: MessageContentItem[] = [];
    let images = 0;

    // 遍历所有子节点
    editor.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        // 文本节点
        if (node.textContent && node.textContent.trim() !== '') {
          newItems.push({ type: 'text', content: node.textContent });
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        if (element.tagName === 'IMG') {
          // 图片节点
          const img = element as HTMLImageElement;
          if (images < MAX_MESSAGE_IMAGES) {
            const file = imageFileMap.get(img);
            if (file) {
              newItems.push({
                type: 'image',
                content: img.src,
                previewUrl: img.src,
                file: file
              });
            } else {
              newItems.push({ type: 'image', content: img.src });
            }
            images++;
          } else if (element.parentNode) {
            // 如果超出最大图片数，移除多余图片
            if (img.src.startsWith('blob:')) {
              URL.revokeObjectURL(img.src);
              imageFileMap.delete(img);
            }
            element.parentNode.removeChild(element);
          }
        } else if (element.tagName === 'DIV' || element.tagName === 'P') {
          // 段落节点，可能包含文本
          if (element.textContent && element.textContent.trim() !== '') {
            newItems.push({ type: 'text', content: element.textContent });
          }
        }
      }
    });

    // 确保至少有一个文本项
    if (newItems.length === 0) {
      newItems.push(...emptyMessageContent());
    }

    // 更新内容项状态
    setContentItems(newItems);
    return newItems;
  }, []);

  // 清除错误信息的定时器
  useEffect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        setErrorMessage(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [errorMessage]);

  // 同步imageCountRef和imageCount
  useEffect(() => {
    imageCountRef.current = imageCount;
  }, [imageCount]);

  // 监听编辑器内容变化
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const syncEditorState = () => {
      setCurrentInputText(editor.innerText || '');

      const currentImageCount = editor.querySelectorAll('img').length;
      if (currentImageCount !== imageCountRef.current) {
        imageCountRef.current = currentImageCount;
        setImageCount(currentImageCount);
      }

      parseEditorContent();
    };

    // 使用MutationObserver监听DOM变化，更准确地捕获图片添加/删除
    const observer = new MutationObserver(syncEditorState);

    observer.observe(editor, {
      childList: true,
      subtree: true,
      characterData: true
    });

    editor.addEventListener('input', syncEditorState);
    syncEditorState();

    return () => {
      observer.disconnect();
      editor.removeEventListener('input', syncEditorState);
    };
  }, [parseEditorContent]);

  // 发送AI消息的新方法
  const handleAskAI = async () => {
    const latestContentItems = parseEditorContent();

    if (isSending || isAiProcessing) return;

    let optimisticClientMessageId: string | null = null;
    setIsAiProcessing(true);
    try {
      // 创建头像信息对象
      const avatar = { text: avatarText, color: avatarColor };

      const prompt = buildAIPrompt(latestContentItems);

      if (!prompt) {
        await requestAIResponse({
          roomId,
          systemPrompt: selectedRole.systemPrompt,
          roleName: selectedRole.name,
          model: selectedAIModel || defaultAIModel
        });
        return;
      }

      const clientMessageId = createClientMessageId();
      optimisticClientMessageId = clientMessageId;
      const optimisticMessage = buildOptimisticTextMessage(prompt, clientMessageId, avatar, replyToMessage);
      onOptimisticMessage?.(optimisticMessage);
      clearEditorImmediately({ blur: true });

      const { userMessage } = await sendMessageAndAskAI({
        roomId,
        content: prompt,
        username,
        avatar,
        replyToMessageId: replyToMessage?.id,
        clientMessageId,
        systemPrompt: selectedRole.systemPrompt,
        roleName: selectedRole.name,
        model: selectedAIModel || defaultAIModel,
      });

      onOptimisticMessageSaved?.(clientMessageId, userMessage);
      onCancelReply();
      console.log('Sent AI request (without prompt) with role and model:', selectedRole.name, selectedAIModel || defaultAIModel);

    } catch (error) {
      console.error('Error sending AI request:', error);
      if (optimisticClientMessageId) {
        onOptimisticMessageFailed?.(optimisticClientMessageId, getErrorMessage(error, t('errorSendingAiRequest')));
      }
      setErrorMessage(t('errorSendingAiRequest'));
    } finally {
      setIsAiProcessing(false);
    }
  };

  // Handle regular message submission
  const handleSubmit = async () => {
    // Parse latest content (might be redundant if useEffect handles it well)
    const latestContentItems = parseEditorContent();

    if (!hasMessageContent(latestContentItems) || isSending || isAiProcessing) return;

    const avatar = { text: avatarText, color: avatarColor };
    const outgoingItems = buildOutgoingMessageItems(latestContentItems);
    const singleTextItem =
      outgoingItems.length === 1 && outgoingItems[0].type === 'text'
        ? outgoingItems[0]
        : null;

    if (singleTextItem) {
      const clientMessageId = createClientMessageId();
      const optimisticMessage = buildOptimisticTextMessage(singleTextItem.content, clientMessageId, avatar, replyToMessage);

      onOptimisticMessage?.(optimisticMessage);
      clearEditorImmediately();
      onCancelReply();

      sendMessage(singleTextItem.content, roomId, 'text', username, avatar, replyToMessage?.id, clientMessageId)
        .then((savedMessage) => {
          onOptimisticMessageSaved?.(clientMessageId, savedMessage);
        })
        .catch((error) => {
          console.error('Error sending message:', error);
          onOptimisticMessageFailed?.(clientMessageId, getErrorMessage(error, t('errorSendingMessage')));
          setErrorMessage(t('errorSendingMessage'));
        });

      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = setTimeout(() => {
        editorRef.current?.focus();
        focusTimerRef.current = null;
      }, 0);
      return;
    }

    setIsSending(true);
    try {
      let replyToMessageId = replyToMessage?.id;

      for (const item of outgoingItems) {
        if (item.type === 'text') {
          await sendMessage(item.content, roomId, 'text', username, avatar, replyToMessageId);
          if (replyToMessageId) {
            replyToMessageId = undefined;
            onCancelReply();
          }
        } else {
          try {
            // 压缩图片
            const options = {
              maxSizeMB: 2,
              useWebWorker: true
            };

            const compressedFile = await imageCompression(item.file, options);

            // 将压缩后的文件转换为Base64
            const reader = new FileReader();
            const base64Promise = new Promise<string>((resolve, reject) => {
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(compressedFile);
            });

            const base64String = await base64Promise;

            // 发送压缩后的图片
            await sendMessage(base64String, roomId, 'image', username, avatar, replyToMessageId);
            if (replyToMessageId) {
              replyToMessageId = undefined;
              onCancelReply();
            }

            // 如果有预览URL，释放它
            if (item.previewUrl) {
              URL.revokeObjectURL(item.previewUrl);
            }
          } catch (error) {
            console.error('Error compressing image:', error);
            setErrorMessage(t('errorCompressingImage'));
          }
        }
      }

      clearEditorImmediately();
      setErrorMessage(null);

    } catch (error) {
      console.error('Error sending message:', error);
      setErrorMessage(t('errorSendingMessage'));
    } finally {
      setIsSending(false);
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = setTimeout(() => {
        editorRef.current?.focus();
        focusTimerRef.current = null;
      }, 0);
    }
  };

  const setImageInputError = (error: ImageInputValidationError) => {
    if (error.errorKey === 'maxImagesReached') {
      setErrorMessage(t(error.errorKey, { max: error.max ?? MAX_MESSAGE_IMAGES }));
      return;
    }

    setErrorMessage(t(error.errorKey));
  };

  // Voice recording handlers
  const startRecording = useCallback(async () => {
    if (isRecording || isSending) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size < 1000) return; // too short, ignore
        setIsSending(true);
        try {
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const avatar = { text: avatarText, color: avatarColor };
          await sendMessage(base64, roomId, 'voice', username, avatar);
        } catch {
          setErrorMessage(t('errorSendingMessage'));
        } finally {
          setIsSending(false);
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds(prev => {
          if (prev >= MAX_RECORDING_SECONDS - 1) {
            stopRecording();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } catch {
      setErrorMessage(t('errorMicPermission'));
    }
  }, [avatarColor, avatarText, isRecording, isSending, roomId, t, username]);

  const stopRecording = useCallback(() => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setRecordingSeconds(0);
  }, []);

  // 处理图片上传
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // 使用ref获取当前实际图片数量
    const currentImageCount = imageCountRef.current;
    // 检查图片数量限制
    const availableSlots = getAvailableImageSlots(currentImageCount);

    if (availableSlots <= 0) {
      setImageInputError({ errorKey: 'maxImagesReached', max: MAX_MESSAGE_IMAGES });
      return;
    }

    // 处理多个文件，最多处理剩余可用槽位数量的图片
    Array.from(files).slice(0, availableSlots).forEach(file => {
      processImageFile(file);
    });
  };

  // 处理图片文件 - 优化性能
  const processImageFile = (file: File) => {
    const validation = validateImageFile(file, imageCountRef.current);
    if (!validation.ok) {
      setImageInputError(validation.error);
      return;
    }

    // 创建预览URL
    const previewUrl = URL.createObjectURL(file);

    // 创建并插入图片元素
    if (imageCountRef.current < MAX_MESSAGE_IMAGES) {
      insertImageToEditor(previewUrl, file);

      // 重置文件输入
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 向编辑器插入图片 - 优化性能
  const insertImageToEditor = (previewUrl: string, file: File) => {
    const editor = editorRef.current;
    if (!editor) return;

    // 再次检查图片数量限制
    if (imageCountRef.current >= MAX_MESSAGE_IMAGES) {
      setImageInputError({ errorKey: 'maxImagesReached', max: MAX_MESSAGE_IMAGES });
      return;
    }

    // 更新内部引用计数
    imageCountRef.current += 1;

    const img = document.createElement('img');
    img.src = previewUrl;
    img.className = 'max-w-32 max-h-32 inline-block object-contain m-1 align-middle';

    // 将File对象存储在WeakMap中
    imageFileMap.set(img, file);

    // 获取当前选中区域并插入图片
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (range) {
      // 插入图片到选中位置
      range.insertNode(img);

      // 将光标移动到图片后面
      range.setStartAfter(img);
      range.setEndAfter(img);
      selection?.removeAllRanges();
      selection?.addRange(range);

      // 插入一个空格以便继续输入文字
      const space = document.createTextNode('\u00A0');
      range.insertNode(space);
      range.setStartAfter(space);
      range.setEndAfter(space);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      // 如果没有选区，追加到编辑器末尾
      editor.appendChild(img);

      // 添加空格
      const space = document.createTextNode('\u00A0');
      editor.appendChild(space);

      // 将光标设置到图片后
      const newRange = document.createRange();
      newRange.setStartAfter(space);
      newRange.setEndAfter(space);
      selection?.removeAllRanges();
      selection?.addRange(newRange);
    }

    // 同步更新状态
    setImageCount(imageCountRef.current);
  };

  // 处理粘贴事件 - 防止快速粘贴和同步更新计数
  const handlePaste = (e: React.ClipboardEvent) => {
    // 限制粘贴频率
    const now = Date.now();
    if (shouldThrottlePaste(now, lastPasteTime.current, pasteCountRef.current)) {
      e.preventDefault();
      return;
    }
    lastPasteTime.current = now;

    // 更新粘贴计数
    pasteCountRef.current += 1;

    // 设置自动重置粘贴计数的定时器（如果2秒内没有新的粘贴，重置计数）
    if (pasteResetTimerRef.current) {
      clearTimeout(pasteResetTimerRef.current);
    }
    pasteResetTimerRef.current = setTimeout(() => {
      if (shouldResetPasteCount(Date.now(), lastPasteTime.current)) {
        pasteCountRef.current = 0;
      }
    }, PASTE_RESET_IDLE_MS);

    const clipboardItems = Array.from(e.clipboardData.items);

    // 检查是否达到图片数量上限 - 使用ref实时获取
    if (imageCountRef.current >= MAX_MESSAGE_IMAGES) {
      // 如果有图片类型内容，显示提示
      if (hasClipboardImageItem(clipboardItems)) {
        e.preventDefault();
        setImageInputError({ errorKey: 'maxImagesReached', max: MAX_MESSAGE_IMAGES });
        return;
      }

      // 只允许粘贴文本
      const text = e.clipboardData.getData('text/plain');
      if (text) {
        document.execCommand('insertText', false, text);
        e.preventDefault();
      }
      return;
    }

    const imageFile = getFirstClipboardImageFile(clipboardItems);
    const hasProcessedImage = Boolean(imageFile);
    if (imageFile) {
      e.preventDefault();
      processImageFile(imageFile);
    }

    // 如果没有处理图片，则使用默认行为处理文本
    if (!hasProcessedImage) {
      // 获取纯文本
      const text = e.clipboardData.getData('text/plain');
      if (text) {
        // 使用execCommand插入文本，保持简单
        document.execCommand('insertText', false, text);
        e.preventDefault();
      }
    }
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    lastCompositionEndAtRef.current = Date.now();
    parseEditorContent();
  };

  // 处理回车事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isConfirmingIMEComposition(getKeyboardCompositionSnapshot(
        e,
        isComposingRef.current,
        lastCompositionEndAtRef.current
      ))) {
        return;
      }

      // Shift+Enter: 默认行为（换行）
      if (e.shiftKey) {
        return; // 允许默认的换行行为
      }
      // Mac用Command+Enter, Windows用Ctrl+Enter: 询问AI
      else if ((isMacOS && e.metaKey) || (!isMacOS && e.ctrlKey)) {
        e.preventDefault();
        handleAskAI();
      }
      // 单独Enter: 发送消息
      else {
        e.preventDefault();
        handleSubmit();
      }
    }
  };

  // 在组件卸载或输入框失去焦点时重置粘贴计数
  useEffect(() => {
    const resetPasteCount = () => {
      pasteCountRef.current = 0;
    };

    // 监听窗口焦点变化，重置粘贴计数
    window.addEventListener('blur', resetPasteCount);

    return () => {
      window.removeEventListener('blur', resetPasteCount);
      if (pasteResetTimerRef.current) {
        clearTimeout(pasteResetTimerRef.current);
      }
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
      }
    };
  }, [parseEditorContent]);

  const replySenderName = replyToMessage?.username
    || (replyToMessage?.messageType === 'ai' ? t('aiAssistantName') : t('participant'));
  const replyPreview = replyToMessage?.messageType === 'image'
    ? t('sharedImage')
    : replyToMessage?.content.replace(/\s+/g, ' ').trim().slice(0, 120);

  return (
    <div className="relative">
      {/* 错误消息显示 */}
      {errorMessage && (
        <div className="absolute -top-10 left-0 right-0 flex justify-center">
          <Card className="px-3 py-1.5 text-xs text-danger bg-danger-100 shadow-[0_0_0_1px_rgba(181,51,51,0.18)]">
            <Icon icon="lucide:alert-circle" className="inline-block mr-1 text-xs" />{errorMessage}
          </Card>
        </div>
      )}

      <div className="w-full pb-0.5">
        <div className="flex flex-wrap items-center gap-1.5 overflow-hidden rounded-[1.45rem] border border-[#dedbd0] bg-[#faf9f5] px-1.5 py-1.5 shadow-[0_0_0_1px_rgba(194,192,182,0.35)] dark:border-[#30302e] dark:bg-[#2a2a28] sm:block sm:rounded-[1.65rem] sm:px-0 sm:py-0">
          {replyToMessage && (
            <div className="mx-0 flex basis-full items-start gap-2 rounded-md border-l-2 border-[#c96442] bg-[#f0eee6] px-2.5 py-2 text-xs text-[#5e5d59] dark:bg-[#242421] dark:text-[#b0aea5] sm:mx-3 sm:mt-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{t('replyingTo', { name: replySenderName })}</div>
                <div className="truncate">{replyPreview}</div>
              </div>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label={t('cancelReply')}
                className="h-6 w-6 min-w-6 text-[#5e5d59] dark:text-[#b0aea5]"
                onPress={onCancelReply}
              >
                <Icon icon="lucide:x" className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {isVoiceMode ? (
            /* ===== Voice mode: hold-to-speak button ===== */
            <div className="flex min-h-9 min-w-0 flex-1 items-center justify-center px-2.5 py-1.5 sm:min-h-16 sm:px-4 sm:pb-2 sm:pt-4">
              <button
                type="button"
                aria-label={isRecording ? t('releaseToSend') : t('holdToSpeak')}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startRecording(); }}
                onPointerUp={stopRecording}
                onPointerLeave={stopRecording}
                onContextMenu={(e) => e.preventDefault()}
                disabled={isSending}
                className={`w-full select-none rounded-2xl py-3 text-sm font-medium transition-colors ${
                  isRecording
                    ? 'bg-[#c96442] text-white dark:bg-[#d97757]'
                    : 'bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#b0aea5]'
                } ${isSending ? 'opacity-50' : ''}`}
              >
                {isRecording
                  ? `${t('releaseToSend')} · ${recordingSeconds}s`
                  : t('holdToSpeak')}
              </button>
            </div>
          ) : (
            /* ===== Text mode: normal editor ===== */
            <div
              className="min-h-9 max-h-28 min-w-0 flex-1 overflow-y-auto px-2.5 py-1.5 text-base leading-6 text-[#141413] dark:text-[#faf9f5] sm:min-h-16 sm:max-h-36 sm:w-full sm:flex-none sm:px-4 sm:pb-2 sm:pt-4 sm:text-sm"
              contentEditable={!isSending && !isAiProcessing}
              onInput={parseEditorContent}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              ref={editorRef}
              data-placeholder={isAiProcessing ? t('aiProcessing') : t('typeMessageHere')}
              style={{ lineHeight: '1.5', whiteSpace: 'pre-wrap' }}
              role="textbox"
              data-testid="message-editor"
              aria-label={t('messageInput')}
              aria-multiline="true"
              title={`${t('messageInput')} (Enter: ${t('send')}, Shift+Enter: ${t('newLine')}, ${isMacOS ? 'Command+Enter' : 'Ctrl+Enter'}: ${t('askAI')})`}
            ></div>
          )}

          <div className="flex min-h-9 flex-shrink-0 items-center gap-1 px-0 pb-0 sm:min-h-12 sm:gap-2 sm:px-3 sm:pb-2">
            {/* 语音/键盘切换按钮 */}
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={isVoiceMode ? t('keyboardInput') : t('voiceInput')}
              className="h-8 w-8 min-w-8 rounded-full text-[#5e5d59] dark:text-[#b0aea5] sm:h-9 sm:w-9 sm:min-w-9"
              onPress={() => { setIsVoiceMode(v => !v); if (isRecording) stopRecording(); }}
              isDisabled={isSending || isAiProcessing}
            >
              <Icon icon={isVoiceMode ? 'lucide:keyboard' : 'lucide:mic'} className="h-4 w-4 sm:h-5 sm:w-5" />
            </Button>

            {!isVoiceMode && (
              <>
                {/* 图片上传按钮 */}
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={t('uploadImage')}
                  className="h-8 w-8 min-w-8 rounded-full text-[#5e5d59] dark:text-[#b0aea5] sm:h-9 sm:w-9 sm:min-w-9"
                  onPress={() => fileInputRef.current?.click()}
                  isDisabled={imageCount >= MAX_MESSAGE_IMAGES || isSending || isAiProcessing}
                >
                  <Icon icon="lucide:plus" className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>

                {/* AI设置按钮 */}
                <MessageInputAISettingsButton
                  onOpen={onAISettingsOpen}
                  isDisabled={isSending || isAiProcessing}
                />
              </>
            )}

            {/* 隐藏的文件输入 */}
            <input
              type="file"
              data-testid="image-upload-input"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              multiple={true}
              onChange={handleImageUpload}
              disabled={isSending || isAiProcessing}
            />

            {/* AI角色选择和发送按钮区 (text mode only) */}
            {!isVoiceMode && (
              <MessageInputAIControls
                roles={aiRoles}
                selectedRoleId={selectedRoleId}
                selectedRole={selectedRole}
                aiModels={aiModels}
                selectedAIModel={selectedAIModel}
                defaultAIModel={defaultAIModel}
                isSending={isSending}
                isAiProcessing={isAiProcessing}
                isMacOS={isMacOS}
                currentInputText={currentInputText}
                imageCount={imageCount}
                isSettingsOpen={isAISettingsOpen}
                onSettingsClose={onAISettingsClose}
                onRoleChange={handleRoleChange}
                onModelChange={handleModelChange}
                onAddRole={handleAddRole}
                onUpdateRole={handleUpdateRole}
                onDeleteRole={handleDeleteRole}
                onAskAI={handleAskAI}
                onSend={handleSubmit}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
