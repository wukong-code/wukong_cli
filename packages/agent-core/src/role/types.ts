export type RoleSource = 'builtin' | 'user' | 'project';
export type RoleCapabilityMode = 'read-only' | 'read-write' | 'execute' | 'all';

export interface RoleContractField {
  readonly name: string;
  readonly type?: string;
  readonly schema?: string;
  readonly required: boolean;
}

export interface RoleDefinition {
  readonly name: string;
  readonly selection: string;
  readonly source: RoleSource;
  readonly description: string;
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly verifyProfile?: string | undefined;
  readonly capabilityMode?: RoleCapabilityMode | undefined;
  readonly inputs?: readonly RoleContractField[] | undefined;
  readonly outputs?: readonly RoleContractField[] | undefined;
  readonly path?: string | undefined;
}

export type RoleSummary = Omit<RoleDefinition, 'prompt'>;

export interface RoleCatalogOptions {
  readonly cwd: string;
  readonly wukongHomeDir?: string | undefined;
}

export interface ActiveRole {
  readonly active: boolean;
  readonly role?: RoleSummary | undefined;
  readonly model?: string | undefined;
}
