/** Shared response envelope types for Hot API v1. */

export interface ResponseMeta {
  request_id: string;
  timestamp: string;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ApiResponse<T> {
  data: T;
  meta: ResponseMeta;
}

export interface ApiListResponse<T> {
  data: T[];
  pagination: Pagination;
  meta: ResponseMeta;
}

/** @deprecated Use `ApiResponse<T>` or `ApiListResponse<T>` for precise endpoint typing. */
export type ApiEnvelope<T> = ApiResponse<T>;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id?: string;
    retry_after?: number;
  };
}

export interface ListQuery {
  limit?: number;
  offset?: number;
  [key: string]: string | number | undefined;
}

export type JsonObject = Record<string, unknown>;

export interface HotClientOptions {
  /** Base URL without trailing slash. Defaults to `https://api.hot.dev`. */
  baseUrl?: string;
  /** Bearer token (API key, service key, or session). Server-side only. */
  token: string;
  /** Custom fetch implementation (tests, edge runtimes). */
  fetch?: typeof fetch;
}

export interface EventRecord {
  event_id: string;
  env_id: string;
  stream_id: string;
  event_type: string;
  event_data: unknown;
  event_time: string;
  created_at: string;
}

export interface ProjectRecord {
  project_id: string;
  env_id: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRequest {
  name: string;
}

export interface UpdateProjectRequest {
  name: string;
}

export interface ProjectActivateResponse {
  project: ProjectRecord;
  redeployed_build_id?: string | null;
}

export interface BuildRecord {
  build_id: string;
  project_id: string;
  hash: string;
  size: number;
  build_type: string;
  deployed: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
  storage_path?: string | null;
  storage_backend?: string | null;
}

export interface BuildWithProjectRecord extends BuildRecord {
  project_name: string;
}

export interface BuildUploadResponse {
  build_id: string;
  project_id: string;
  hash: string;
  size: number;
  storage_path: string;
  storage_backend: string;
  created_at: string;
}

export interface ContextVariableRecord {
  key: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateContextVariableRequest {
  key: string;
  value: string;
  description?: string | null;
}

export interface UpdateContextVariableRequest {
  value: string;
  description?: string | null;
}

/** Exact wire shape for `POST /v1/events`. User-owned `event_data` is not transformed. */
export interface PublishEventRequest {
  event_type: string;
  event_data: unknown;
  stream_id?: string;
}

export interface RunRecord {
  run_id: string;
  env_id: string;
  stream_id: string;
  build_id: string | null;
  run_type: string;
  status: string;
  start_time: string;
  stop_time: string | null;
  origin_run_id: string | null;
  event_id: string | null;
  result: unknown | null;
  project_id: string | null;
  project_name: string | null;
  retry_attempt: number;
  next_retry_at?: string | null;
}

export interface RunStats {
  total_runs: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface RunListQuery extends ListQuery {
  status?: "running" | "succeeded" | "failed" | "cancelled" | string;
  type?: "call" | "event" | "schedule" | "run" | "eval" | "repl" | string;
  time_range?: string;
}

export interface EnvInfo {
  env_id: string;
  org_id: string;
  name: string;
  active: boolean;
}

export type EnvSubscriptionEvent =
  | {
      type: "run:start";
      run_id: string;
      env_id: string;
      stream_id: string;
      event_id?: string | null;
      project_id?: string | null;
      fn_name?: string | null;
      run_type: string;
    }
  | {
      type: "run:stop";
      run_id: string;
      env_id: string;
      stream_id: string;
      event_id?: string | null;
      project_id?: string | null;
      fn_name?: string | null;
      run_type: string;
      duration_ms?: number | null;
    }
  | {
      type: "run:fail";
      run_id: string;
      env_id: string;
      stream_id: string;
      event_id?: string | null;
      project_id?: string | null;
      fn_name?: string | null;
      run_type: string;
      duration_ms?: number | null;
      error?: string | null;
    }
  | {
      type: "run:cancel";
      run_id: string;
      env_id: string;
      stream_id: string;
      event_id?: string | null;
      project_id?: string | null;
      fn_name?: string | null;
      run_type: string;
      duration_ms?: number | null;
      reason?: string | null;
    }
  | {
      type: "event:created";
      event_id: string;
      env_id: string;
      stream_id: string;
      event_type: string;
      project_id?: string | null;
    }
  | {
      type: "event:handled";
      event_id: string;
      env_id: string;
      stream_id: string;
      event_type: string;
      project_id?: string | null;
    }
  | {
      type: "stream:created";
      stream_id: string;
      env_id: string;
      project_id?: string | null;
    }
  | {
      type: "task:started";
      task_id: string;
      env_id: string;
      stream_id: string;
      function_name: string;
      task_type: string;
    }
  | {
      type: "task:complete";
      task_id: string;
      env_id: string;
      stream_id: string;
      function_name: string;
      status: string;
      duration_ms?: number | null;
      error?: unknown;
    }
  | {
      type: "keepalive";
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface OrgUsage {
  org_id: string;
  usage: {
    runs_this_period: number;
    file_storage_bytes: number;
    team_members: number;
    call_storage_bytes: number;
    call_count: number;
    store_storage_bytes: number;
    active_schedules: number;
  };
  limits: {
    runs_per_month: number;
    storage_bytes: number;
    team_members: number;
    call_retention_days: number;
    call_storage_bytes: number;
    store_storage_bytes: number;
    compute_units_per_month: number;
    compute_units_used: number;
    compute_units_budget: number;
    task_minutes_per_month: number;
    active_schedules_per_org: number;
  };
  usage_percent: {
    runs: number;
    file_storage: number;
    team_members: number;
    call_storage: number;
    store_storage: number;
    active_schedules: number;
    has_warning: boolean;
  };
  plan: {
    name: string;
    period_start: string;
    period_end: string;
  };
}

/** Exact wire shape for `POST /v1/streams/subscribe-with-event`. */
export interface SubscribeWithEventRequest {
  event_type: string;
  event_data: unknown;
  stream_id?: string;
}

export interface SubscribeWithEventParams {
  project?: string;
}

export interface EventHandlerRecord {
  event_handler_id: string;
  build_id: string;
  event_type: string;
  ns: string;
  var: string;
}

export interface ScheduleRecord {
  schedule_id: string;
  build_id: string;
  cron: string;
  ns: string;
  var: string;
}

export type Permissions = JsonObject;

export interface CreateSessionRequest {
  permissions: Permissions;
  metadata?: unknown;
  expires_in?: number;
}

export interface SessionRecord {
  session_id: string;
  token?: string;
  permissions: Permissions;
  metadata?: unknown;
  expires_at: string;
  created_at: string;
  last_used_at?: string | null;
}

export interface RevokeAllResponse {
  revoked_count: number;
}

export interface CreateServiceKeyRequest {
  name?: string | null;
  description?: string | null;
  permissions: Permissions;
  metadata?: unknown;
  expires_in?: number | null;
}

export interface UpdateServiceKeyRequest {
  metadata?: unknown;
}

export interface ServiceKeyRecord {
  service_key_id: string;
  name?: string | null;
  description?: string | null;
  token?: string;
  permissions: Permissions;
  metadata?: unknown;
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
  last_used_at?: string | null;
}

export interface RevokeAllServiceKeysResponse {
  revoked_count: number;
}

export interface FileRecord {
  file_id: string;
  path: string;
  size: number;
  etag?: string | null;
  content_type?: string | null;
  storage_backend: string;
  created_by_run_id?: string | null;
  updated_by_run_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileListQuery extends ListQuery {
  prefix?: string;
}

export interface InitiateUploadRequest {
  path: string;
  expected_size?: number | null;
  content_type?: string | null;
}

export interface InitiateUploadResponse {
  upload_id: string;
  path: string;
  part_size: number;
  parts_expected?: number | null;
  expires_at: string;
}

export interface UploadPartResponse {
  part_number: number;
  size: number;
  etag: string;
}

export interface DomainRecord {
  domain_id: string;
  env_id: string;
  domain: string;
  status: string;
  dns_records: DnsRecord[];
  routing_domain?: string | null;
  created_at: string;
  verified_at?: string | null;
  tls_provisioned_at?: string | null;
  provisioning_error?: string | null;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: string;
}

export interface CreateDomainRequest {
  domain: string;
}

export interface DomainVerifyResponse {
  domain_id: string;
  domain: string;
  status: string;
  message: string;
}

export type ReplyMode = "response" | "queued" | "callback" | "stream";

export interface AgentAttachment {
  name: string;
  type: string;
  size: number;
  data?: string;
  text?: string;
}

export interface AgentEventDataInput {
  session_id: string;
  user_id: string;
  user_name?: string;
  message_id?: string;
  timestamp?: number;
  attachments?: AgentAttachment[];
  metadata?: Record<string, unknown>;
  /** Command-specific fields merged into event_data. */
  payload?: Record<string, unknown>;
}

export interface WebhookMessage {
  session_id: string;
  user_id: string;
  user_name?: string;
  text: string;
  message_id?: string;
  reply_mode?: ReplyMode;
  callback_url?: string | null;
  attachments?: AgentAttachment[];
  metadata?: Record<string, unknown>;
}

export interface WebhookResponse {
  ok?: boolean;
  status?: "response" | "queued" | "error";
  text?: string;
  reply_mode?: ReplyMode;
  session_id?: string;
  user_id?: string;
  message_id?: string;
  queued?: boolean;
  error?: string;
}
