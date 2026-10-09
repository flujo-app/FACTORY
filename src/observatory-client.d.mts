/** Fields checked by the Observatory reader before a snapshot is returned. */
export interface FactoryObservatoryCell {
  id: string;
  parentId: string | null;
  depth: number;
  status: 'reserved' | 'ready' | 'retired';
  [field: string]: unknown;
}

export interface FactoryObservatoryEnvelope {
  schemaVersion: 1;
  factoryId: string;
  scope: 'local-coordinator';
  observedAt: string;
  revision: number;
  cursor: string;
  capabilities: { snapshot: true; events: true; commands: false };
}

export interface FactoryObservatorySnapshot extends FactoryObservatoryEnvelope {
  snapshot: {
    control: { mission: string; status: 'active' | 'paused'; [field: string]: unknown };
    cells: FactoryObservatoryCell[];
    tasks: unknown[];
    effects: unknown[];
    budget: unknown;
    [field: string]: unknown;
  };
}

export interface FactoryObservatoryEvent {
  seq: number;
  type: string;
  subject: string;
  observedAt: string;
  [field: string]: unknown;
}

export interface FactoryObservatoryEvents extends FactoryObservatoryEnvelope {
  events: FactoryObservatoryEvent[];
  latestCursor: string;
  hasMore: boolean;
}

export interface FactoryObservatoryClient {
  snapshot(): Promise<FactoryObservatorySnapshot>;
  events(options: { after: string; limit?: number }): Promise<FactoryObservatoryEvents>;
}

export function createObservatoryClient(options: {
  snapshotUrl: string;
  token: string;
  expectedFactoryId: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): FactoryObservatoryClient;
