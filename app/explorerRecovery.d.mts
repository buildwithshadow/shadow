type Request = { method?: string; query?: Record<string, string | string[] | undefined> };
type Response = { setHeader(name: string, value: string | number): void; status(code: number): Response; json(value: unknown): void };
export default function handler(req: Request, res: Response): Promise<void>;
