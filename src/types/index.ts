export interface KablewyConfig {
  apiUrl: string;
  orgId: string;
  userId: string;
  apiKey: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  apiKeyExpiresAt?: string;
  docWorkerUrl?: string;
  docProcessorToken?: string;
  concurrency: number;
  retryAttempts: number;
  retryDelay: number;
  parseMode: 'fast' | 'balanced' | 'premium' | 'auto';
  interactive: boolean;
  theme: 'light' | 'dark' | 'auto';
  mcpServers: Record<string, MCPServerConfig>;
  plugins: string[];
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
  trust?: boolean;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolSchema;
  server: string;
}

export interface MCPToolSchema {
  type: 'object';
  properties: Record<string, MCPToolProperty>;
  required?: string[];
}

export interface MCPToolProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: MCPToolProperty;
  properties?: Record<string, MCPToolProperty>;
}

export interface MCPMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: MCPToolCall[];
  toolResults?: MCPToolResult[];
}

export interface MCPToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface DocumentMetadata {
  id: string;
  title: string;
  description?: string;
  type: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  chunks: number;
  embeddings: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  score: number;
  metadata: DocumentMetadata;
  highlights: string[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: MCPMessage[];
  createdAt: string;
  updatedAt: string;
  context: string[];
}

export interface UploadSession {
  id: string;
  files: UploadFile[];
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  progress: number;
  createdAt: string;
  completedAt?: string;
  manifestPath?: string;
  stats?: UploadSessionStats;
  metadata?: Record<string, unknown>;
  rateLimiter?: UploadRateLimiterState;
}

export interface UploadRateLimiterState {
  windowStart: number;
  requestsInWindow: number;
  bytesInWindow: number;
  advisoryConcurrency?: number;
}

export interface UploadSessionStats {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  bytesUploaded: number;
}

export interface UploadFile {
  path: string;
  name: string;
  size: number;
  type: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed' | 'skipped';
  error?: string;
  documentId?: string;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  lastError?: UploadErrorInfo;
}

export interface UploadErrorInfo {
  category: UploadErrorCategory;
  message: string;
  code?: string | number;
  retryable: boolean;
  timestamp: string;
  details?: Record<string, unknown> | string;
}

export type UploadErrorCategory =
  | 'NETWORK'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'VALIDATION'
  | 'SERVER'
  | 'CLIENT'
  | 'UNKNOWN';

export interface CommandContext {
  config: unknown; // ConfigManager - avoiding circular import
  mcpClient: MCPClient;
  output: OutputHandler;
  input: InputHandler;
}

export interface OutputHandler {
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  table(data: unknown[]): void;
  progress(message: string): ProgressBar;
  spinner(message: string): Spinner;
  section(title: string): void;
  list(items: string[], options?: { bullet?: string; color?: string }): void;
  json(obj: unknown): void;
  code(code: string, language?: string): void;
  banner(text: string): void;
  box(message: string, options?: BoxOptions): void;
  clear(): void;
}

export interface InputHandler {
  prompt(question: string, options?: PromptOptions): Promise<string>;
  confirm(message: string, options?: ConfirmOptions): Promise<boolean>;
  select(message: string, choices: string[], options?: SelectOptions): Promise<string>;
  multiSelect(message: string, choices: string[], options?: MultiSelectOptions): Promise<string[]>;
}

export interface MCPClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResponse>;
  sendMessage(message: MCPMessage): Promise<MCPMessage>;
  startChat(messages: MCPMessage[]): AsyncGenerator<MCPMessage>;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  commands: Command[];
  tools: MCPTool[];
  init(context: CommandContext): Promise<void>;
  destroy(): Promise<void>;
}

export interface Command {
  name: string;
  description: string;
  options: CommandOption[];
  action: (args: unknown, context: CommandContext) => Promise<void>;
}

export interface CommandOption {
  flags: string;
  description: string;
  required?: boolean;
  default?: unknown;
  choices?: string[];
}

