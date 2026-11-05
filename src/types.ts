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
  completeness: Completeness;
  fetchedWithSession: boolean;
  supersededBy: string | null;
  previousId: string | null;
}

export type CompletenessVerdict = "complete" | "likely_incomplete" | "unknown";

export interface Completeness {
  verdict: CompletenessVerdict;
  reason: string;
  signals: { key: string; weight: number; detail: string }[];
  acceptedByUser: boolean;
}

export interface RefetchOutcome {
  status: "replaced" | "kept_old" | "unchanged";
  current: Source;
  oldWords: number;
  newWords: number;
  candidateId: string | null;
}

export interface SiteSession {
  site: string;
  createdAt: string;
  lastUsedAt: string | null;
  wipePending: boolean;
  loginOpen: boolean;
}

export interface LoginClosed {
  site: string;
  hasSession: boolean;
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
export type ApiKind = "anthropic" | "openai_compatible" | "chatgpt_plan";

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
  /** Bij ChatGPT: ingelogd. De tokens komen nooit in de frontend. */
  hasKey: boolean;
  models: Model[];
  chatgpt?: ChatgptAccount | null;
}

export interface ChatgptAccount {
  clientId: string;
  subject: string;
  email: string | null;
  planEnabled: boolean;
  sessionLost: boolean;
}

export interface LoginOutcome {
  provider: Provider;
  showWelcome: boolean;
  modelsError: AppError | null;
}

export interface LogoutOutcome {
  provider: Provider;
  revoked: boolean;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ProvidersFile {
  schemaVersion: number;
  providers: Provider[];
  selection: { active: ModelRef | null; perAction: Record<string, ModelRef> };
  chatgptWelcomeSeen?: boolean;
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

// Spiegel van src-tauri/src/blueprint/schema.rs.
export type ParagraphRange = [number, number];
export type Origin = "stated" | "inferred";
export type Polarity = "minus" | "plus";
export type Certainty = "high" | "medium" | "low";
export type Category = "assumption" | "leap" | "gap" | "evidence" | "missing" | "headline_vs_content";
export type CheckResult = "found" | "nothing_found" | "not_applicable";
export type Stage = "structure" | "critique";

export interface Goal {
  kind: string;
  description: string;
}

export interface Occasion {
  text: string;
  origin: Origin;
  paragraphs: ParagraphRange[];
}

export interface Quote {
  paragraph: number;
  text: string;
  verified: boolean;
}

export interface DiagramBlock {
  id: string;
  role: string;
  title: string;
  content: string;
  paragraphs: ParagraphRange[];
  quote: Quote | null;
}

export interface Relation {
  id: string;
  block: string;
  dependsOn: string;
  kind: string;
  explanation: string;
}

export interface Structure {
  textKind: string;
  goal: { main: Goal; secondary: Goal[] };
  message: string;
  occasion: Occasion | null;
  summary: string;
  articleParagraphs: ParagraphRange;
  blocks: DiagramBlock[];
  relations: Relation[];
}

export interface Point {
  id: string;
  category: Category;
  polarity: Polarity;
  origin: Origin;
  certainty: Certainty;
  anchor: string | null;
  claim: string;
  explanation: string;
  paragraphs: ParagraphRange[];
  quotes: Quote[];
  evidenceKind: string | null;
  broad: boolean;
}

export interface Term {
  term: string;
  explanation: string;
  paragraphs: ParagraphRange[];
}

export interface Critique {
  points: Point[];
  terms: Term[];
  checked: { category: Category; result: CheckResult; note: string | null }[];
  overall: string;
}

export interface Issue {
  code: string;
  path: string;
  detail: string;
}

export interface Blueprint extends Structure {
  schemaVersion: number;
  source: { sourceId: string; completeness: CompletenessVerdict; likelyIncomplete: boolean; acceptedByUser: boolean; warning: string | null; blockCount: number; wordCount: number };
  model: string;
  providerId: string;
  promptVersion: number;
  language: string;
  createdAt: string;
  seconds: number;
  critique: Critique | null;
  issues: Issue[];
}

/** Wat al binnen is terwijl het model nog schrijft, nog niet gecontroleerd. */
export type DraftStructure = Partial<Omit<Structure, "blocks" | "relations">> & { blocks: DiagramBlock[]; relations: Relation[] };

export type JobEvent =
  | { type: "attempt"; stage: Stage; attempt: number }
  | { type: "alive"; stage: Stage; chars: number; thinking: boolean }
  | { type: "field"; name: string; value: unknown }
  | { type: "block"; value: DiagramBlock }
  | { type: "structure"; blueprint: Blueprint };
