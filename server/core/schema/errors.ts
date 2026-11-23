import { AppError } from '../http/errors.js';

/**
 * 业务库不能打开：0.9.0 以前的旧库、比程序新的库、不是本系统的文件、版本记录坏了，或者建新库、升级、升级前快照没做成。
 * 消息是给人看的完整中文说明；启动入口原样打出来、以非零码退出，不打堆栈。抛出时数据没有改动。
 */
export class SchemaError extends AppError {
  constructor(message: string) {
    super(message, 500, 'schema');
  }
}