// Command-specific option interfaces
export interface UploadOptions {
  parseMode?: 'fast' | 'balanced' | 'premium' | 'auto';
  concurrency?: number;
  retryAttempts?: number;
  retryDelay?: number;
  public?: boolean;
  force?: boolean;
  recursive?: boolean;
  skipExisting?: boolean;
  include?: string;
  exclude?: string;
  json?: boolean;
  verbose?: boolean;
  sessionDir?: string;
  sessionId?: string;
  resumeFrom?: string;
  logFile?: string;
  /** commander negated option: `--no-session-store` sets this to false */
  sessionStore?: boolean;
  maxRequestsPerMinute?: number;
  maxBytesPerMinute?: number;
  maxConcurrency?: number;
  // Container routing (doc-worker)
  useContainer?: boolean;
  docWorkerUrl?: string;
  docProcessorToken?: string;
}

export interface ChatOptions {
  session?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  verbose?: boolean;
  ui?: boolean;
  toolsMode?: 'exact' | 'none';
}

export interface ConfigOptions {
  key?: string;
  value?: string;
  reset?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface StatusOptions {
  health?: boolean;
  tools?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface InteractiveOptions {
  session?: string;
  welcome?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface ToolsOptions {
  list?: boolean;
  call?: string;
  args?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface PluginOptions {
  list?: boolean;
  install?: string;
  uninstall?: string;
  enable?: string;
  disable?: string;
  info?: string;
  commands?: boolean;
  tools?: boolean;
  force?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface SkillOptions {
  json?: boolean;
  verbose?: boolean;
  // create options
  name?: string;
  description?: string;
  allowedTools?: string;
  githubUrl?: string;
  githubBranch?: string;
  // execute options
  runtime?: string;
  entry?: string;
  args?: string;
  env?: string;
  version?: string;
  timeoutMs?: number;
  // delete options (skip confirmation prompt)
  force?: boolean;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  visibility?: 'org' | 'private' | 'custom';
  latestVersion?: string | null;
  latestRuntime?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillDetails {
  manifest: SkillManifest;
  body: string;
}

export interface SkillBundleIndex {
  latestVersion?: string;
  versions: Record<string, { sha256: string; runtime?: string; entry?: string }>;
}

// MCP Tool Response interfaces
export interface MCPToolResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchDocumentsResponse extends MCPToolResponse {
  data?: {
    results: SearchResult[];
    total: number;
    query: string;
  };
}

export interface UploadDocumentResponse extends MCPToolResponse {
  data?: {
    documentId: string;
    title: string;
    chunks: number;
    size: number;
  };
}

export interface ListDocumentsResponse extends MCPToolResponse {
  data?: {
    documents: DocumentMetadata[];
    total: number;
  };
}

export interface CreateChatSessionResponse extends MCPToolResponse {
  data?: {
    sessionId: string;
    title: string;
  };
}

export interface SendChatMessageResponse extends MCPToolResponse {
  data?: {
    messageId: string;
    content: string;
    toolCalls?: MCPToolCall[];
  };
}

// Progress and Spinner interfaces
export interface ProgressBar {
  update(progress: number): void;
  stop(): void;
}

export interface Spinner {
  start(): void;
  stop(): void;
  succeed(message?: string): void;
  fail(message?: string): void;
  update(text: string): void;
}

// Input prompt interfaces
export interface PromptOptions {
  type?: 'input' | 'password' | 'number';
  default?: string;
  validate?: (input: string) => boolean | string;
  filter?: (input: string) => string;
}

export interface ConfirmOptions {
  default?: boolean;
}

export interface SelectOptions {
  default?: string;
  pageSize?: number;
}

export interface MultiSelectOptions {
  default?: string[];
  pageSize?: number;
}

// Box options interface
export interface BoxOptions {
  title?: string;
  titleAlignment?: 'left' | 'center' | 'right';
  padding?: number;
  margin?: number;
  borderStyle?: 'single' | 'double' | 'round' | 'bold' | 'singleDouble' | 'doubleSingle' | 'classic';
  borderColor?: string;
  backgroundColor?: string;
  dimBorder?: boolean;
  float?: 'left' | 'center' | 'right';
}
