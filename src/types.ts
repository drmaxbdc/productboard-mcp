export interface PaginatedResponse<T> {
  data: T[];
  links?: {
    next?: string;
  };
  pageCursor?: string;
  totalResults?: number;
}

export interface Entity {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  links?: {
    self?: string;
    html?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface EntityConfiguration {
  type: string;
  fields: FieldConfiguration[];
}

export interface FieldConfiguration {
  key: string;
  type: string;
  label?: string;
  description?: string;
  required?: boolean;
  readOnly?: boolean;
  options?: Array<{ id: string; label: string }>;
}

export interface Relationship {
  id: string;
  type: string;
  source: { id: string; type: string };
  target: { id: string; type: string };
}

export interface Note {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface NoteConfiguration {
  type: string;
  fields: FieldConfiguration[];
}

export interface ApiError {
  status: number;
  message: string;
  details?: unknown;
}

export interface PatchOperation {
  op: "set" | "addItems" | "removeItems" | "clear";
  field: string;
  value?: unknown;
}

export interface SearchFilter {
  field: string;
  operator: string;
  value: unknown;
}

export interface MemberActivity {
  memberId: string;
  activity: Record<string, unknown>;
}
