// 基础模块自己的表在删除、初始化时怎么处理（登记接口见 deletion-rules.ts）。由 core/index.ts 引入，加载基础模块时就登记。
import { registerReset } from './deletion-rules.js';

registerReset({ module: '基础', order: 49, statements: ['DELETE FROM record_lifecycle'] });
// 按天的流水号计数（number_sequences）不清，单号不回头。
registerReset({ module: '基础', order: 51, statements: ['DELETE FROM operation_requests'] });
