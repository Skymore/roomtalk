// logger.ts
import winston from 'winston';
import 'winston-daily-rotate-file';
import fs from 'fs';
import path from 'path';
import express from 'express';

// 确保日志目录存在
const logDir = 'logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// 定义日志级别
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// 根据环境确定日志级别
const level = () => {
  const env = process.env.NODE_ENV || 'development';
  return env === 'development' ? 'debug' : 'info';
};

// 定义日志颜色
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

// 添加颜色
winston.addColors(colors);

// 定义日志格式
const format = winston.format.combine(
  // 添加时间戳
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  // 处理错误堆栈
  winston.format.errors({ stack: true }),
  // 自定义格式输出
  winston.format.printf((info) => {
    // 如果有元数据，转换为字符串
    let meta = '';
    if (info.meta) {
      meta = typeof info.meta === 'object' 
        ? JSON.stringify(info.meta) 
        : info.meta.toString();
    }
    
    // 如果有错误堆栈，添加到日志中
    const stack = info.stack ? `\n${info.stack}` : '';
    
    return `[${info.timestamp}] [${info.level}] ${info.context || ''}: ${info.message} ${meta} ${stack}`;
  })
);

// 控制台格式（带颜色）
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  format
);

// 创建日志传输
const transports = [
  // 控制台输出 (这行将被移除)
  // new winston.transports.Console({ format: consoleFormat }), 
  
  // 旋转错误日志文件 - 按天存储，最多保留30天
  new winston.transports.DailyRotateFile({
    filename: path.join(logDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '20m',
    maxFiles: '30d',
    level: 'error',
  }),
  
  // 旋转所有日志文件
  new winston.transports.DailyRotateFile({
    filename: path.join(logDir, 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '20m',
    maxFiles: '30d',
  }),
];

// 创建日志实例
const logger = winston.createLogger({
  level: level(),
  levels,
  format,
  transports,
  defaultMeta: { service: 'chat-service' }
});

// 导出包装器，允许指定上下文
export class Logger {
  private context: string;
  
  constructor(context: string) {
    this.context = context;
  }
  
  error(message: string, meta?: any): void {
    logger.error({ message, meta, context: this.context });
  }
  
  warn(message: string, meta?: any): void {
    logger.warn({ message, meta, context: this.context });
  }
  
  info(message: string, meta?: any): void {
    logger.info({ message, meta, context: this.context });
  }
  
  http(message: string, meta?: any): void {
    logger.http({ message, meta, context: this.context });
  }
  
  debug(message: string, meta?: any): void {
    logger.debug({ message, meta, context: this.context });
  }
  
  // 格式化消息对象，避免记录过大的内容
  formatMessageForLog(message: any): any {
    // 如果不是对象，直接返回
    if (typeof message !== 'object' || message === null) {
      return message;
    }
    
    // 创建消息对象的副本，避免修改原始数据
    const logMessage = { ...message };
    
    // 处理图片消息，截断内容
    if (logMessage.messageType === 'image' && logMessage.content) {
      // 只保留前30个字符，后面用...代替
      const contentStart = logMessage.content.substring(0, 30);
      logMessage.content = `${contentStart}... [BASE64_IMAGE_DATA_TRUNCATED]`;
    }
    
    return logMessage;
  }
}

// 创建默认日志记录器
export const defaultLogger = new Logger('App');

// 用于记录HTTP请求的中间件
export const httpLogger = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const start = Date.now();
  
  // 请求完成时记录
  res.on('finish', () => {
    const duration = Date.now() - start;
    const message = `${req.method} ${req.originalUrl}`;
    const meta = {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      statusCode: res.statusCode,
      userAgent: req.get('user-agent'),
      duration: `${duration}ms`
    };
    
    // 根据状态码选择日志级别
    if (res.statusCode >= 500) {
      logger.error({ message, meta, context: 'HTTP' });
    } else if (res.statusCode >= 400) {
      logger.warn({ message, meta, context: 'HTTP' });
    } else {
      logger.http({ message, meta, context: 'HTTP' });
    }
  });
  
  next();
};

export default logger;