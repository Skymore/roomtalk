import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { sendMessage } from '../utils/socket';
import { useTranslation } from 'react-i18next';
import imageCompression from 'browser-image-compression';

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

  // 发送消息
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
          // 如果积累了文本内容，先发送文本
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
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
    <form onSubmit={handleSubmit} className="p-2">
      <div className="flex flex-col">
        <div 
          ref={editorRef}
          contentEditable={!isSending}
          className="min-h-16 max-h-60 overflow-y-auto overflow-x-hidden w-full p-2 border border-default-200 rounded-lg focus:border-primary focus:outline-none"
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          data-placeholder={t('typeMessage')}
          style={{
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
          }}
          role="textbox"
          aria-label={t('messageInput')}
          aria-multiline="true"
          title={t('messageInput')}
        />
        
        {errorMessage && (
          <div className="text-danger text-sm mt-1 mb-1 transition-opacity duration-300 animate-pulse">
            <Icon icon="lucide:alert-circle" className="inline-block mr-1" /> 
            {errorMessage}
          </div>
        )}
        
        <div className="flex justify-between items-center mt-2">
          <div className="flex gap-2">
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
              disabled={isSending || imageCount >= MAX_IMAGES}
              multiple
              aria-label={t('uploadImage')}
              title={t('uploadImage')}
            />
            <Button
              type="button"
              isIconOnly
              variant="light"
              onPress={() => fileInputRef.current?.click()}
              disabled={isSending || imageCount >= MAX_IMAGES}
              className="rounded-full"
              aria-label={t('uploadImage')}
            >
              <Icon icon="lucide:image" />
            </Button>
            {imageCount > 0 && (
              <span className={`text-xs ${imageCount >= MAX_IMAGES ? 'text-danger' : 'text-default-400'} self-center font-medium`}>
                {imageCount}/{MAX_IMAGES} {t('images')}
              </span>
            )}
          </div>
          
          <Button
            type="submit"
            color="primary"
            aria-label={t('send')}
            isLoading={isSending}
            isDisabled={contentItems.every(item => 
              (item.type === 'text' && item.content.trim() === '') || 
              (item.type !== 'text' && item.type !== 'image')
            ) || isSending}
          >
            <Icon icon="lucide:send" className="mr-1" />
            {t('send')}
          </Button>
        </div>
      </div>
    </form>
  );
};