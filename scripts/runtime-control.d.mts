export function controlFile(database: string): string;
export function readControl(database: string): {
  app: string;
  pid: number;
  port: number;
  token: string;
};
export function createRuntimeControl(
  database: string,
  onStop: () => void | Promise<void>,
  afterStop?: () => void,
): Promise<{ close(): Promise<void> }>;
export function requestRuntimeStop(database: string, expectedPid: number): Promise<void>;
