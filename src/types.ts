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
