export interface Material {
  id: string;
  thread_id: string;
  thread_title: string;
  path: string;
  name: string;
  type: string;
  mime_type: string;
  size: number;
  updated_by: string;
  updated_at?: string;
  favorite: boolean;
  status: "ready" | "missing";
  run_id: string;
  preview_url?: string;
}

export interface MaterialsResponse {
  items: Material[];
  total: number;
}
export interface MaterialCapabilities {
  admin: boolean;
  configured: boolean;
  enabled: boolean;
  can_upload: boolean;
  available: boolean;
  servers: string[];
  knowledge_base_id: string;
}
