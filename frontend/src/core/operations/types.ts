export type OperationsRange = 1 | 7 | 30 | 90;

export interface NamedMetric {
  name: string;
  value: number;
}

export interface OperationsSeries {
  labels: string[];
  registered_users: number[];
  guest_users: number[];
  login_registered: number[];
  login_guest: number[];
  sessions_registered: number[];
  sessions_guest: number[];
  token_input: number[];
  token_output: number[];
  token_total: number[];
  token_cost: number[];
  tool_calls: number[];
  skill_activations: number[];
  active_users: number[];
}

export interface OperationsTotals {
  registered_users: number;
  guest_users: number;
  total_users: number;
  active_users: number;
  total_logins: number;
  total_sessions: number;
  total_threads: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number | null;
  currency: string | null;
  total_tool_calls: number;
  total_tools: number;
  total_skill_activations: number;
  configured_models: number;
  feedback_total: number;
}

export interface OperationsDashboard {
  meta: {
    now: string;
    data_until: string;
    local_date: string;
    tz_offset_minutes: number;
  };
  range: OperationsRange;
  totals: OperationsTotals;
  series: OperationsSeries;
  top_users_login: NamedMetric[];
  top_users_sessions: NamedMetric[];
  top_users_tokens: NamedMetric[];
  top_agents: NamedMetric[];
  top_tools: NamedMetric[];
  top_skills: NamedMetric[];
  models: NamedMetric[];
  comparisons: Record<string, number | null>;
  sources: Record<string, string>;
}

export interface OperationsDashboardDetails {
  total_artifacts: number;
  artifacts_by_type: Record<string, number>;
  total_skills: number;
  public_skills: number;
  user_skills: number;
  total_agents: number;
  mcp_total: number;
  mcp_enabled: number;
  uploads_total: number;
  uploads_size: number;
  knowledge_bases_total: number;
  knowledge_documents_total: number;
  comparisons: Record<string, number | null>;
  sources: Record<string, string>;
}
