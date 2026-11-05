// Spiegel van het bronmodel in src-tauri/src/model.rs.
export type SourceKind = "web" | "pdf" | "text";

export interface Block {
  n: number;
  kind: string;
  level?: number;
  text: string;
  page?: number;
  bbox?: [number, number, number, number];
}

export interface Source {
  schemaVersion: number;
  id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  finalUrl: string | null;
  capturedAt: string;
  author: string | null;
  siteName: string | null;
  published: string | null;
  lang: string | null;
  contentHash: string | null;
  pageCount: number | null;
  textReady: boolean;
  blocks: Block[];
  wordCount: number;
  assets: { saved: number; failed: number; bytes: number; failedUrls: string[] };
  warnings: string[];
}

export interface SourceSummary {
  id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  capturedAt: string;
  wordCount: number;
}

export interface AppError {
  kind: string;
  message: string;
  detail: string | null;
}

// Spiegel van src-tauri/src/providers/mod.rs. Er bestaat bewust geen veld met de sleutel zelf.
export type ApiKind = "anthropic" | "openai_compatible";

export interface Model {
  id: string;
  displayName: string | null;
  supportsImages: boolean | null;
  contextTokens: number | null;
  enabled: boolean;
  manual: boolean;
  userEdited: boolean;
}

export interface Provider {
  id: string;
  name: string;
  kind: ApiKind;
  baseUrl: string;
  hasKey: boolean;
  models: Model[];
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ProvidersFile {
  schemaVersion: number;
  providers: Provider[];
  selection: { active: ModelRef | null; perAction: Record<string, ModelRef> };
}

export type KeyChange = { action: "keep" } | { action: "set"; value: string } | { action: "clear" };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; stop: string; inputTokens: number | null; outputTokens: number | null };

export interface ConnectionReport {
  model: string | null;
  sample: string;
  firstTokenMs: number | null;
}
