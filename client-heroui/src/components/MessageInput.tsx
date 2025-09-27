import React, { useState, useRef, useEffect } from 'react';
import {
  Button,
  Card,
  Tooltip,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Select,
  SelectItem,
  Tabs,
  Tab,
} from "@heroui/react";
import { Icon } from '@iconify/react';
import { sendMessage, socket } from '../utils/socket';
import { useTranslation } from 'react-i18next';
import imageCompression from 'browser-image-compression';
import { AIRole, AIRoleManager, getSavedAIRoles, saveAIRoles } from './AIRoleManager';

interface MessageInputProps {
  roomId: string;
  username: string;
  avatarText: string;
  avatarColor: string;
}

// 消息内容项类型
type ContentItem = {
  type: 'text' | 'image';
  content: string;
  file?: File;  // 添加file字段用于存储原始文件
  previewUrl?: string;  // 添加previewUrl字段用于存储预览URL
};

// 使用WeakMap存储图片元素和对应的File对象
const imageFileMap = new WeakMap<HTMLImageElement, File>();

export const MessageInput: React.FC<MessageInputProps> = ({ roomId, username, avatarText, avatarColor }) => {
  const { t } = useTranslation();
  const [contentItems, setContentItems] = useState<ContentItem[]>([{ type: 'text', content: '' }]);
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [imageCount, setImageCount] = useState(0);
  const imageCountRef = useRef(0); // 用于实时跟踪图片数量，避免状态更新延迟
  const lastPasteTime = useRef(0); // 用于限制粘贴频率
  const pasteCountRef = useRef(0); // 用于跟踪连续粘贴次数
  const MAX_IMAGES = 9;
  const INITIAL_PASTE_THROTTLE_MS = 200; // 首次粘贴间隔限制(毫秒)
  const SUBSEQUENT_PASTE_THROTTLE_MS = 50; // 后续粘贴间隔限制(毫秒)
  const [isAiProcessing, setIsAiProcessing] = useState(false); // 新增: 跟踪 AI 处理状态
  
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

  // 新增 AI 角色相关状态
  const [aiRoles, setAiRoles] = useState<AIRole[]>(getSavedAIRoles());
  const [selectedRoleId, setSelectedRoleId] = useState<string>('default');
  
  // 新增角色设置模态框的状态
  const { isOpen: isAISettingsOpen, onOpen: onAISettingsOpen, onClose: onAISettingsClose } = useDisclosure();

  // 在组件加载时从本地存储获取AI角色
  useEffect(() => {
    setAiRoles(getSavedAIRoles());
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

    const handleInput = () => {
      // 提取编辑器内容，转换为ContentItem数组
      parseEditorContent();
    };

    // 使用MutationObserver监听DOM变化，更准确地捕获图片添加/删除
    const observer = new MutationObserver(() => {
      // 直接计算当前编辑器中的图片数量
      const currentImageCount = editor.querySelectorAll('img').length;
      
      // 如果图片数量变化，立即更新
      if (currentImageCount !== imageCountRef.current) {
        imageCountRef.current = currentImageCount;
        setImageCount(currentImageCount);
      }
      
      // 更新内容项
      parseEditorContent();
    });
    
    observer.observe(editor, { 
      childList: true, 
      subtree: true,
      characterData: true
    });

    editor.addEventListener('input', handleInput);
    return () => {
      observer.disconnect();
      editor.removeEventListener('input', handleInput);
    };
  }, []);

  // 将编辑器内容解析为ContentItem数组
  const parseEditorContent = () => {
    const editor = editorRef.current;
    if (!editor) return;

    // 暂存解析结果
    const newItems: ContentItem[] = [];
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
          if (images < MAX_IMAGES) {
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
      newItems.push({ type: 'text', content: '' });
    }
    
    // 更新内容项状态
    setContentItems(newItems);
  };

  // 获取当前选中的AI角色
  const getSelectedRole = (): AIRole => {
    return aiRoles.find(role => role.id === selectedRoleId) || aiRoles[0];
  };

  // 处理AI角色变更
  const handleRoleChange = (roleId: string) => {
    setSelectedRoleId(roleId);
  };

  // 添加新的AI角色
  const handleAddRole = (newRole: AIRole) => {
    const updatedRoles = [...aiRoles, newRole];
    setAiRoles(updatedRoles);
    saveAIRoles(updatedRoles);
    setSelectedRoleId(newRole.id);
  };

  // 更新现有AI角色
  const handleUpdateRole = (updatedRole: AIRole) => {
    const updatedRoles = aiRoles.map(role => 
      role.id === updatedRole.id ? updatedRole : role
    );
    setAiRoles(updatedRoles);
    saveAIRoles(updatedRoles);
  };

  // 删除AI角色
  const handleDeleteRole = (roleId: string) => {
    // 不允许删除所有角色，至少保留一个
    if (aiRoles.length <= 1) return;
    
    const updatedRoles = aiRoles.filter(role => role.id !== roleId);
    setAiRoles(updatedRoles);
    saveAIRoles(updatedRoles);
    
    // 如果删除的是当前选中的角色，则选择第一个角色
    if (roleId === selectedRoleId) {
      setSelectedRoleId(updatedRoles[0].id);
    }
  };

  // 发送AI消息的新方法
  const handleAskAI = async () => {
    parseEditorContent();
    
    // 检查是否有内容可发送
    const hasContent = contentItems.some(item => 
      (item.type === 'text' && item.content.trim() !== '') || 
      item.type === 'image'
    );
    
    if (!hasContent) return;
    
    setIsAiProcessing(true);
    try {
      // 创建头像信息对象
      const avatar = { text: avatarText, color: avatarColor };
      
      // 收集所有文本内容
      let prompt = contentItems
        .filter(item => item.type === 'text')
        .map(item => item.content.trim())
        .filter(content => content !== '')
        .join('\n');
      
      if (!prompt) {
        setErrorMessage(t('emptyPrompt'));
        return;
      }
      
      // 获取选中的AI角色
      const selectedRole = getSelectedRole();
      
      // 发送用户问题作为普通消息
      sendMessage(prompt, roomId, 'text', username, avatar);
      
      // 触发AI请求，发送带角色信息的请求
      socket.emit('ask_ai', { 
        roomId, 
        prompt,
        systemPrompt: selectedRole.systemPrompt,
        roleName: selectedRole.name 
      });
      
      console.log('Sent AI request with role:', selectedRole.name);
      
      // 清空编辑器
      if (editorRef.current) {
        // 释放所有预览URL
        const images = editorRef.current.querySelectorAll('img');
        images.forEach(img => {
          if (img.src.startsWith('blob:')) {
            URL.revokeObjectURL(img.src);
          }
        });
        
        editorRef.current.innerHTML = '';
      }
      
      // 重置状态
      setContentItems([{ type: 'text', content: '' }]);
      setImageCount(0);
      imageCountRef.current = 0;
      
    } catch (error) {
      console.error('Error sending AI request:', error);
      setErrorMessage(t('errorSendingAiRequest'));
    } finally {
      setIsAiProcessing(false);
    }
  };

  // 修改原来的handleSubmit方法，移除AI请求相关的代码
  // 只保留普通消息的发送逻辑
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // 解析最新内容
    parseEditorContent();
    
    // 检查是否有内容可发送
    const hasContent = contentItems.some(item => 
      (item.type === 'text' && item.content.trim() !== '') || 
      item.type === 'image'
    );
    
    if (!hasContent) return;
    
    setIsSending(true);
    try {
      // 创建头像信息对象
      const avatar = { text: avatarText, color: avatarColor };
      
      // 新的消息合并逻辑
      let currentTextContent = '';
      
      for (let i = 0; i < contentItems.length; i++) {
        const item = contentItems[i];
        
        if (item.type === 'text') {
          // 收集文本内容
          if (item.content.trim() !== '') {
            currentTextContent += (currentTextContent ? '\n' : '') + item.content;
          }
        } else if (item.type === 'image' && item.file) {
          // 如果积累了文本内容，发送文本
          if (currentTextContent.trim() !== '') {
            sendMessage(currentTextContent, roomId, 'text', username, avatar);
            currentTextContent = ''; // 重置文本内容
          }
          
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
            sendMessage(base64String, roomId, 'image', username, avatar);
            
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
      
      // 发送剩余的文本内容
      if (currentTextContent.trim() !== '') {
        sendMessage(currentTextContent, roomId, 'text', username, avatar);
      }
      
      // 清空编辑器
      if (editorRef.current) {
        // 释放所有预览URL
        const images = editorRef.current.querySelectorAll('img');
        images.forEach(img => {
          if (img.src.startsWith('blob:')) {
            URL.revokeObjectURL(img.src);
          }
        });
        
        editorRef.current.innerHTML = '';
      }
      
      // 重置状态
      setContentItems([{ type: 'text', content: '' }]);
      setImageCount(0);
      imageCountRef.current = 0;
      setErrorMessage(null);
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsSending(false);
      
      // 聚焦回输入框
      setTimeout(() => {
        editorRef.current?.focus();
      }, 0);
    }
  };

  // 处理图片上传
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    // 使用ref获取当前实际图片数量
    const currentImageCount = imageCountRef.current;
    // 检查图片数量限制
    const availableSlots = MAX_IMAGES - currentImageCount;
    
    if (availableSlots <= 0) {
      setErrorMessage(t('maxImagesReached', { max: MAX_IMAGES }));
      return;
    }
    
    // 处理多个文件，最多处理剩余可用槽位数量的图片
    Array.from(files).slice(0, availableSlots).forEach(file => {
      processImageFile(file);
    });
  };
  
  // 处理图片文件 - 优化性能
  const processImageFile = (file: File) => {
    // 检查文件类型
    if (!file.type.startsWith('image/')) {
      setErrorMessage(t('onlyImagesAllowed'));
      return;
    }
    
    // 检查文件大小 - 仍然保留初步的大小检查，但提高到10MB
    if (file.size > 10 * 1024 * 1024) {
      setErrorMessage(t('imageTooLarge'));
      return;
    }
    
    // 直接在这里更新计数，避免延迟
    const newCount = imageCountRef.current + 1;
    if (newCount > MAX_IMAGES) {
      setErrorMessage(t('maxImagesReached', { max: MAX_IMAGES }));
      return;
    }

    // 创建预览URL
    const previewUrl = URL.createObjectURL(file);
    
    // 创建并插入图片元素
    if (imageCountRef.current < MAX_IMAGES) {
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
    if (imageCountRef.current >= MAX_IMAGES) {
      setErrorMessage(t('maxImagesReached', { max: MAX_IMAGES }));
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
    const range = selection?.getRangeAt(0);
    
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
    // 动态确定粘贴间隔限制
    const throttleTime = pasteCountRef.current <= 1 
      ? INITIAL_PASTE_THROTTLE_MS 
      : SUBSEQUENT_PASTE_THROTTLE_MS;
    
    // 限制粘贴频率
    const now = Date.now();
    if (now - lastPasteTime.current < throttleTime) {
      e.preventDefault();
      return;
    }
    lastPasteTime.current = now;
    
    // 更新粘贴计数
    pasteCountRef.current += 1;
    
    // 设置自动重置粘贴计数的定时器（如果2秒内没有新的粘贴，重置计数）
    setTimeout(() => {
      if (Date.now() - lastPasteTime.current >= 2000) {
        pasteCountRef.current = 0;
      }
    }, 2000);
    
    // 检查是否达到图片数量上限 - 使用ref实时获取
    if (imageCountRef.current >= MAX_IMAGES) {
      // 如果有图片类型内容，显示提示
      if (Array.from(e.clipboardData.items).some(item => item.type.indexOf('image') !== -1)) {
        e.preventDefault();
        setErrorMessage(t('maxImagesReached', { max: MAX_IMAGES }));
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
    
    // 获取粘贴的所有内容
    const items = e.clipboardData.items;
    let hasProcessedImage = false;
    
    // 首先处理图片
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        // 再次检查实时图片数量
        if (imageCountRef.current < MAX_IMAGES) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault(); // 阻止默认粘贴行为
            processImageFile(file);
            hasProcessedImage = true;
            break; // 一次只处理一张图片，避免界面混乱
          }
        } else {
          e.preventDefault();
          setErrorMessage(t('maxImagesReached', { max: MAX_IMAGES }));
          return;
        }
      }
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

  // 处理回车事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
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
        handleSubmit(e);
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
    };
  }, []);

  return (
    <div className="relative">
      {/* 错误消息显示 */}
      {errorMessage && (
        <div className="absolute -top-10 left-0 right-0 flex justify-center">
          <Card className="bg-danger-100 text-danger text-xs px-3 py-1.5 shadow-sm">
            <Icon icon="lucide:alert-circle" className="inline-block mr-1 text-xs" />{errorMessage}
          </Card>
        </div>
      )}
      
      <form onSubmit={handleSubmit} className="flex flex-col w-full pb-0.5">
        <div className="flex bg-content2 dark:bg-content1 rounded-lg border-1 border-content3 dark:border-content2 overflow-hidden">
          {/* 编辑区域 */}
          <div 
            className="flex-1 min-h-12 max-h-40 overflow-y-auto p-2 text-sm"
            contentEditable={!isSending && !isAiProcessing} // 禁用编辑区域当 AI 处理中
            onInput={parseEditorContent}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            ref={editorRef}
            data-placeholder={isAiProcessing ? t('aiProcessing') : t('typeMessageHere')}
            style={{
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
            }}
            role="textbox"
            aria-label={t('messageInput')}
            aria-multiline="true"
            title={`${t('messageInput')} (Enter: ${t('send')}, Shift+Enter: ${t('newLine')}, ${isMacOS ? 'Command+Enter' : 'Ctrl+Enter'}: ${t('askAI')})`}
          ></div>
        
          {/* 辅助按钮区 */}
          <div className="flex flex-col justify-between py-1 border-l-1 border-content3 dark:border-content2">
            {/* 图片上传按钮 */}
            <Tooltip content={t('addImage')}>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="text-default-600"
                onPress={() => fileInputRef.current?.click()}
                isDisabled={imageCount >= MAX_IMAGES || isSending || isAiProcessing} // 禁用图片上传当 AI 处理中
              >
                <Icon icon="lucide:image" />
              </Button>
            </Tooltip>
            
            {/* AI设置按钮 (原来的AI按钮) */}
            <Tooltip content={t('aiSettings') || "AI Settings"}>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="text-default-600"
                onPress={onAISettingsOpen}
                isDisabled={isSending || isAiProcessing}
              >
                <Icon icon="lucide:settings-2" />
              </Button>
            </Tooltip>
            
            {/* 隐藏的文件输入 */}
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              multiple={true}
              onChange={handleImageUpload}
              disabled={isSending || isAiProcessing} // 禁用文件输入当 AI 处理中
            />
          </div>
        </div>
        
        {/* AI角色选择和发送按钮区 */}
        <div className="flex justify-between items-center mt-1.5">
          {/* AI角色选择下拉框 */}
          <div className="flex-1 mr-2">
            <Select
              size="sm"
              aria-label={t('selectAIRole') || "Select AI Role"}
              selectedKeys={[selectedRoleId]}
              onSelectionChange={(keys) => {
                const selectedKey = Array.from(keys)[0]?.toString();
                if (selectedKey) handleRoleChange(selectedKey);
              }}
              className="max-w-xs"
              isDisabled={isSending || isAiProcessing}
            >
              {aiRoles.map((role) => (
                <SelectItem key={role.id} startContent={<Icon icon={role.icon} />}>
                  {role.name}
                </SelectItem>
              ))}
            </Select>
          </div>
        
          
          {/* 按钮区 */}
          <div className="flex space-x-2">
            {/* AI问答按钮 */}
            <Tooltip content={`${t('askAI')} (${isMacOS ? 'Command' : 'Ctrl'}+Enter)`} placement="top">
              <Button
                color={getSelectedRole().color}
                size="sm"
                onPress={handleAskAI}
                isLoading={isAiProcessing}
                isDisabled={isSending}
                className="px-4"
                startContent={<Icon icon={getSelectedRole().icon} className="h-4 w-4" />}
              >
                {t('askAI') || "Ask AI"}
              </Button>
            </Tooltip>
            
            {/* 发送按钮 */}
            <Tooltip content={`${t('send')} (Enter)`} placement="top">
              <Button
                type="submit"
                color="primary"
                size="sm"
                isLoading={isSending}
                isDisabled={isAiProcessing}
                className="px-4"
                startContent={<Icon icon="lucide:send" className="h-4 w-4" />}
              >
                {t('send')}
              </Button>
            </Tooltip>
          </div>
        </div>

      </form>

      {/* 新增：AI设置模态框 */}
      <Modal isOpen={isAISettingsOpen} onClose={onAISettingsClose} size="3xl">
        <ModalContent>
          <ModalHeader>{t('aiSettings') || "AI Assistant Settings"}</ModalHeader>
          <ModalBody>
            <Tabs aria-label="AI Settings Tabs">
              <Tab key="roles" title="AI Roles">
                <div className="mt-2">
                  <AIRoleManager 
                    roles={aiRoles} 
                    selectedRoleId={selectedRoleId}
                    onSelectRole={handleRoleChange}
                    onAddRole={handleAddRole}
                    onUpdateRole={handleUpdateRole}
                    onDeleteRole={handleDeleteRole}
                  />
                </div>
              </Tab>
            </Tabs>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onAISettingsClose}>{t('close')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};