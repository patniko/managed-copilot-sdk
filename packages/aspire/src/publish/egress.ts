/**
 * The egress proxy for isolated sessions on Azure (platform/egress in its "external" mode, owned by the network
 * workstream). It runs in an internal Container Apps environment on the platform network's `egress` subnet, published on
 * that environment's internal load balancer (TCP 3128): sandboxes reach it only through their VNet connection, with a
 * transport rule that allows nothing else (measured in deploy/azure/qualify). The proxy connects to the gateway's
 * egress hub over HTTPS with the shared egress key and enforces each sandbox's network policy and vault credentials.
 *
 * Its CA lives in a dedicated NFS subdirectory shared across revisions. A root-only init container sets directory
 * ownership; the proxy itself stays non-root. Atomic first-creation in platform/egress makes concurrent revisions
 * use the same CA instead of invalidating running sandboxes' TLS trust.
 */
export const EGRESS_BICEP = `@description('The location for the resource(s) to be deployed.')
param location string = resourceGroup().location

@description('The egress subnet (delegated to Microsoft.App/environments).')
param subnetId string

@description('The platform NFS storage account; the proxy mounts only the egress subdirectory of its share.')
param storageAccountName string

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

resource caStorage 'Microsoft.App/managedEnvironments/storages@2025-07-01' = {
  parent: environment
  name: 'egress-ca'
  properties: {
    nfsAzureFile: {
      server: '\${storageAccountName}.file.\${az.environment().suffixes.storage}'
      shareName: '/\${storageAccountName}/managed-copilot'
      accessMode: 'ReadWrite'
    }
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
      initContainers: [
        {
          name: 'prepare-ca-directory'
          image: 'node:24-alpine'
          command: [
            'sh'
            '-ec'
            'chown 1000:1000 /var/lib/managed-copilot-egress && chmod 700 /var/lib/managed-copilot-egress'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          volumeMounts: [
            {
              volumeName: 'ca'
              mountPath: '/var/lib/managed-copilot-egress'
              subPath: 'egress'
            }
          ]
        }
      ]
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
            {
              name: 'EGRESS_DATA_DIR'
              value: '/var/lib/managed-copilot-egress'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'ca'
              mountPath: '/var/lib/managed-copilot-egress'
              subPath: 'egress'
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
      volumes: [
        {
          name: 'ca'
          storageType: 'NfsAzureFile'
          storageName: caStorage.name
        }
      ]
    }
  }
  dependsOn: [
    caStorage
  ]
}

@description('Where sandboxes reach the proxy: the internal load balancer of its environment.')
output proxyAddress string = '\${environment.properties.staticIp}:3128'
`;
