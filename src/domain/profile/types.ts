import type { JsonObject, JsonValue } from '../shared/json.js';

export interface ProfileRevision {
  id: number;
  profileId: number;
  revision: number;
  schemaVersion: number;
  candidate: JsonObject;
  preferences: JsonObject;
  source: string;
  sourceDigest: string;
  createdAt: string;
}

export interface Profile {
  id: number;
  userId: number;
  name: string;
  activeRevisionId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileClaimInput {
  category: string;
  key: string;
  value: JsonValue;
  sourcePath?: string;
  sensitive?: boolean;
  userConfirmed?: boolean;
}

export interface ProfileClaim extends Required<Omit<ProfileClaimInput, 'sourcePath'>> {
  id: number;
  revisionId: number;
  sourcePath: string | null;
}

export interface CreateProfileRevisionInput {
  userId: number;
  name?: string;
  schemaVersion?: number;
  candidate: JsonObject;
  preferences: JsonObject;
  source: 'editor' | 'import' | 'system';
  claims?: ProfileClaimInput[];
}
