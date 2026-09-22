export function cachedHistoricalRead<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T> | T): Promise<T>;
export function readBeforeDeadline<T>(read: (signal: AbortSignal) => Promise<T> | T, deadlineAt: number, message: string): Promise<T>;
export function readExplorerLogPages(options: {
  url: string;
  deadlineAt: number;
  maxPages?: number;
  fetchPage?: typeof fetch;
}): Promise<{ items: any[]; warnings: string[]; pages: number }>;
