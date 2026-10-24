/**
 * The egress proxy for isolated sessions on Azure (platform/egress in its "external" mode, owned by the network
 * workstream). It runs in an internal Container Apps environment on the platform network's `egress` subnet, published on
 * that environment's internal load balancer (TCP 3128): sandboxes reach it only through their VNet connection, with a
 * transport rule that allows nothing else (measured in deploy/azure/qualify). The proxy connects to the gateway's
 * egress hub over HTTPS with the shared egress key and enforces each sandbox's network policy and vault credentials.
 *
 * Its CA is generated per proxy start (the image runs as `node`, which cannot own a directory on the NFS share): after a
 * proxy restart, running sandboxes that use vault credentials need a restart to trust the new CA.
 */
export const EGRESS_BICEP = `@description('The location for the resource(s) to be deployed.')
param location string = resourceGroup().location

@description('The egress subnet (delegated to Microsoft.App/environments).')
param subnetId string

@description('Log Analytics workspace of the platform environment, for the proxy logs.')
param logAnalyticsWorkspaceName string

@description('Container registry login server and the identity that pulls from it.')
param registryServer string
param registryIdentityId string

@description('The egress proxy image.')
param image string

@description('The gateway URL the proxy links to.')
param gatewayUrl string

@secure()
@description('The gateway egress key (the gateway has the same value in MANAGED_COPILOT_EGRESS_KEY).')
param gatewayKey string

@description('Address ranges the proxy never connects to (the platform network).')
param protectedCidrs string

param tags object = {}

var suffix = uniqueString(resourceGroup().id)

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: take('mc-egress-\${suffix}', 32)
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: subnetId
    }
    workloadProfiles: [
      {
        name: 'consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource proxy 'Microsoft.App/containerApps@2025-07-01' = {
  name: 'egress'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '\${registryIdentityId}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [
        {
          name: 'gateway-key'
          value: gatewayKey
        }
      ]
      ingress: {
        external: true
        transport: 'tcp'
        targetPort: 3128
        exposedPort: 3128
      }
      registries: [
        {
          server: registryServer
          identity: registryIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'egress'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'EGRESS_GATEWAY_URL'
              value: gatewayUrl
            }
            {
              name: 'EGRESS_GATEWAY_KEY'
              secretRef: 'gateway-key'
            }
            {
              name: 'EGRESS_PROTECTED_CIDRS'
              value: protectedCidrs
            }
          ]
          probes: [
            {
              type: 'Liveness'
              tcpSocket: {
                port: 3128
              }
              periodSeconds: 15
              failureThreshold: 4
            }
            {
              type: 'Readiness'
              tcpSocket: {
                port: 3128
              }
              periodSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

@description('Where sandboxes reach the proxy: the internal load balancer of its environment.')
output proxyAddress string = '\${environment.properties.staticIp}:3128'
`;
