export interface AgentModelSettings {
  temperature?: number | null;
  max_tokens?: number | null;
}

export type ReasoningEffort = "low" | "medium" | "high";

export interface SubAgentInfo {
  displayName: string;
  name: string;
  tools: string[];
  prompt: string;
}

export type AgentWelcomeSuggestionIcon =
  | "sparkles"
  | "pen"
  | "microscope"
  | "shapes"
  | "graduation-cap"
  | "lightbulb";

export interface AgentWelcomeSuggestion {
  label: string;
  prompt: string;
  icon: AgentWelcomeSuggestionIcon;
}

export interface Agent {
  name: string;
  display_name?: string | null;
  description: string;
  model: string | null;
  tool_groups: string[] | null;
  skills: string[] | null;
  mcp_servers?: string[] | null;
  allowed_subagents?: string[] | null;
  model_settings?: AgentModelSettings | null;
  thinking_enabled?: boolean | null;
  reasoning_effort?: ReasoningEffort | null;
  category?: string | null;
  welcome_suggestions?: AgentWelcomeSuggestion[] | null;
  soul?: string | null;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  model?: string | null;
  tool_groups?: string[] | null;
  skills?: string[] | null;
  mcp_servers?: string[] | null;
  allowed_subagents?: string[] | null;
  model_settings?: AgentModelSettings | null;
  thinking_enabled?: boolean | null;
  reasoning_effort?: ReasoningEffort | null;
  category?: string | null;
  soul?: string;
}

export interface UpdateAgentRequest {
  description?: string | null;
  model?: string | null;
  tool_groups?: string[] | null;
  skills?: string[] | null;
  mcp_servers?: string[] | null;
  allowed_subagents?: string[] | null;
  model_settings?: AgentModelSettings | null;
  thinking_enabled?: boolean | null;
  reasoning_effort?: ReasoningEffort | null;
  category?: string | null;
  scope?: "user" | "platform" | null;
  welcome_suggestions?: AgentWelcomeSuggestion[] | null;
  soul?: string | null;
}
