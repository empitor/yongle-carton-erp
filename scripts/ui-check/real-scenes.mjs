// 全量测试的场景：按领域分文件（real-scenes-*.mjs），这里只把它们按固定顺序拼起来（同一实例上按这个顺序跑，记忆那几条前后有依赖）。
import { scenes as access } from './real-scenes-access.mjs';
import { scenes as gate } from './real-scenes-gate.mjs';
import { scenes as toolsRecords } from './real-scenes-tools-records.mjs';
import { scenes as toolsFlow } from './real-scenes-tools-flow.mjs';
import { scenes as toolsImport } from './real-scenes-tools-import.mjs';
import { scenes as toolsSystem } from './real-scenes-tools-system.mjs';
import { scenes as flows } from './real-scenes-flows.mjs';
import { scenes as files } from './real-scenes-files.mjs';
import { scenes as context } from './real-scenes-context.mjs';
import { scenes as memory } from './real-scenes-memory.mjs';
import { scenes as diagnose } from './real-scenes-diagnose.mjs';
import { scenes as persona } from './real-scenes-persona.mjs';

export async function loadScenes() {
  return [...access, ...gate, ...toolsRecords, ...toolsFlow, ...toolsImport, ...toolsSystem, ...flows, ...files, ...context, ...memory, ...diagnose, ...persona];
}
