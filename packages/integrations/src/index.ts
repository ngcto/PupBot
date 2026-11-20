/**
 * Connectors (Composio toolkits) and the skills catalogue live here from P3.
 * The shell keeps the boundary honest: routes and components talk to this
 * interface, never to a provider SDK.
 */
export interface ConnectorDescriptor {
  toolkit: string;
  name: string;
  description?: string;
  category?: string;
  website?: string;
}

export interface ConnectorProvider {
  readonly name: string;
  listToolkits(query?: string): Promise<ConnectorDescriptor[]>;
  connect(workspaceId: string, toolkit: string): Promise<{ redirectUrl: string }>;
  disconnect(workspaceId: string, toolkit: string): Promise<void>;
}

export const integrations: ConnectorProvider[] = [];
