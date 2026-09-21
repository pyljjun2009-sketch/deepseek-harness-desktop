export type RuntimeChannel = "stable" | "preview";
export type RuntimeSource = "bundled" | "managed";
export type HarnessStatus =
  | "starting"
  | "online"
  | "stopping"
  | "stopped"
  | "recovering"
  | "updating"
  | "faulted";

export interface RuntimeRef {
  source: RuntimeSource;
  version: string;
  binPath: string;
}

export interface AvailableUpdate {
  current: string;
  latest: string;
  channel: RuntimeChannel;
  available: boolean;
  publishedAt?: string;
}

export interface HarnessSnapshot {
  status: HarnessStatus;
  message: string;
  activeVersion: string;
  activeSource: RuntimeSource;
  lastKnownGoodVersion: string;
  candidateVersion?: string;
  desktopVersion: string;
  profile: string;
  url?: string;
  startedAt?: string;
  uptimeSeconds: number;
  crashCount: number;
  rollbackCount: number;
  channel: RuntimeChannel;
  autoStart: boolean;
  tokenSavingEnabled: boolean;
  latestUpdate?: AvailableUpdate;
  logs: string[];
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

export interface DesktopApi {
  getSnapshot(): Promise<HarnessSnapshot>;
  start(): Promise<CommandResult>;
  stop(): Promise<CommandResult>;
  restart(): Promise<CommandResult>;
  openWorkbench(): Promise<CommandResult>;
  checkUpdates(): Promise<AvailableUpdate>;
  installUpdate(version: string): Promise<CommandResult>;
  setChannel(channel: RuntimeChannel): Promise<CommandResult>;
  setAutoStart(enabled: boolean): Promise<CommandResult>;
  setTokenSaving(enabled: boolean): Promise<CommandResult>;
  openLogs(): Promise<CommandResult>;
  subscribeSnapshot(listener: (snapshot: HarnessSnapshot) => void): void;
}
